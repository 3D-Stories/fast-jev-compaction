import { resolveHookConfig } from '../../hooks/fast-jev.js';
import { compact, messageChars, reductionRatio, resolveOptions } from '../../src/compact.js';
import { collectToolCalls, isPinned } from '../../src/state.js';
import type { CallAction, CompactOptions, CompactResult, JevAsker, Message, ToolCall } from '../../src/types.js';
import type { LoggedDecision } from './log.js';

/** The hook's defaults, from the hook itself: keep threshold 0.5, 6 preserved messages, a 300-char head, 25% minimum. */
const CONFIG = resolveHookConfig({});
const { apiKey: _apiKey, ...settings } = CONFIG;
/** What `compactSession` passes `compact()`. */
export const MAIN_OPTIONS: CompactOptions = { ...settings, minReduction: CONFIG.minReductionRatio };
const OPTIONS = resolveOptions(MAIN_OPTIONS);

export type RuleName = 'main' | 'cut-jev@0.30' | 'cut-jev@0.45' | 'cut-newest@0.30' | 'cut-newest@0.45' | 'cut-all';

/** Every rule, in report order; each runs on the same points. */
export const RULES: readonly RuleName[] = ['main', 'cut-jev@0.30', 'cut-jev@0.45', 'cut-newest@0.30', 'cut-newest@0.45', 'cut-all'];

const CUT_RULES: Record<Exclude<RuleName, 'main'>, { order: 'jev' | 'newest' | 'none'; threshold: number }> = {
  'cut-jev@0.30': { order: 'jev', threshold: 0.3 },
  'cut-jev@0.45': { order: 'jev', threshold: 0.45 },
  'cut-newest@0.30': { order: 'newest', threshold: 0.3 },
  'cut-newest@0.45': { order: 'newest', threshold: 0.45 },
  'cut-all': { order: 'none', threshold: 1 },
};

/** An old output longer than this is cut to its first `CUT_HEAD` and last `CUT_TAIL` chars. */
const CUT_OVER = 2500;
const CUT_HEAD = 1000;
const CUT_TAIL = 500;

/**
 * Where a cut output would be saved, as long as a real path: home, the plugin's folder, a session id and
 * a call id. Placeholder characters only, so it can never match anything in a log.
 */
const SAVED_PATH = `/home/${'u'.repeat(10)}/.claude/fast-jev-compaction/outputs/${'s'.repeat(36)}/${'t'.repeat(32)}.txt`;

/** One rule's result at one point. */
export type RuleRun = {
  rule: RuleName;
  messages: Message[];
  charsBefore: number;
  charsAfter: number;
  reduction: number;
  /** Whether the reduction reaches the hook's minimum; below it the hook falls back to the built-in summary. */
  passes: boolean;
  /** The outputs a cut rule saves to files, whole: their chars and UTF-8 bytes. */
  cut: { toolUseId: string; chars: number; bytes: number }[];
};

function totalChars(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + messageChars(message), 0);
}

/** A logged score, moved inside its two-decimal rounding interval when that is what makes the logged action. */
function nudge(score: number, atLeast: boolean): number {
  const threshold = OPTIONS.keepThreshold;
  if (atLeast && score < threshold && score >= threshold - 0.005) return threshold;
  if (!atLeast && score >= threshold && score < threshold + 0.005) return threshold - 1e-6;
  return score;
}

/** The scores Jev gave, as close as the log tells them: what makes the logged action, within rounding. */
function answered(decision: LoggedDecision): { keepCall: number; keepResult: number } {
  const wants: Record<CallAction, [boolean | undefined, boolean]> = {
    keep: [undefined, true],
    drop_result: [true, false],
    drop_call: [false, false],
  };
  const [call, result] = wants[decision.action];
  return {
    keepCall: call === undefined ? decision.keepCall : nudge(decision.keepCall, call),
    keepResult: nudge(decision.keepResult, result),
  };
}

/** `main`: the real `compact()` with the hook's options, Jev's answers read from the logged decisions. */
export async function runMain(
  window: Message[],
  decisions: ReadonlyMap<string, LoggedDecision>,
): Promise<{ run: RuleRun; result: CompactResult }> {
  const asker: JevAsker = {
    async ask(_state, questions) {
      const answers: Record<string, { noul: number }> = {};
      for (const name of Object.keys(questions)) {
        const split = name.indexOf('_');
        const decision = decisions.get(name.slice(split + 1));
        if (!decision) throw new Error(`no logged decision for ${name.slice(split + 1)}`);
        const scores = answered(decision);
        answers[name] = { noul: name.slice(0, split) === 'call' ? scores.keepCall : scores.keepResult };
      }
      return { answers };
    },
  };
  const result = await compact(window, asker, MAIN_OPTIONS);
  const reduction = reductionRatio(result);
  return {
    result,
    run: {
      rule: 'main',
      messages: result.messages,
      charsBefore: result.stats.charsBefore,
      charsAfter: result.stats.charsAfter,
      reduction,
      passes: reduction >= OPTIONS.minReduction,
      cut: [],
    },
  };
}

/** Whether ending `text` at `index` would separate the two halves of a surrogate pair. */
function splitsSurrogatePair(text: string, index: number): boolean {
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** An output cut to its first 1,000 and last 500 chars around a note naming the file that holds it whole. */
function cutText(text: string): string {
  const headEnd = splitsSurrogatePair(text, CUT_HEAD) ? CUT_HEAD - 1 : CUT_HEAD;
  const tailStart = text.length - CUT_TAIL;
  const tailFrom = splitsSurrogatePair(text, tailStart) ? tailStart + 1 : tailStart;
  const note = `[fast-jev-compaction cut ${tailFrom - headEnd} chars of this tool result; the whole output is in ${SAVED_PATH}]`;
  return `${text.slice(0, headEnd)}\n${note}\n${text.slice(tailFrom)}`;
}

// The reach tiers below are compact.ts's (shorteningCuts, replyTierCuts, reachMinimum), which it does
// not export. The one change: the inputs shortened are those of the calls whose output was cut, where
// compact() shortens those of the calls whose result Jev dropped.

/** A string field shorter than this stays whole: cutting it saves too little. */
const SHORTEN_FIELD_MIN = 1500;
/** An assistant reply shorter than this stays whole. */
const SHORTEN_TEXT_MIN = 2000;
/** The final tier cuts an old reply longer than this and not longer than `SHORTEN_TEXT_MIN`. */
const REPLY_TIER_MIN = 1000;

function shortenedText(text: string, head: number, tail: number, what: string): string {
  const headEnd = splitsSurrogatePair(text, head) ? head - 1 : head;
  const tailStart = text.length - tail;
  const tailFrom = tail > 0 && splitsSurrogatePair(text, tailStart) ? tailStart + 1 : tailStart;
  if (tailFrom <= headEnd) return text;
  const note = `[fast-jev-compaction shortened ${tailFrom - headEnd} chars of this ${what}]`;
  const cut = `${text.slice(0, headEnd)}\n${note}${tail > 0 ? `\n${text.slice(tailFrom)}` : ''}`;
  return cut.length < text.length ? cut : text;
}

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

type Cut =
  | { kind: 'input'; saved: number; message: number; tool: number; input: Record<string, unknown> }
  | { kind: 'text'; saved: number; message: number; text: string };

/** The inputs of the cut calls, biggest saving first, then the old assistant replies over 2,000 chars. */
function shorteningCuts(messages: readonly Message[], cutIds: ReadonlySet<string>): Cut[] {
  const head = OPTIONS.truncateHeadChars;
  const inputs: Cut[] = [];
  const texts: Cut[] = [];
  messages.forEach((message, index) => {
    message.toolUses.forEach((tool, toolIndex) => {
      if (!cutIds.has(tool.tool_use_id)) return;
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
      !isPinned(index, messages.length, OPTIONS.preserveRecentMessages)
    ) {
      const text = shortenedText(message.text, head, head, 'reply');
      const saved = message.text.length - text.length;
      if (saved > 0) texts.push({ kind: 'text', saved, message: index, text });
    }
  });
  const biggest = (a: Cut, b: Cut) => b.saved - a.saved;
  return [...inputs.sort(biggest), ...texts.sort(biggest)];
}

/** The final tier: old assistant replies of 1,001 to 2,000 chars, biggest saving first. */
function replyTierCuts(messages: readonly Message[]): Cut[] {
  const head = OPTIONS.truncateHeadChars;
  const cuts: Cut[] = [];
  messages.forEach((message, index) => {
    if (message.role !== 'assistant' || message.text.length <= REPLY_TIER_MIN || message.text.length > SHORTEN_TEXT_MIN) return;
    if (isPinned(index, messages.length, OPTIONS.preserveRecentMessages)) return;
    const text = shortenedText(message.text, head, head, 'reply');
    const saved = message.text.length - text.length;
    if (saved > 0) cuts.push({ kind: 'text', saved, message: index, text });
  });
  return cuts.sort((a, b) => b.saved - a.saved);
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

/**
 * Below the hook's minimum, cuts in order until one reaches it, as `reachMinimum` does; only when every
 * cut falls short does the final tier join them. A rule cuts no message away, so each saving is exact.
 */
function reach(messages: Message[], charsBefore: number, cutIds: ReadonlySet<string>): Message[] {
  const reached = (charsAfter: number) => (charsBefore - charsAfter) / charsBefore >= OPTIONS.minReduction;
  const charsAfter = totalChars(messages);
  if (OPTIONS.minReduction <= 0 || charsBefore === 0 || reached(charsAfter)) return messages;
  const takeUntil = (cuts: readonly Cut[]): { taken: Cut[]; after: number } => {
    let take = 0;
    let after = charsAfter;
    while (take < cuts.length && !reached(after)) after -= cuts[take++]!.saved;
    return { taken: cuts.slice(0, take), after };
  };
  const cuts = shorteningCuts(messages, cutIds);
  let done = takeUntil(cuts);
  if (!reached(done.after)) {
    const tier = replyTierCuts(messages);
    if (tier.length > 0) done = takeUntil([...cuts, ...tier]);
  }
  return withCuts(messages, done.taken);
}

function withOutputs(window: readonly Message[], cutTexts: ReadonlyMap<string, string>): Message[] {
  return window.map((message) => {
    const touched =
      message.toolUses.some((tool) => cutTexts.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => cutTexts.has(result.tool_use_id));
    if (!touched) return message;
    const next: Message = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => {
        const text = cutTexts.get(tool.tool_use_id);
        return text === undefined ? tool : { ...tool, text };
      }),
    };
    if (message.toolResults) {
      next.toolResults = message.toolResults.map((result) => {
        const text = cutTexts.get(result.tool_use_id);
        return text === undefined ? result : { ...result, text };
      });
    }
    return next;
  });
}

/** The order a cut rule restores outputs in: highest logged keepResult first (ties newest first), or newest first. */
function ranked(candidates: readonly ToolCall[], order: 'jev' | 'newest' | 'none', decisions?: ReadonlyMap<string, LoggedDecision>): ToolCall[] {
  if (order === 'none') return [];
  const newestFirst = [...candidates].reverse();
  if (order === 'newest') return newestFirst;
  const score = (call: ToolCall) => decisions?.get(call.id)?.keepResult ?? 0;
  return newestFirst.sort((a, b) => score(b) - score(a));
}

/**
 * A cut rule: every unpinned output over 2,500 chars is cut to its first 1,000 and last 500, around a
 * note naming its saved file; then outputs are restored whole in the rule's order while the reduction
 * stays at or above its T, stopping at the first that would take it under; then, below the hook's 25%,
 * the reach tiers. No call is dropped and no output is otherwise shortened.
 */
export function runCut(window: Message[], rule: RuleName, decisions?: ReadonlyMap<string, LoggedDecision>): RuleRun {
  if (rule === 'main') throw new Error('main is not a cut rule');
  const { order, threshold } = CUT_RULES[rule];
  const charsBefore = totalChars(window);
  const calls = collectToolCalls(window, OPTIONS.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned && call.resultChars > CUT_OVER);
  const originals = new Map<string, string>();
  for (const message of window) for (const result of message.toolResults ?? []) originals.set(result.tool_use_id, result.text);
  const cutTexts = new Map<string, string>();
  let saved = 0;
  for (const call of candidates) {
    const original = originals.get(call.tool_use_id) ?? '';
    const text = cutText(original);
    cutTexts.set(call.tool_use_id, text);
    saved += original.length - text.length;
  }
  for (const call of ranked(candidates, order, decisions)) {
    const back = (originals.get(call.tool_use_id) ?? '').length - (cutTexts.get(call.tool_use_id) ?? '').length;
    if (charsBefore === 0 || (saved - back) / charsBefore < threshold) break;
    saved -= back;
    cutTexts.delete(call.tool_use_id);
  }
  const messages = reach(withOutputs(window, cutTexts), charsBefore, new Set(cutTexts.keys()));
  const charsAfter = totalChars(messages);
  const reduction = charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
  return {
    rule,
    messages,
    charsBefore,
    charsAfter,
    reduction,
    passes: reduction >= OPTIONS.minReduction,
    cut: candidates
      .filter((call) => cutTexts.has(call.tool_use_id))
      .map((call) => {
        const original = originals.get(call.tool_use_id) ?? '';
        return { toolUseId: call.tool_use_id, chars: original.length, bytes: Buffer.byteLength(original, 'utf8') };
      }),
  };
}

/** Every rule at one point, `main` first. */
export async function runRules(
  window: Message[],
  decisions: ReadonlyMap<string, LoggedDecision>,
): Promise<{ runs: RuleRun[]; main: CompactResult }> {
  const { run, result } = await runMain(window, decisions);
  const runs = [run, ...RULES.filter((rule) => rule !== 'main').map((rule) => runCut(window, rule, decisions))];
  return { runs, main: result };
}
