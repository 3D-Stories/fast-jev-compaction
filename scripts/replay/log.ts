import { boundsLine, callSizes, inputBreakdown, inputLine } from '../../hooks/fast-jev.js';
import { DEFAULT_OPTIONS } from '../../src/compact.js';
import { collectToolCalls } from '../../src/state.js';
import type { CallAction, Message, ToolResult, ToolUse } from '../../src/types.js';

/** How Claude Code stores each `$.ui.log` line of the hook: a system notice with this prefix. */
const NOTICE_PREFIX = 'fast-jev-compaction: ';

/** The text Claude Code adds to a tool result that holds `tool_reference` blocks, while its turn is in progress. */
const TOOL_LOADED = 'Tool loaded.';

/** The hook's lines for one compaction, as it logged them. */
export type Notices = {
  input?: string;
  bounds?: string;
  /** `decisions: …` or its `decisions (i/N): …` parts, in order. */
  decisions: string[];
  /** The closing `kept …` or `fallback …` line. */
  final?: string;
  /** When the `input:` line was logged. */
  at?: string;
};

/** One compaction point: the window the hook was handed, rebuilt from the log, and what the hook logged. */
export type Point = {
  file: string;
  session: string;
  uuid: string;
  /** The boundary's position among the boundaries of its log. */
  index: number;
  at: string;
  day: string;
  version: string;
  trigger: string;
  window: Message[];
  notices?: Notices;
};

/**
 * A point at each `compact_boundary`, and the content of each assistant entry written after the newest
 * boundary (its text blocks and tool inputs), which is what a later reuse is looked for in.
 */
export type LogEvent = { kind: 'point'; point: Point } | { kind: 'later'; at: string; texts: string[] };

/** One logged decision, matched to the call it was about. */
export type LoggedDecision = {
  id: string;
  toolUseId: string;
  tool: string;
  action: CallAction;
  keepCall: number;
  keepResult: number;
  input: number;
  output: number;
};

/** Why a point is not used. These names reach the report, so they hold no log content. */
export type Reason = 'no-notice' | 'input-differs' | 'bounds-differs' | 'no-decisions' | 'decisions-differ' | 'record-differs';

export type Validation = { ok: true; decisions: Map<string, LoggedDecision> } | { ok: false; reason: Reason };

type Entry = Record<string, unknown>;

/** A user or assistant entry of the window being read. */
type Held = {
  uuid: string;
  message: Message;
  /** Claude Code stamps `promptId` on user entries only. */
  prompt?: string;
  summary: boolean;
  toolReference: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Entry types that never matter here; their lines, the request blobs above all, are skipped unparsed. */
const SKIPPED_TYPES = new Set(['api-request', 'api-request-blob', 'api-request-shape', 'progress', 'file-history-snapshot', 'file-history-delta']);

function parseLine(line: string): Entry | undefined {
  if (line.startsWith('{"type":"')) {
    const type = line.slice(9, line.indexOf('"', 9));
    if (SKIPPED_TYPES.has(type)) return undefined;
  }
  try {
    const value = JSON.parse(line) as unknown;
    return isObject(value) ? value : undefined;
  } catch {
    // A line that does not parse is skipped, as the hook skips it.
    return undefined;
  }
}

/** A tool result's text: its text blocks joined, or the string itself. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } => isObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** One message per entry, in `SessionMessage`'s shape, before tool outcomes are mirrored onto the calls. */
function hold(entry: Entry): Held {
  const role = entry.type === 'assistant' ? 'assistant' : 'user';
  const content = isObject(entry.message) ? entry.message.content : undefined;
  const texts: string[] = [];
  const toolUses: ToolUse[] = [];
  const toolResults: ToolResult[] = [];
  let toolReference = false;
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      else if (block.type === 'tool_use' && role === 'assistant') {
        const input = isObject(block.input) ? block.input : {};
        toolUses.push({ tool_use_id: str(block.id), tool: str(block.name), input });
      } else if (block.type === 'tool_result' && role === 'user') {
        toolResults.push({ tool_use_id: str(block.tool_use_id), text: resultText(block.content), isError: block.is_error === true });
        if (Array.isArray(block.content) && block.content.some((part) => isObject(part) && part.type === 'tool_reference')) {
          toolReference = true;
        }
      }
    }
  }
  const message: Message = { role, text: texts.join('\n'), toolUses };
  if (toolResults.length > 0) message.toolResults = toolResults;
  const held: Held = { uuid: str(entry.uuid), message, summary: entry.isCompactSummary === true, toolReference };
  if (typeof entry.promptId === 'string') held.prompt = entry.promptId;
  return held;
}

/** The `/compact` command a person typed; it starts a manual compaction and is not in the window it compacts. */
function isCompactCommand(held: Held): boolean {
  const { message } = held;
  return (
    message.role === 'user' &&
    message.toolUses.length === 0 &&
    !message.toolResults &&
    (message.text === '/compact' || message.text.startsWith('/compact '))
  );
}

/**
 * The window as `SessionMessage`s: fresh objects (the entries stay untouched for a later window), each
 * tool use mirroring its result's text and error flag as Claude Code attaches them. While a turn is in
 * progress (the newest entry is a user entry: a tool result or a prompt), the tool_reference results of
 * that turn carry Claude Code's "Tool loaded." text; the log does not hold it. Measured on this host: the
 * rule reproduces the logged user text in 327 of 332 windows that hold such a result.
 */
function windowOf(held: readonly Held[]): Message[] {
  const turn = held[held.length - 1]?.prompt;
  const messages = held.map(({ message, prompt, toolReference }): Message => {
    const copy: Message = { role: message.role, text: message.text, toolUses: message.toolUses.map((tool) => ({ ...tool })) };
    if (message.toolResults) copy.toolResults = message.toolResults.map((result) => ({ ...result }));
    if (toolReference && turn !== undefined && prompt === turn && copy.text === '') copy.text = TOOL_LOADED;
    return copy;
  });
  const outcomes = new Map<string, ToolResult>();
  for (const message of messages) for (const result of message.toolResults ?? []) outcomes.set(result.tool_use_id, result);
  for (const message of messages) {
    for (const tool of message.toolUses) {
      const outcome = outcomes.get(tool.tool_use_id);
      if (!outcome) continue;
      tool.text = outcome.text;
      if (outcome.isError) tool.isError = true;
    }
  }
  return messages;
}

type Line = { text: string; at: string };

const PART = /^\((\d+)\/(\d+)\) /;

/** `joinParts` over lines with their times; a joined line takes the time of its first part. */
function joinLines(lines: readonly Line[]): Line[] {
  const out: Line[] = [];
  let run: { chunks: string[]; raw: Line[]; count: number } | undefined;
  for (const line of lines) {
    const match = PART.exec(line.text);
    if (match) {
      const part = Number(match[1]);
      const count = Number(match[2]);
      if (part === 1) {
        if (run) out.push(...run.raw);
        run = { chunks: [], raw: [], count };
      }
      if (run && part === run.chunks.length + 1 && count === run.count) {
        run.chunks.push(line.text.slice(match[0].length));
        run.raw.push(line);
        if (part === count) {
          out.push({ text: run.chunks.join(''), at: run.raw[0]!.at });
          run = undefined;
        }
        continue;
      }
    }
    // A run cut short stays as the lines it was.
    if (run) out.push(...run.raw);
    run = undefined;
    out.push(line);
  }
  if (run) out.push(...run.raw);
  return out;
}

/** Joins the `(i/N) <chunk>` parts the hook cuts a long line into (`logLines`); other lines pass as they are. */
export function joinParts(texts: readonly string[]): string[] {
  return joinLines(texts.map((text) => ({ text, at: '' }))).map((line) => line.text);
}

const FINAL = /^(kept \d+\/\d+ messages, no summary|fallback to built-in summary)/;

/**
 * The hook's lines for the compaction at a boundary. A subagent's compaction logs into the same session
 * log, so the lines are grouped at each `input:` line, and the main conversation's group is the last one
 * with a `context:` line, which the hook logs for the main conversation only.
 */
function noticesOf(lines: readonly Line[]): Notices | undefined {
  const groups: Line[][] = [];
  for (const line of joinLines(lines)) {
    if (line.text.startsWith('input: ')) groups.push([line]);
    else groups[groups.length - 1]?.push(line);
  }
  const main = groups.filter((group) => group.some((line) => line.text.startsWith('context: ')));
  const group = main[main.length - 1] ?? groups[groups.length - 1];
  if (!group) return undefined;
  const notices: Notices = { input: group[0]!.text, at: group[0]!.at, decisions: [] };
  for (const { text } of group) {
    if (text.startsWith('bounds: ') && notices.bounds === undefined) notices.bounds = text;
    else if (text.startsWith('decisions: ') || /^decisions \(\d+\/\d+\): /.test(text)) notices.decisions.push(text);
    else if (FINAL.test(text)) notices.final = text;
  }
  return notices;
}

/** Reads a session log line by line, in file order, and rebuilds the window at each boundary. */
export class LogReader {
  private held: Held[] = [];
  private notices: Line[] = [];
  /** Messages the previous boundary kept by reference (`compactMetadata.preservedMessages`). */
  private preserved: Held[] = [];
  /** Copies a compaction writes again keep their old time; anything stamped later is new. */
  private lastBoundaryAt = '';
  private boundaries = 0;

  constructor(
    readonly file: string,
    readonly session: string,
  ) {}

  push(line: string): LogEvent[] {
    const entry = parseLine(line);
    if (!entry) return [];
    if (entry.type === 'system') {
      if (entry.subtype === 'compact_boundary') return [this.boundary(entry)];
      const content = str(entry.content);
      if (content.startsWith(NOTICE_PREFIX)) this.notices.push({ text: content.slice(NOTICE_PREFIX.length), at: str(entry.timestamp) });
      return [];
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') return [];
    // A subagent's messages and the engine's meta messages are not in the conversation the hook is handed.
    if (entry.isSidechain === true || entry.isMeta === true) return [];
    const held = hold(entry);
    this.held.push(held);
    const at = str(entry.timestamp);
    if (held.message.role !== 'assistant' || at <= this.lastBoundaryAt) return [];
    const texts = held.message.text ? [held.message.text] : [];
    for (const tool of held.message.toolUses) texts.push(JSON.stringify(tool.input));
    return texts.length > 0 ? [{ kind: 'later', at, texts }] : [];
  }

  private boundary(entry: Entry): LogEvent {
    const metadata = isObject(entry.compactMetadata) ? entry.compactMetadata : {};
    const trigger = str(metadata.trigger);
    let held = this.held;
    if (this.preserved.length > 0) {
      const present = new Set(held.map((item) => item.uuid));
      const kept = this.preserved.filter((item) => !present.has(item.uuid));
      const summary = held.findIndex((item) => item.summary);
      held = summary === -1 ? [...kept, ...held] : [...held.slice(0, summary + 1), ...kept, ...held.slice(summary + 1)];
    }
    if (trigger === 'manual' && held.length > 0 && isCompactCommand(held[held.length - 1]!)) held = held.slice(0, -1);
    const at = str(entry.timestamp);
    const point: Point = {
      file: this.file,
      session: this.session,
      uuid: str(entry.uuid),
      index: this.boundaries,
      at,
      day: at.slice(0, 10),
      version: str(entry.version),
      trigger,
      window: windowOf(held),
    };
    const notices = noticesOf(this.notices);
    if (notices) point.notices = notices;

    const listed = isObject(metadata.preservedMessages) ? metadata.preservedMessages : {};
    const ids = Array.isArray(listed.allUuids) ? listed.allUuids : Array.isArray(listed.uuids) ? listed.uuids : [];
    const byUuid = new Map(held.map((item) => [item.uuid, item]));
    this.preserved = ids.flatMap((id) => {
      const item = typeof id === 'string' ? byUuid.get(id) : undefined;
      return item ? [item] : [];
    });
    this.held = [];
    this.notices = [];
    this.lastBoundaryAt = at;
    this.boundaries += 1;
    return { kind: 'point', point };
  }
}

/** The events of one log, from any source of lines. */
export async function* logEvents(
  file: string,
  session: string,
  lines: AsyncIterable<string> | Iterable<string>,
): AsyncGenerator<LogEvent> {
  const reader = new LogReader(file, session);
  for await (const line of lines) yield* reader.push(line);
}

const DECISION_PART = /^decisions \((\d+)\/(\d+)\): /;
const DECISION_ENTRY = /^(t\d+):(.+):(keep|drop_result|drop_call)\/call=(\d+\.\d\d)\/result=(\d+\.\d\d)\/in=(\d+)\/out=(\d+)$/;

/** The logged decision entries, the parts joined; undefined when a part is missing or an entry does not parse. */
function parseDecisions(lines: readonly string[]): Omit<LoggedDecision, 'toolUseId'>[] | undefined {
  let body: string;
  if (lines.length === 1 && lines[0]!.startsWith('decisions: ')) body = lines[0]!.slice('decisions: '.length);
  else {
    const parts: string[] = [];
    for (const [index, line] of lines.entries()) {
      const match = DECISION_PART.exec(line);
      if (!match || Number(match[1]) !== index + 1 || Number(match[2]) !== lines.length) return undefined;
      parts.push(line.slice(match[0].length));
    }
    // The hook packs whole entries a space apart and drops the space where one part ends.
    body = parts.join(' ');
  }
  if (body === '(none)') return [];
  const entries: Omit<LoggedDecision, 'toolUseId'>[] = [];
  for (const text of body.split(' ')) {
    const match = DECISION_ENTRY.exec(text);
    if (!match) return undefined;
    entries.push({
      id: match[1]!,
      tool: match[2]!,
      action: match[3] as CallAction,
      keepCall: Number(match[4]),
      keepResult: Number(match[5]),
      input: Number(match[6]),
      output: Number(match[7]),
    });
  }
  return entries;
}

/**
 * Whether a point can be replayed: the rebuilt window gives the hook's logged `input:` and `bounds:` lines
 * char for char (the functions the hook ran, at its default of 6 preserved messages), its logged decisions
 * cover exactly the calls `collectToolCalls` numbers in the window, with the same tool and sizes, and its
 * compaction record, when there is one, agrees with the log.
 */
export function validate(point: Point, record?: { messagesIn: number; detail: string }): Validation {
  const notices = point.notices;
  if (!notices?.input) return { ok: false, reason: 'no-notice' };
  if (inputLine(inputBreakdown(point.window)) !== notices.input) return { ok: false, reason: 'input-differs' };
  const preserve = DEFAULT_OPTIONS.preserveRecentMessages;
  if (boundsLine(point.window, preserve) !== notices.bounds) return { ok: false, reason: 'bounds-differs' };
  if (notices.decisions.length === 0) return { ok: false, reason: 'no-decisions' };
  const entries = parseDecisions(notices.decisions);
  const calls = collectToolCalls(point.window, preserve).filter((call) => !call.pinned);
  const sizes = callSizes(point.window, preserve);
  if (!entries || entries.length !== calls.length) return { ok: false, reason: 'decisions-differ' };
  const decisions = new Map<string, LoggedDecision>();
  for (const [index, call] of calls.entries()) {
    const entry = entries[index]!;
    const size = sizes.get(call.id);
    if (entry.id !== call.id || entry.tool !== call.tool || entry.input !== size?.input || entry.output !== size.output) {
      return { ok: false, reason: 'decisions-differ' };
    }
    decisions.set(call.id, { ...entry, toolUseId: call.tool_use_id });
  }
  if (record && (record.messagesIn !== point.window.length || record.detail !== notices.final)) {
    return { ok: false, reason: 'record-differs' };
  }
  return { ok: true, decisions };
}
