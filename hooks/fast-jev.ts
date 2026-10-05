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
  uuid?: string;
  parentUuid?: string | null;
  isMeta?: boolean;
  message?: { content?: unknown };
  attachment?: { type?: string; commandMode?: string; isMeta?: boolean; origin?: { kind?: string } };
};

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

function parseLine(line: string): LogEntry | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === 'object' && value !== null ? (value as LogEntry) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Follows each typed message's `parentUuid` chain, through other attachments, to
 * the tool result it rides on. There is no step limit: the walk ends at a tool
 * result, a missing parent, a message that is not an attachment, or a parent it
 * has already seen.
 */
function carrierIds(notes: readonly LogEntry[], entries: ReadonlyMap<string, LogEntry>): Set<string> {
  const ids = new Set<string>();
  for (const note of notes) {
    const seen = new Set<string>();
    let uuid = note.parentUuid ?? undefined;
    while (uuid && !seen.has(uuid)) {
      seen.add(uuid);
      const parent = entries.get(uuid);
      if (!parent) break;
      const found = toolResultIds(parent);
      if (found.length > 0) {
        for (const id of found) ids.add(id);
        break;
      }
      if (parent.type !== 'attachment') break;
      uuid = parent.parentUuid ?? undefined;
    }
  }
  return ids;
}

/**
 * The tool calls whose result carries a message someone typed while the tool
 * ran. Claude Code delivers such a message as a `queued_command` attachment on
 * the tool-result message, not in its text, so the session messages a hook sees
 * do not show it: dropping or rebuilding that message loses it. Reads the
 * session log (JSON lines) and returns those calls' tool_use_ids.
 */
export function queuedPromptToolUseIds(log: string): Set<string> {
  const entries = new Map<string, LogEntry>();
  const notes: LogEntry[] = [];
  for (const line of log.split('\n')) {
    if (!line.includes('"tool_result"') && !line.includes('"attachment"')) continue;
    const entry = parseLine(line);
    if (!entry) continue;
    if (entry.uuid) entries.set(entry.uuid, entry);
    if (typedByPerson(entry)) notes.push(entry);
  }
  return carrierIds(notes, entries);
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
 * partial answer: grep's exit 1 means no match only when it printed nothing,
 * output that does not end in a newline was cut at the process output limit,
 * and a printed line that is not JSON was cut too.
 */
async function grepEntries($: ProcessAccess, path: string, patterns: readonly string[]): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  for (let i = 0; i < patterns.length; i += 200) {
    const argv = ['grep', '-E', ...patterns.slice(i, i + 200).flatMap((pattern) => ['-e', pattern]), '--', path];
    const { exitCode, stdout, stderr } = await $.process.run(argv, { timeoutMs: 60_000 });
    if (exitCode > 1 || (exitCode === 1 && stdout !== '')) {
      throw new Error(`grep exited ${exitCode}: ${stderr.trim().slice(0, 200)}`);
    }
    if (stdout !== '' && !stdout.endsWith('\n')) throw new Error('grep output was cut at the output limit');
    for (const line of stdout.split('\n')) {
      if (line === '') continue;
      const entry = parseLine(line);
      if (!entry) throw new Error('grep printed a line that is not JSON');
      entries.push(entry);
    }
  }
  return entries;
}

/** A uuid as Claude Code writes them; anything else is never put into a grep pattern. */
const PLAIN_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The same answer as `queuedPromptToolUseIds`, for a log too large to read
 * whole: grep finds the typed messages, then fetches each step of their parent
 * chains by uuid until every chain ends.
 */
export async function queuedPromptToolUseIdsByGrep($: ProcessAccess, path: string): Promise<Set<string>> {
  const notes = (await grepEntries($, path, ['"queued_command"'])).filter(typedByPerson);
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
  return carrierIds(notes, entries);
}

/**
 * Every call answered in a message that carries a typed message, so that whole
 * message stays the engine's own object, attachment included.
 */
export function pinnedForQueuedPrompts(
  messages: readonly SessionMessage[],
  noted: ReadonlySet<string>,
): string[] {
  const pinned: string[] = [];
  for (const message of messages) {
    const results = message.toolResults ?? [];
    if (!results.some((result) => noted.has(result.tool_use_id))) continue;
    for (const result of results) pinned.push(result.tool_use_id);
  }
  return pinned;
}

/** Characters of tool output the named calls hold. */
function resultChars(messages: readonly SessionMessage[], ids: readonly string[]): number {
  const named = new Set(ids);
  let chars = 0;
  for (const message of messages) {
    for (const result of message.toolResults ?? []) if (named.has(result.tool_use_id)) chars += result.text.length;
  }
  return chars;
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
 * The calls in this session's log that carry a typed message. A log up to 4 MiB
 * is read whole; a larger one is scanned with grep. `problem` says why nothing
 * could be found.
 */
async function typedMessageCarriers(
  $: SessionLogAccess,
): Promise<{ ids?: Set<string>; problem?: string; note?: string }> {
  const { path, note } = await locateSessionLog($);
  if (!path) return { problem: 'could not find the session log' };
  const { size } = await $.fs.stat(path);
  const ids =
    size <= FS_READ_LIMIT ? queuedPromptToolUseIds(await $.fs.read(path)) : await queuedPromptToolUseIdsByGrep($, path);
  return { ids, note };
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
      let typedPins = 0;
      let typedChars = 0;
      if (!event.agentId) {
        try {
          const { ids, problem, note } = await typedMessageCarriers($);
          if (note) $.ui.log(note);
          if (!ids) {
            $.ui.log(`${problem}; typed messages are not protected in this compaction`);
          } else {
            const pinned = pinnedForQueuedPrompts(event.messages, ids);
            if (pinned.length > 0) {
              config.pinToolUseIds = pinned;
              typedPins = pinned.length;
              typedChars = resultChars(event.messages, pinned);
              $.ui.log(`keeping ${pinned.length} tool call(s) that carry a message typed while they ran`);
            }
          }
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
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)}${
            typedPins > 0 ? `; kept for typed messages: ${typedPins} call(s), ${typedChars} chars` : ''
          })`,
        );
        return next(event);
      }
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
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
