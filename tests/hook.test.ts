import { describe, expect, it } from 'vitest';
import {
  boundsLine,
  callSizes,
  compactSession,
  contextLine,
  decisionLog,
  decisionLogLines,
  logLines,
  register,
  resolveHookConfig,
  summarize,
  toSessionMessages,
  type HookFetch,
} from '../hooks/fast-jev.ts';
import {
  applyDecisions,
  collectToolCalls,
  decideCall,
  type CallDecision,
  type CompactResult,
  type Message,
} from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

function jevFetch(answer: (name: string) => number, bodies: string[] = []) {
  return async (_url: string, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({ compactAtPercent: 60, minReductionRatio: 0.25, model: 'jev-latest' });
    expect(
      resolveHookConfig({ apiKey: 'k', keepThreshold: 0.3, maxStateTokens: 1000, model: 'jev-x', goal: 'g', compactAtPercent: 'no' }),
    ).toEqual({
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 1000,
      model: 'jev-x',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
    });
  });
});

describe('session message mapping', () => {
  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-jev-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
  });

  it('preserves short dropped-result messages and their handles', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });
});

describe('compactSession', () => {
  it('runs the library over the engine fetch and reports the outcome', async () => {
    const bodies: string[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', model: 'jev-x' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), bodies),
    );
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe('jev-x');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 call_dropped; state ~\d+ tokens \(full\) in 1 request\(s\)$/);
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const { result: output } = await compactSession(transcript(), config, jevFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:drop_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on a missing key and on failed requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(compactSession(transcript(), config, jevFetch(() => 0))).rejects.toThrow(/TYPESAFE_API_KEY/);
    await expect(
      compactSession(transcript(), { ...config, apiKey: 'k' }, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
  });

  it('keeps the 0.25 reduction gate by default', () => {
    expect(resolveHookConfig({}).minReductionRatio).toBe(0.25);
  });
});

/** Whether `text` holds half of a surrogate pair on its own. */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/** The text of `(i/N) ` parts, labels removed and joined back. */
function joinParts(lines: readonly string[], label = /^\(\d+\/\d+\) /): string {
  return lines.map((line) => line.replace(label, '')).join('');
}

describe('logLines', () => {
  it('returns a line within the limit unchanged', () => {
    expect(logLines('input: 7 messages')).toEqual(['input: 7 messages']);
    expect(logLines('x'.repeat(1800))).toEqual(['x'.repeat(1800)]);
  });

  it('cuts a 5,000-char line into labelled parts of at most 1,800 chars', () => {
    const text = 'abcdefghij'.repeat(500);
    const lines = logLines(text);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.every((line) => line.length <= 1800)).toBe(true);
    expect(lines.map((line) => line.match(/^\((\d+)\/(\d+)\) /)?.slice(1))).toEqual(
      lines.map((_, index) => [String(index + 1), String(lines.length)]),
    );
    expect(joinParts(lines)).toBe(text);
  });

  it('repacks when the part count gains a digit, so part 10 stays within the limit', () => {
    // With one-digit labels this is 10 parts of 14 chars; two-digit labels leave less room, so 11.
    const text = 'abcdefghij'.repeat(14);
    const lines = logLines(text, 20);
    expect(lines).toHaveLength(11);
    expect(lines.every((line) => line.length <= 20)).toBe(true);
    expect(lines.every((line) => /^\(\d+\/11\) /.test(line))).toBe(true);
    expect(joinParts(lines)).toBe(text);
  });

  it('never cuts a surrogate pair in half', () => {
    const text = `${'a'.repeat(13)}😀${'b'.repeat(20)}`;
    const lines = logLines(text, 20);
    expect(lines[0]).toBe(`(1/3) ${'a'.repeat(13)}`);
    expect(lines.some(hasLoneSurrogate)).toBe(false);
    expect(lines.every((line) => line.length <= 20)).toBe(true);
    expect(joinParts(lines)).toBe(text);
  });

  it('throws a RangeError when the limit cannot hold the label and one code point', () => {
    expect(() => logLines('x'.repeat(10), 5)).toThrow(RangeError);
    expect(() => logLines('x'.repeat(10), 7)).toThrow(RangeError);
    expect(() => logLines('😀'.repeat(10), 7)).toThrow(RangeError);
  });
});

function decided(id: string, tool = 'Bash'): CallDecision {
  return { id, tool, action: 'drop_call', reason: 'call_dropped', keepCall: 0.1, keepResult: 0.1 };
}

async function withDecisions(decisions: CallDecision[]): Promise<CompactResult> {
  const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
  const { result: output } = await compactSession(transcript(), config, jevFetch(() => 0.1));
  return { ...output, decisions };
}

const DECISIONS_LABEL = /^decisions \(\d+\/\d+\): /;

describe('decisionLogLines', () => {
  it('splits at 1,800 chars by default, every entry once and in order', async () => {
    const output = await withDecisions(Array.from({ length: 60 }, (_, i) => decided(`t${i + 1}`)));
    expect(decisionLog(output).length).toBeGreaterThan(2022);
    const lines = decisionLogLines(output);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.every((line) => line.length <= 1800)).toBe(true);
    expect(lines.every((line, index) => line.startsWith(`decisions (${index + 1}/${lines.length}): `))).toBe(true);
    const entries = lines.map((line) => line.replace(DECISIONS_LABEL, '')).join(' ').split(' ');
    expect(entries).toEqual(output.decisions.map((d) => `${d.id}:Bash:drop_call/call=0.10/result=0.10`));
  });

  it('keeps an exact fit at the limit as one part and splits one char over', async () => {
    const output = await withDecisions(Array.from({ length: 5 }, (_, i) => decided(`t${i + 1}`)));
    const single = `decisions: ${decisionLog(output)}`;
    expect(decisionLogLines(output, single.length)).toEqual([single]);
    const split = decisionLogLines(output, single.length - 1);
    expect(split).toHaveLength(2);
    expect(split.every((line) => line.length <= single.length - 1)).toBe(true);
    expect(split.map((line) => line.replace(DECISIONS_LABEL, '')).join(' ')).toBe(decisionLog(output));
  });

  it('cuts an entry longer than a part across parts, losing nothing and never splitting a surrogate pair', async () => {
    // The cut in the long entry falls between the two halves of the emoji.
    const tool = `${'T'.repeat(1779)}😀${'T'.repeat(1500)}`;
    const output = await withDecisions([decided('t1'), decided('t2', tool), decided('t3')]);
    const [first, long, last] = decisionLog(output).split(' ');
    const lines = decisionLogLines(output);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.length <= 1800)).toBe(true);
    expect(lines.some(hasLoneSurrogate)).toBe(false);
    const payloads = lines.map((line) => line.replace(DECISIONS_LABEL, ''));
    expect(payloads[0]).toBe(first);
    expect(payloads.slice(1).join('')).toBe(`${long} ${last}`);
  });

  it('says (none) for no decisions', async () => {
    expect(decisionLogLines(await withDecisions([]))).toEqual(['decisions: (none)']);
  });
});

describe('call sizes', () => {
  it('ends each entry with the call input and result chars when sizes are given', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const { result: output } = await compactSession(
      transcript(),
      config,
      jevFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1)),
    );
    const sizes = callSizes(transcript(), 1);
    expect(decisionLog(output, sizes)).toBe(
      't1:Read:drop_call/call=0.10/result=0.10/in=24/out=1000 t2:Bash:keep/call=0.90/result=0.90/in=22/out=34',
    );
    expect(decisionLogLines(output, undefined, sizes)).toEqual([`decisions: ${decisionLog(output, sizes)}`]);
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
  });
});

describe('boundsLine', () => {
  it('counts pinned and asked-about calls and the most dropping could remove', () => {
    // Pinned from index 4: the Bash call's result is pinned, the Read call is asked about.
    expect(boundsLine(transcript(), 3)).toBe(
      'bounds: 1 pinned calls (in 22, out 34), 1 asked about (in 24, out 1000); dropping every asked-about call would remove at most 91.4% of 1120 chars',
    );
  });

  it('gives 0.0% for an empty window', () => {
    expect(boundsLine([], 6)).toBe(
      'bounds: 0 pinned calls (in 0, out 0), 0 asked about (in 0, out 0); dropping every asked-about call would remove at most 0.0% of 0 chars',
    );
  });
});

type Handler = (fake: unknown, event: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;

/** The hook's handlers over a small fake engine that records every `$.ui.log` and toast. */
type ContextUsage = { window: number; tokens?: number; percent?: number };

function engine(fetch: HookFetch, errors: { read?: string; usage?: string; context?: ContextUsage } = {}) {
  const handlers: Record<string, Handler> = {};
  register(((name: string, handler: Handler) => (handlers[name] = handler)) as never, {
    preserveRecentMessages: 1,
    apiKey: 'k',
  });
  const logs: string[] = [];
  const toasts: string[] = [];
  const fake = {
    env: { get: async (name: string) => (name === 'HOME' ? '/home/u' : undefined) },
    settings: { read: async () => ({}) },
    http: { fetch },
    ui: { log: (text: string) => logs.push(text), toast: (text: string) => toasts.push(text) },
    session: {
      id: async () => 'sess-1',
      cwd: async () => '/home/u/proj',
      usage: async () => {
        if (errors.context) return { context: errors.context };
        throw new Error(errors.usage ?? 'no usage');
      },
      compact: async () => undefined,
    },
    fs: {
      exists: async () => true,
      stat: async () => ({ size: 0, mtimeMs: 0 }),
      read: async () => {
        if (errors.read) throw new Error(errors.read);
        return '';
      },
      list: async () => [],
    },
  };
  return { compactHook: handlers['session.compact']!, turnHook: handlers['turn.complete']!, fake, logs, toasts };
}

function manyCalls(count: number): SessionMessage[] {
  const messages = [message('user', 'Fix the failing test.', { handle: 'h-0' })];
  for (let i = 1; i <= count; i++) {
    messages.push(call(`tool-${i}`, 'Bash', { command: `npm test -- ${i}` }, 'ok'), result(`tool-${i}`, 'x'.repeat(200)));
  }
  messages.push(message('user', 'go ahead', { handle: 'h-end' }));
  return messages;
}

describe('the session.compact hook logs', () => {
  it('keeps every ui.log line within 1,800 chars, logs bounds after input, and returns what compactSession returns', async () => {
    const messages = manyCalls(60);
    const fetch = jevFetch(() => 0.1);
    const { compactHook, fake, logs } = engine(fetch, { read: `log unreadable: ${'r'.repeat(3000)}` });
    const out = (await compactHook(fake, { trigger: 'auto', messages }, async () => ({ skip: 'next' }))) as {
      messages: SessionMessage[];
    };
    expect(logs.every((line) => line.length <= 1800)).toBe(true);
    expect(logs[0]).toMatch(/^input: 122 messages /);
    expect(logs[1]).toBe(boundsLine(messages, 1));
    expect(logs.filter((line) => line.startsWith('decisions (')).length).toBeGreaterThanOrEqual(2);
    expect(logs.some((line) => line.includes(' t1:Bash:drop_call/call=0.10/result=0.10/in=27/out=200 '))).toBe(true);
    const unreadable = logs.filter((line) => /^\(\d+\/\d+\) /.test(line));
    expect(joinParts(unreadable)).toBe(
      `could not read the session log (log unreadable: ${'r'.repeat(3000)}); typed messages are not protected in this compaction`,
    );
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    expect(out.messages).toEqual((await compactSession(messages, config, fetch)).messages);
  });

  it('cuts a long fallback error into parts and toasts it whole', async () => {
    const error = `Jev failed: ${'e'.repeat(5000)}`;
    const { compactHook, fake, logs, toasts } = engine(async () => {
      throw new Error(error);
    });
    const out = await compactHook(fake, { trigger: 'auto', agentId: 'agent-1', messages: transcript() }, async () => ({
      skip: 'next',
    }));
    expect(out).toEqual({ skip: 'next' });
    expect(logs.every((line) => line.length <= 1800)).toBe(true);
    expect(logs[1]).toBe(boundsLine(transcript(), 1));
    expect(joinParts(logs.slice(2))).toBe(`fallback to built-in summary (${error})`);
    expect(toasts).toEqual([`fallback to built-in summary (${error})`]);
  });

  it('still falls back below the reduction gate', async () => {
    const { compactHook, fake } = engine(jevFetch(() => 0.95));
    const out = await compactHook(fake, { trigger: 'auto', agentId: 'agent-1', messages: transcript() }, async () => ({
      skip: 'next',
    }));
    expect(out).toEqual({ skip: 'next' });
  });

  it('cuts a long auto-compact error in turn.complete', async () => {
    const { turnHook, fake, logs } = engine(jevFetch(() => 0.1), { usage: 'u'.repeat(4000) });
    await turnHook(fake, {}, async () => undefined);
    expect(logs.length).toBeGreaterThanOrEqual(3);
    expect(logs.every((line) => line.length <= 1800)).toBe(true);
    expect(joinParts(logs)).toBe(`auto-compact skipped (${'u'.repeat(4000)})`);
  });
});

/** One 20,000-char tool input whose result Jev drops, so the first pass lands far below the bar. */
function bigInput(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Bash', { command: `BIG-${'x'.repeat(20_000)}` }, 'ok'),
    result('tool-1', 'ok'),
    message('assistant', 'Done.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

const dropResultsOnly = (name: string) => (name.startsWith('call_') ? 0.9 : 0.1);

describe('reaching the minimum in the hook', () => {
  it('lifts a window below the bar by shortening the input of a call whose result was dropped', async () => {
    const messages = bigInput();
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const { result: output, messages: out } = await compactSession(messages, config, jevFetch(dropResultsOnly));
    expect(output.stats.charsBefore).toBeGreaterThan(20_000);
    expect(output.stats.charsAfter / output.stats.charsBefore).toBeLessThan(0.75);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(String(out[1]?.toolUses[0]?.input.command)).toMatch(/^BIG-x+\n\[fast-jev-compaction shortened \d+ chars of this tool input\]$/);
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
    expect(summarize(output)).toMatch(/; 1 results truncated, 1 inputs shortened; state ~\d+ tokens/);
  });

  it('names a shortened reply in the summary and stays silent when nothing was shortened', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k' };
    const { result: plain } = await compactSession(transcript(), config, jevFetch(() => 0.1));
    expect(summarize(plain)).not.toMatch(/shortened/);
    const messages = bigInput();
    messages.splice(1, 0, message('assistant', `OLD-${'o'.repeat(30_000)}-END`, { handle: 'h-old' }));
    const { result: output } = await compactSession(messages, config, jevFetch(dropResultsOnly));
    expect(summarize(output)).toMatch(/1 inputs shortened/);
    const textOnly = [messages[0]!, messages[1]!, messages[4]!, messages[5]!];
    const { result: second } = await compactSession(textOnly, config, jevFetch(dropResultsOnly));
    expect(summarize(second)).toMatch(/1 texts shortened/);
  });

  it('keeps the compaction instead of falling back when the pass reaches the bar', async () => {
    const { compactHook, fake, toasts } = engine(jevFetch(dropResultsOnly));
    const out = (await compactHook(fake, { trigger: 'auto', agentId: 'agent-1', messages: bigInput() }, async () => ({
      skip: 'next',
    }))) as { messages?: SessionMessage[]; skip?: string };
    expect(out.skip).toBeUndefined();
    expect(out.messages).toHaveLength(5);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatch(/^kept 5\/5 messages, no summary \(\d+% reduction; .*1 inputs shortened/);
  });

  it('still falls back when even the pass cannot reach the bar, and says what it reached', async () => {
    const messages = [message('user', `PINNED-${'q'.repeat(100_000)}`, { handle: 'h-0' }), ...bigInput().slice(1)];
    const { compactHook, fake, toasts } = engine(jevFetch(dropResultsOnly));
    const out = await compactHook(fake, { trigger: 'auto', agentId: 'agent-1', messages }, async () => ({ skip: 'next' }));
    expect(out).toEqual({ skip: 'next' });
    expect(toasts[0]).toMatch(/^fallback to built-in summary \(below 25% minimum: \d+% reduction/);
  });
});

describe('contextLine', () => {
  it('names the tokens, percent, window, trigger and the configured start point', () => {
    expect(contextLine({ window: 1_000_000, tokens: 612_345, percent: 61 }, 60, 'auto')).toBe(
      'context: 612345 tokens, 61% of a 1000000-token window; compactAtPercent 60; trigger auto',
    );
  });

  it('says so when the host has not reported usage yet', () => {
    expect(contextLine({ window: 200_000 }, 60, 'manual')).toBe(
      'context: usage not reported for a 200000-token window; compactAtPercent 60; trigger manual',
    );
  });

  it('is logged after the bounds line when usage can be read, and never when it cannot', async () => {
    const messages = manyCalls(3);
    const read = engine(jevFetch(() => 0.1), { context: { window: 250_000, tokens: 151_000, percent: 60 } });
    await read.compactHook(read.fake, { trigger: 'auto', messages }, async () => ({ skip: 'next' }));
    expect(read.logs[0]).toMatch(/^input: /);
    expect(read.logs[1]).toBe(boundsLine(messages, 1));
    expect(read.logs[2]).toBe(
      'context: 151000 tokens, 60% of a 250000-token window; compactAtPercent 60; trigger auto',
    );
    const unread = engine(jevFetch(() => 0.1));
    await unread.compactHook(unread.fake, { trigger: 'auto', messages }, async () => ({ skip: 'next' }));
    expect(unread.logs.some((line) => line.startsWith('context:'))).toBe(false);
    const agent = engine(jevFetch(() => 0.1), { context: { window: 250_000, tokens: 1, percent: 1 } });
    await agent.compactHook(agent.fake, { trigger: 'auto', agentId: 'a-1', messages }, async () => ({ skip: 'next' }));
    expect(agent.logs.some((line) => line.startsWith('context:'))).toBe(false);
  });
});
