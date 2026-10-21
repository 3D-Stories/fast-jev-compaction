import { DEFAULT_OPTIONS } from '../../src/compact.js';
import { collectToolCalls } from '../../src/state.js';
import type { Message } from '../../src/types.js';
import type { RuleName, RuleRun } from './rules.js';

/** A maximal run of these chars, starting and ending with a letter or digit. */
const TOKEN = /[A-Za-z0-9][A-Za-z0-9_.\/:@#+-]*[A-Za-z0-9]/g;
/** A token holds a digit or one of these, so plain words never count. */
const MARK = /[0-9\/._:@#]/;
const TOKEN_MIN = 8;

/** The tokens of a text, in order: maximal matches of `TOKEN`, at least 8 chars, holding a digit or one of / . _ : @ #. */
export function tokensOf(text: string): string[] {
  const found: string[] = [];
  for (const [token] of text.matchAll(TOKEN)) if (token.length >= TOKEN_MIN && MARK.test(token)) found.push(token);
  return found;
}

function inputText(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return '';
  }
}

/**
 * The distinctive tokens of each old output (the result of an unpinned call): tokens found in that output
 * and in no other text, tool input or tool output of the window. The `text` a tool use mirrors is a copy
 * of its output and is not read. Outputs with no such token are left out.
 */
export function distinctiveTokens(window: readonly Message[]): Map<string, string[]> {
  const old = new Set(
    collectToolCalls(window, DEFAULT_OPTIONS.preserveRecentMessages)
      .filter((call) => !call.pinned)
      .map((call) => call.tool_use_id),
  );
  // Each token's one source, or null once it is seen in a second one.
  const source = new Map<string, string | null>();
  const note = (text: string, where: string) => {
    for (const token of tokensOf(text)) {
      const seen = source.get(token);
      if (seen === undefined) source.set(token, where);
      else if (seen !== where) source.set(token, null);
    }
  };
  window.forEach((message, index) => {
    note(message.text, `text ${index}`);
    message.toolUses.forEach((tool, toolIndex) => note(inputText(tool.input), `input ${index} ${toolIndex}`));
    for (const result of message.toolResults ?? []) {
      note(result.text, old.has(result.tool_use_id) ? `old ${result.tool_use_id}` : `output ${index} ${result.tool_use_id}`);
    }
  });
  const outputs = new Map<string, string[]>();
  for (const [token, where] of source) {
    if (!where?.startsWith('old ')) continue;
    const id = where.slice('old '.length);
    outputs.set(id, [...(outputs.get(id) ?? []), token]);
  }
  return outputs;
}

function outputOf(messages: readonly Message[], toolUseId: string): string | undefined {
  for (const message of messages) {
    for (const result of message.toolResults ?? []) if (result.tool_use_id === toolUseId) return result.text;
  }
  return undefined;
}

/** What of one old output a rule left in its window: all of it, none, or the distinctive tokens still in what is left. */
type Left = { whole: true } | { whole: false; tokens: ReadonlySet<string> };

type Tracked = {
  toolUseId: string;
  tokens: readonly string[];
  left: Map<RuleName, Left>;
  label?: string;
};

/**
 * Labels the old outputs of each tracked point by the first of their distinctive tokens reused later in
 * an assistant text or a tool input, and tells, per rule, whether that label is still in the rule's
 * compacted window: usable only when the rule also reaches the hook's minimum. A saved file never counts.
 */
export class Labels {
  private readonly points = new Map<number, { tracked: Tracked[]; passes: Map<RuleName, boolean> }>();
  private readonly waiting = new Map<string, Tracked[]>();

  track(point: number, window: readonly Message[], runs: readonly RuleRun[]): void {
    const tracked: Tracked[] = [];
    for (const [toolUseId, tokens] of distinctiveTokens(window)) {
      const original = outputOf(window, toolUseId);
      const own = new Set(tokens);
      const left = new Map<RuleName, Left>();
      for (const run of runs) {
        const remains = outputOf(run.messages, toolUseId);
        if (remains === original) left.set(run.rule, { whole: true });
        else left.set(run.rule, { whole: false, tokens: new Set(remains === undefined ? [] : tokensOf(remains).filter((t) => own.has(t))) });
      }
      const item: Tracked = { toolUseId, tokens, left };
      tracked.push(item);
      for (const token of tokens) this.waiting.set(token, [...(this.waiting.get(token) ?? []), item]);
    }
    this.points.set(point, { tracked, passes: new Map(runs.map((run) => [run.rule, run.passes])) });
  }

  /** Content written later; the first token of an output found here becomes its label. */
  later(texts: readonly string[]): void {
    if (this.waiting.size === 0) return;
    for (const text of texts) {
      for (const token of tokensOf(text)) {
        const items = this.waiting.get(token);
        if (!items) continue;
        this.waiting.delete(token);
        for (const item of items) {
          if (item.label !== undefined) continue;
          item.label = token;
          for (const other of item.tokens) {
            const rest = this.waiting.get(other)?.filter((candidate) => candidate !== item);
            if (rest === undefined) continue;
            if (rest.length > 0) this.waiting.set(other, rest);
            else this.waiting.delete(other);
          }
        }
      }
    }
  }

  /** The later-needed outputs of a point, in window order, with their label and, per rule, whether it stayed usable. */
  outputs(point: number): { toolUseId: string; label: string; usable: Record<RuleName, boolean> }[] {
    const entry = this.points.get(point);
    if (!entry) return [];
    return entry.tracked.flatMap((item) => {
      const label = item.label;
      if (label === undefined) return [];
      const usable = {} as Record<RuleName, boolean>;
      for (const [rule, left] of item.left) {
        usable[rule] = (entry.passes.get(rule) ?? false) && (left.whole || left.tokens.has(label));
      }
      return [{ toolUseId: item.toolUseId, label, usable }];
    });
  }

  counts(point: number): { needed: number; usable: Record<RuleName, number> } {
    const outputs = this.outputs(point);
    const usable = {} as Record<RuleName, number>;
    for (const rule of this.points.get(point)?.passes.keys() ?? []) {
      usable[rule] = outputs.filter((output) => output.usable[rule]).length;
    }
    return { needed: outputs.length, usable };
  }
}
