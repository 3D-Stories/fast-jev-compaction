import { noulAnswer } from './request.js';
import { collectToolCalls, estimateTokens, fitState, isPinned } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
  minReduction: 0,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    minReduction: Math.min(1, Math.max(0, finite(options.minReduction, DEFAULT_OPTIONS.minReduction))),
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

/** Whether ending `text` at `index` would separate the two halves of a surrogate pair. */
function splitsSurrogatePair(text: string, index: number): boolean {
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  // End the head on a code point boundary: cutting a surrogate pair in half
  // would leave a lone surrogate in the rebuilt transcript.
  const cut = splitsSurrogatePair(text, headChars) ? headChars - 1 : headChars;
  const head = cut > 0 ? `${text.slice(0, cut)}\n` : '';
  return `${head}[fast-jev-compaction truncated ${text.length - cut} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
        );
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/** A string field shorter than this stays whole: cutting it saves too little. */
const SHORTEN_FIELD_MIN = 1500;
/** An assistant reply shorter than this stays whole. */
const SHORTEN_TEXT_MIN = 2000;

/** `text` as its first `head` chars, a note, and its last `tail` chars, never cut inside a surrogate pair. */
function shortenedText(text: string, head: number, tail: number, what: string): string {
  const headEnd = splitsSurrogatePair(text, head) ? head - 1 : head;
  const tailStart = text.length - tail;
  const tailFrom = tail > 0 && splitsSurrogatePair(text, tailStart) ? tailStart + 1 : tailStart;
  const note = `[fast-jev-compaction shortened ${tailFrom - headEnd} chars of this ${what}]`;
  return `${text.slice(0, headEnd)}\n${note}${tail > 0 ? `\n${text.slice(tailFrom)}` : ''}`;
}

/** A tool input with every long string in it, at any depth, shortened. Keys and short values are kept. */
function shortenedInput(value: unknown, head: number): unknown {
  if (typeof value === 'string') {
    return value.length > SHORTEN_FIELD_MIN ? shortenedText(value, head, 0, 'tool input') : value;
  }
  if (Array.isArray(value)) return value.map((item) => shortenedInput(item, head));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shortenedInput(item, head)]));
  }
  return value;
}

/** One cut that would remove `saved` chars: a tool input of a call whose result was dropped, or an old reply. */
type Cut =
  | { kind: 'input'; saved: number; message: number; tool: number; input: Record<string, unknown> }
  | { kind: 'text'; saved: number; message: number; text: string };

/**
 * Every cut the pass may make, biggest saving first within each kind, inputs before replies. Never a
 * pinned message, the first message, a message the user wrote, or the input of a call Jev kept or dropped.
 */
function shorteningCuts(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  options: ResolvedCompactOptions,
): Cut[] {
  const resultDropped = new Set(
    decisions.filter((decision) => decision.reason === 'result_dropped').map((decision) => decision.id),
  );
  const droppedIds = new Set(calls.filter((call) => resultDropped.has(call.id)).map((call) => call.tool_use_id));
  const head = options.truncateHeadChars;
  const inputs: Cut[] = [];
  const texts: Cut[] = [];
  messages.forEach((message, index) => {
    message.toolUses.forEach((tool, toolIndex) => {
      if (!droppedIds.has(tool.tool_use_id)) return;
      try {
        const input = shortenedInput(tool.input, head) as Record<string, unknown>;
        const saved = JSON.stringify(tool.input).length - JSON.stringify(input).length;
        if (saved > 0) inputs.push({ kind: 'input', saved, message: index, tool: toolIndex, input });
      } catch {
        // An input that cannot be walked or measured stays whole.
      }
    });
    if (
      message.role === 'assistant' &&
      message.text.length > SHORTEN_TEXT_MIN &&
      !isPinned(index, messages.length, options.preserveRecentMessages)
    ) {
      const text = shortenedText(message.text, head, head, 'reply');
      const saved = message.text.length - text.length;
      if (saved > 0) texts.push({ kind: 'text', saved, message: index, text });
    }
  });
  const biggest = (a: Cut, b: Cut) => b.saved - a.saved;
  return [...inputs.sort(biggest), ...texts.sort(biggest)];
}

function withCuts(messages: readonly Message[], cuts: readonly Cut[]): Message[] {
  const out = [...messages];
  for (const cut of cuts) {
    const message = out[cut.message]!;
    const next: Message = {
      role: message.role,
      text: cut.kind === 'text' ? cut.text : message.text,
      toolUses:
        cut.kind === 'input'
          ? message.toolUses.map((tool, index) => (index === cut.tool ? { ...tool, input: cut.input } : tool))
          : message.toolUses,
    };
    if (message.toolResults) next.toolResults = message.toolResults;
    out[cut.message] = next;
  }
  return out;
}

function totalChars(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + messageChars(message), 0);
}

/**
 * When `first`, the messages Jev's decisions left, removes less than `minReduction` of the window, cuts
 * the long strings in the inputs of calls whose result was dropped, then the middle of the longest old
 * assistant replies, biggest saving first, and stops at the first cut that reaches it. With nothing left
 * to cut it returns everything it could cut, still short of the minimum.
 */
function reachMinimum(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  first: Message[],
  charsBefore: number,
  options: ResolvedCompactOptions,
): { messages: Message[]; inputsShortened: number; textsShortened: number } {
  const goal = Math.ceil(charsBefore * options.minReduction);
  const removed = charsBefore - totalChars(first);
  if (options.minReduction <= 0 || charsBefore === 0 || removed >= goal) {
    return { messages: first, inputsShortened: 0, textsShortened: 0 };
  }
  const cuts = shorteningCuts(messages, decisions, calls, options);
  let take = 0;
  let saved = removed;
  while (take < cuts.length && saved < goal) saved += cuts[take++]!.saved;
  for (;;) {
    const chosen = cuts.slice(0, take);
    const rebuilt =
      take === 0
        ? first
        : applyDecisions(withCuts(messages, chosen), decisions, calls, options.truncateHeadChars);
    if (charsBefore - totalChars(rebuilt) >= goal || take >= cuts.length) {
      return {
        messages: rebuilt,
        inputsShortened: chosen.filter((cut) => cut.kind === 'input').length,
        textsShortened: chosen.filter((cut) => cut.kind === 'text').length,
      };
    }
    take++;
  }
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions. Throws when Jev fails or the
 * history cannot be fitted; the caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: ToolCall[][] = [];
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    const state = fitState(messages, calls, resolved);
    fitted = state;
    batches = batchCalls(candidates, state.tokens, resolved);
    const answered = await Promise.all(
      batches.map((batch) => askBatch(asker, state.state, batch)),
    );
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  }

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  const first = applyDecisions(
    messages,
    decisions,
    calls,
    resolved.truncateHeadChars,
  );
  const { messages: kept, inputsShortened, textsShortened } = reachMinimum(
    messages,
    decisions,
    calls,
    first,
    charsBefore,
    resolved,
  );
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: totalChars(kept),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      inputsShortened,
      textsShortened,
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      ms: Date.now() - started,
    },
  };
}
