import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

/**
 * Who a queued prompt came from, by the `origin.kind` Claude Code stamps on it in
 * the session log: the person at the terminal (`human`) or through Remote
 * Control (`bridge`). Every other kind (auto-continuations, subagent hand-backs,
 * schedules, observers, task notifications) is the engine's or another agent's.
 */
const PERSON_QUEUE_KINDS = new Set(['human', 'bridge']);

/** `$.fs.read` rejects a file over 4 MiB, so a larger log is scanned with grep. */
const FS_READ_LIMIT = 4 * 1024 * 1024;

type LogEntry = {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  isMeta?: boolean;
  message?: { content?: unknown };
  attachment?: {
    type?: string;
    commandMode?: string;
    isMeta?: boolean;
    origin?: { kind?: string };
    prompt?: unknown;
    source_uuid?: string;
    delivery_id?: string;
  };
  compactMetadata?: { preservedMessages?: { allUuids?: unknown } };
};

/** A message a person typed while a tool ran, and the call whose result carried it. */
export type TypedNote = { toolUseId: string; prompt: string };

function toolResultIds(entry: LogEntry): string[] {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (block): block is { type: 'tool_result'; tool_use_id: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'tool_result' &&
        typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string',
    )
    .map((block) => block.tool_use_id);
}

/**
 * Whether a log entry is a message a person typed while a tool ran: a
 * `queued_command` attachment in prompt mode whose origin is a person. A prompt
 * from before Claude Code stamped origins counts only when it is not marked meta.
 */
function typedByPerson(entry: LogEntry): boolean {
  const attachment = entry.attachment;
  if (entry.type !== 'attachment' || attachment?.type !== 'queued_command') return false;
  if ((attachment.commandMode ?? 'prompt') !== 'prompt') return false;
  const kind = attachment.origin?.kind;
  if (kind !== undefined) return PERSON_QUEUE_KINDS.has(kind);
  return !(entry.isMeta || attachment.isMeta);
}

function isBoundary(entry: LogEntry): boolean {
  return entry.type === 'system' && entry.subtype === 'compact_boundary';
}

/**
 * The typed messages the session still holds, from log entries in file order:
 * those written after its last compaction, and those that compaction kept by
 * reference. An earlier one was kept (and written again after the boundary),
 * put back as words, or summarized by that compaction.
 */
function stillHeld(ordered: readonly LogEntry[]): LogEntry[] {
  const last = ordered.findLastIndex(isBoundary);
  const kept = ordered[last]?.compactMetadata?.preservedMessages?.allUuids;
  const keptIds = new Set(Array.isArray(kept) ? kept.filter((id): id is string => typeof id === 'string') : []);
  return ordered.filter((entry, index) => typedByPerson(entry) && (index > last || (entry.uuid !== undefined && keptIds.has(entry.uuid))));
}

function parseLine(line: string): LogEntry | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === 'object' && value !== null ? (value as LogEntry) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The words of a typed message. A prompt sent with an image is a list of blocks:
 * its text blocks are kept, and each image is named as not kept.
 */
function promptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt;
  if (!Array.isArray(prompt)) return '';
  const blocks = prompt.filter((block): block is { type?: unknown; text?: unknown } => typeof block === 'object' && block !== null);
  const text = blocks
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
  const images = blocks.filter((block) => block.type === 'image').length;
  return images > 0 ? `${text} [${images} image${images === 1 ? '' : 's'} not kept]` : text;
}

/**
 * Follows each typed message's `parentUuid` chain, through other attachments, to
 * the tool result it rides on. There is no step limit: the walk ends at a tool
 * result, a missing parent, a message that is not an attachment, or a parent it
 * has already seen. A message with no words is skipped. A copy of a submission
 * (same `source_uuid`, which Claude Code keeps when it writes an attachment
 * again) is named once; two submissions with the same words are both kept.
 */
function carrierNotes(notes: readonly LogEntry[], entries: ReadonlyMap<string, LogEntry>): TypedNote[] {
  const found: TypedNote[] = [];
  const named = new Set<string>();
  for (const note of notes) {
    const prompt = promptText(note.attachment?.prompt);
    if (prompt.trim() === '') continue;
    const seen = new Set<string>();
    let uuid = note.parentUuid ?? undefined;
    while (uuid && !seen.has(uuid)) {
      seen.add(uuid);
      const parent = entries.get(uuid);
      if (!parent) break;
      const [toolUseId] = toolResultIds(parent);
      if (toolUseId !== undefined) {
        const key = note.attachment?.source_uuid ?? note.attachment?.delivery_id ?? note.uuid ?? `${toolUseId}\n${prompt}`;
        if (!named.has(key)) {
          named.add(key);
          found.push({ toolUseId, prompt });
        }
        break;
      }
      if (parent.type !== 'attachment') break;
      uuid = parent.parentUuid ?? undefined;
    }
  }
  return found;
}

/**
 * The messages someone typed while a tool ran, each with the call whose result
 * carried it. Claude Code delivers such a message as a `queued_command`
 * attachment on the tool-result message, not in its text, so the session
 * messages a hook sees do not show it: dropping or rebuilding that message loses
 * it. Reads the session log (JSON lines).
 */
export function typedNotes(log: string): TypedNote[] {
  const entries = new Map<string, LogEntry>();
  const ordered: LogEntry[] = [];
  for (const line of log.split('\n')) {
    if (!line.includes('"tool_result"') && !line.includes('"attachment"') && !line.includes('"compact_boundary"')) continue;
    const entry = parseLine(line);
    if (!entry) continue;
    if (entry.uuid) entries.set(entry.uuid, entry);
    if (typedByPerson(entry) || isBoundary(entry)) ordered.push(entry);
  }
  return carrierNotes(stillHeld(ordered), entries);
}

type ProcessAccess = {
  process: {
    run: (
      argv: readonly string[],
      init?: { timeoutMs?: number },
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
};

/**
 * The log lines matching any of `patterns` (extended regular expressions), found
 * by `grep -E`, so the log is never loaded whole. Throws rather than return a
 * partial answer. `grep -c` counts the matching lines first, and the full grep
 * must return at least that many: process output is cut at a limit, and a cut
 * at a line end would otherwise look complete. Exit 1 means no match only with
 * nothing printed; output that does not end in a newline, or a line that is not
 * JSON, was cut too.
 */
async function grepEntries($: ProcessAccess, path: string, patterns: readonly string[]): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  for (let i = 0; i < patterns.length; i += 200) {
    const expressions = patterns.slice(i, i + 200).flatMap((pattern) => ['-e', pattern]);
    const counted = await $.process.run(['grep', '-E', '-c', ...expressions, '--', path], { timeoutMs: 60_000 });
    const expected = Number(counted.stdout.trim());
    if (counted.exitCode > 1 || !/^\d+\n?$/.test(counted.stdout) || !Number.isSafeInteger(expected)) {
      throw new Error(`grep -c exited ${counted.exitCode}: ${counted.stderr.trim().slice(0, 200)}`);
    }
    if (expected === 0) continue;
    const { exitCode, stdout, stderr } = await $.process.run(['grep', '-E', ...expressions, '--', path], {
      timeoutMs: 60_000,
    });
    if (exitCode > 1 || (exitCode === 1 && stdout !== '')) {
      throw new Error(`grep exited ${exitCode}: ${stderr.trim().slice(0, 200)}`);
    }
    if (stdout !== '' && !stdout.endsWith('\n')) throw new Error('grep output was cut at the output limit');
    let returned = 0;
    for (const line of stdout.split('\n')) {
      if (line === '') continue;
      const entry = parseLine(line);
      if (!entry) throw new Error('grep printed a line that is not JSON');
      entries.push(entry);
      returned += 1;
    }
    if (returned < expected) throw new Error(`grep returned ${returned} of ${expected} matching lines (output cut)`);
  }
  return entries;
}

/** A uuid as Claude Code writes them; anything else is never put into a grep pattern. */
const PLAIN_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The same answer as `typedNotes`, for a log too large to read whole: grep finds
 * the typed messages, then fetches each step of their parent chains by uuid
 * until every chain ends.
 */
export async function typedNotesByGrep($: ProcessAccess, path: string): Promise<TypedNote[]> {
  const notes = stillHeld(await grepEntries($, path, ['"queued_command"', '"subtype": ?"compact_boundary"']));
  const entries = new Map<string, LogEntry>();
  const asked = new Set<string>();
  const plain = (uuid: string | null | undefined): uuid is string => !!uuid && PLAIN_ID.test(uuid);
  let wanted = new Set(notes.map((note) => note.parentUuid).filter(plain));
  while (wanted.size > 0) {
    for (const uuid of wanted) asked.add(uuid);
    for (const entry of await grepEntries($, path, [...wanted].map((uuid) => `"uuid": ?"${uuid}"`))) {
      if (entry.uuid && wanted.has(entry.uuid)) entries.set(entry.uuid, entry);
    }
    const next = new Set<string>();
    for (const uuid of wanted) {
      const entry = entries.get(uuid);
      if (!entry || toolResultIds(entry).length > 0 || entry.type !== 'attachment') continue;
      const parent = entry.parentUuid ?? undefined;
      if (plain(parent) && !asked.has(parent)) next.add(parent);
    }
    wanted = next;
  }
  return carrierNotes(notes, entries);
}

/** The user message that keeps a typed message once the call it arrived with is gone. */
export function typedWords(tool: string, prompt: string): string {
  return `[message typed while ${tool} ran]: ${prompt}`;
}

/**
 * Puts back, as a plain user message, each typed message whose carrier did not
 * come back as the engine's own object: a dropped or rebuilt tool-result message
 * loses its `queued_command` attachment. The words go where the carrier was,
 * after the last result of that turn (never between a call and its result), one
 * message per note, in order. A carrier the engine gets back keeps its
 * attachment, so its words are not added. A note an earlier compaction already
 * handled is not in `notes` (see `stillHeld`), so words are never put back twice.
 */
export function withTypedWords(
  input: readonly SessionMessage[],
  output: readonly SessionMessage[],
  notes: readonly TypedNote[],
): { messages: SessionMessage[]; added: number } {
  const at = alignment(input, output);
  const before = new Map<number, SessionMessage[]>();
  let added = 0;
  for (const note of notes) {
    const carrier = input.findIndex((message) =>
      (message.toolResults ?? []).some((result) => result.tool_use_id === note.toolUseId),
    );
    if (carrier < 0) continue;
    const kept = at.get(carrier);
    if (kept !== undefined && output[kept] === input[carrier]) continue;
    const tool = input.flatMap((message) => message.toolUses).find((use) => use.tool_use_id === note.toolUseId);
    let index = output.length;
    for (let i = carrier + 1; i < input.length; i++) {
      if ((input[i]!.toolResults ?? []).length > 0) continue;
      const found = at.get(i);
      if (found !== undefined) {
        index = found;
        break;
      }
    }
    const words: SessionMessage = { role: 'user', text: typedWords(tool?.tool ?? 'a tool', note.prompt), toolUses: [] };
    before.set(index, [...(before.get(index) ?? []), words]);
    added += 1;
  }
  if (added === 0) return { messages: [...output], added };
  const messages: SessionMessage[] = [];
  output.forEach((message, index) => messages.push(...(before.get(index) ?? []), message));
  messages.push(...(before.get(output.length) ?? []));
  return { messages, added };
}

function toolIds(message: SessionMessage): string[] {
  return [...message.toolUses.map((use) => use.tool_use_id), ...(message.toolResults ?? []).map((result) => result.tool_use_id)];
}

/**
 * Where each input message ended up in the output, by index. The library keeps
 * input order, so one pass pairs them: an output message is the next input
 * message itself, or that message rebuilt (same role and text, holding only
 * calls the input message held). A rebuilt message with no calls left has text,
 * since one with neither is removed.
 */
function alignment(input: readonly SessionMessage[], output: readonly SessionMessage[]): Map<number, number> {
  const at = new Map<number, number>();
  let next = 0;
  input.forEach((message, index) => {
    const candidate = output[next];
    if (!candidate) return;
    const own = new Set(toolIds(message));
    const theirs = toolIds(candidate);
    const rebuilt =
      candidate.role === message.role &&
      candidate.text === message.text &&
      theirs.every((id) => own.has(id)) &&
      (theirs.length > 0 || candidate.text.trim() !== '');
    if (candidate === message || rebuilt) {
      at.set(index, next);
      next += 1;
    }
  });
  return at;
}

/** The folder name Claude Code gives a project's session logs. */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

type SessionLogAccess = ProcessAccess & {
  env: { get: (name: string) => Promise<string | undefined> };
  session: { id: () => Promise<string>; cwd: () => Promise<string> };
  fs: {
    exists: (path: string) => Promise<boolean>;
    read: (path: string) => Promise<string>;
    stat: (path: string) => Promise<{ size: number; mtimeMs: number }>;
    list: (path?: string) => Promise<readonly { name: string; kind: string }[]>;
  };
};

/**
 * Where this session's log is. The project folder comes first; otherwise every
 * project folder is searched, and of several same-named logs the newest wins,
 * with a note that names how many there were.
 */
async function locateSessionLog($: SessionLogAccess): Promise<{ path?: string; note?: string }> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR');
  const home = await $.env.get('HOME');
  const root = configDir || (home ? `${home}/.claude` : undefined);
  if (!root) return {};
  const projects = `${root}/projects`;
  const file = `${await $.session.id()}.jsonl`;
  const direct = `${projects}/${projectDirName(await $.session.cwd())}/${file}`;
  if (await $.fs.exists(direct)) return { path: direct };
  const found: { path: string; mtimeMs: number }[] = [];
  for (const entry of await $.fs.list(projects)) {
    if (entry.kind !== 'dir') continue;
    const path = `${projects}/${entry.name}/${file}`;
    if (await $.fs.exists(path)) found.push({ path, mtimeMs: (await $.fs.stat(path)).mtimeMs });
  }
  if (found.length === 0) return {};
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = found[0]!.path;
  return {
    path: newest,
    note: found.length > 1 ? `${found.length} session logs named ${file}; using the newest, ${newest}` : undefined,
  };
}

/**
 * The typed messages in this session's log. A log up to 4 MiB is read whole; a
 * larger one is scanned with grep. `problem` says why nothing could be found.
 */
async function typedMessagesInLog(
  $: SessionLogAccess,
): Promise<{ notes?: TypedNote[]; problem?: string; note?: string }> {
  const { path, note } = await locateSessionLog($);
  if (!path) return { problem: 'could not find the session log' };
  const { size } = await $.fs.stat(path);
  const notes = size <= FS_READ_LIMIT ? typedNotes(await $.fs.read(path)) : await typedNotesByGrep($, path);
  return { notes, note };
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config.model), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const config: HookConfig = { ...configured, apiKey: await getApiKey($, configured) };
      let typed: TypedNote[] = [];
      if (!event.agentId) {
        try {
          const { notes, problem, note } = await typedMessagesInLog($);
          if (note) $.ui.log(note);
          if (!notes) $.ui.log(`${problem}; typed messages are not protected in this compaction`);
          else typed = notes;
        } catch (error) {
          $.ui.log(
            `could not read the session log (${error instanceof Error ? error.message : String(error)}); typed messages are not protected in this compaction`,
          );
        }
      }
      const { result, messages } = await compactSession(event.messages, config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      });
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      const words = withTypedWords(event.messages, messages, typed);
      if (words.added > 0) $.ui.log(`kept ${words.added} typed message(s) as text: the call each arrived with was dropped or cut`);
      notify(
        $,
        `kept ${words.messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages: words.messages };
    } catch (error) {
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
