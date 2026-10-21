import { describe, expect, it } from 'vitest';
import { boundsLine, callSizes, inputBreakdown, inputLine, logLines } from '../hooks/fast-jev.ts';
import type { Message } from '../src/index.js';
import { distinctiveTokens, Labels } from '../scripts/replay/labels.ts';
import { joinParts, LogReader, validate, type LoggedDecision, type Point } from '../scripts/replay/log.ts';
import { runCut, runMain, runRules } from '../scripts/replay/rules.ts';
import { parseArgs, runReplay, stratifiedSample } from '../scripts/replay.ts';

const SESSION = '0f0f0f0f-1111-2222-3333-444444444444';

/** Session-log lines as Claude Code writes them, one second apart. */
class LogLines {
  readonly lines: string[] = [];
  version = '2.1.304';
  prompt = 'prompt-1';
  private clock = Date.parse('2026-10-18T10:00:00.000Z');
  private count = 0;

  constructor(private readonly session = SESSION) {}

  /** Writes one entry; `at` stamps a copy the engine writes again with its original, older time. */
  add(entry: Record<string, unknown>, at?: string): string {
    this.clock += 1000;
    const uuid = `uuid-${++this.count}`;
    this.lines.push(
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        sessionId: this.session,
        version: this.version,
        timestamp: at ?? new Date(this.clock).toISOString(),
        uuid,
        ...entry,
      }),
    );
    return uuid;
  }

  user(content: unknown, extra: Record<string, unknown> = {}, at?: string): string {
    return this.add({ type: 'user', promptId: this.prompt, message: { role: 'user', content }, ...extra }, at);
  }

  /** Claude Code stamps `promptId` on user entries only. */
  assistant(content: unknown[], extra: Record<string, unknown> = {}, at?: string): string {
    return this.add({ type: 'assistant', message: { id: 'msg-1', role: 'assistant', model: 'claude-test', content }, ...extra }, at);
  }

  notice(text: string): void {
    this.add({ type: 'system', subtype: 'informational', level: 'info', isMeta: false, content: `fast-jev-compaction: ${text}` });
  }

  boundary(metadata: Record<string, unknown> = {}): string {
    return this.add({
      type: 'system',
      subtype: 'compact_boundary',
      level: 'info',
      content: 'Conversation compacted',
      compactMetadata: { trigger: 'auto', preTokens: 1000, ...metadata },
    });
  }
}

const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string, content: unknown) => ({ type: 'tool_result', tool_use_id: id, content });

function points(log: LogLines, file = 'session.jsonl'): Point[] {
  const reader = new LogReader(file, SESSION);
  return log.lines.flatMap((line) => reader.push(line)).flatMap((event) => (event.kind === 'point' ? [event.point] : []));
}

function message(role: Message['role'], body: string, extra: Partial<Message> = {}): Message {
  return { role, text: body, toolUses: [], ...extra };
}

/** Thirteen messages: a prompt, three unpinned calls, then six newest messages the hook pins. */
function threeCalls(log: LogLines, middleOutput = 'y'.repeat(20)): void {
  log.user('Start');
  log.assistant([toolUse('c-1', 'Bash', { command: 'a' })]);
  log.user([toolResult('c-1', 'x'.repeat(10))]);
  log.assistant([toolUse('c-2', 'Read', { file_path: 'b' })]);
  log.user([toolResult('c-2', middleOutput)]);
  log.assistant([toolUse('c-3', 'Grep', { pattern: 'c' })]);
  log.user([toolResult('c-3', 'z'.repeat(30))]);
  for (let i = 0; i < 3; i += 1) {
    log.assistant([text('ok')]);
    log.user('go');
  }
}

// What the hook logged for `threeCalls`, worked out by hand: 7 user and 6 assistant messages; text 5 + 6
// (prompt, three "go") and 6 (three "ok"); inputs {"command":"a"} 15, {"file_path":"b"} 17, {"pattern":"c"} 15.
const INPUT =
  'input: 13 messages (7 user, 6 assistant), 124 chars: user text 11 (0 Stop hook feedback copies, 0 chars), assistant text 6, tool input 47, tool output 60; tool-use mirrors 60 chars, not counted';
const BOUNDS =
  'bounds: 0 pinned calls (in 0, out 0), 3 asked about (in 47, out 60); dropping every asked-about call would remove at most 86.3% of 124 chars';
const T1 = 't1:Bash:keep/call=0.90/result=0.80/in=15/out=10';
const T2 = 't2:Read:drop_result/call=0.70/result=0.20/in=17/out=20';
const T3 = 't3:Grep:drop_call/call=0.10/result=0.10/in=15/out=30';
const FINAL = 'kept 12/13 messages, no summary (39% reduction; 1 kept, 1 results truncated, 1 call_dropped; state ~300 tokens (full) in 1 request(s))';

/** The hook's notices for one compaction, in the order it logs them. */
function logged(
  log: LogLines,
  { input = INPUT, bounds = BOUNDS, decisions = [`decisions: ${T1} ${T2} ${T3}`], final = FINAL } = {},
): void {
  log.notice(input);
  log.notice(bounds);
  log.notice('context: 100000 tokens, 50% of a 200000-token window; compactAtPercent 60; trigger auto');
  for (const line of decisions) log.notice(line);
  log.notice('reach: aims for 25%; a final tier also cuts old replies of 1,001-2,000 chars');
  log.notice(final);
}

describe('replay R1: rebuilding the window the hook was handed', () => {
  it('makes one message per user or assistant entry before the boundary, text blocks joined, tool outcomes mirrored', () => {
    const log = new LogLines();
    log.user('Fix the bug');
    log.assistant([{ type: 'thinking', thinking: 'hmm', signature: 's' }]);
    // The same message.id as the entry before: Claude Code still hands it over as its own message.
    log.assistant([text('Looking.')]);
    log.assistant([toolUse('tu-1', 'Read', { file_path: 'a.ts' })]);
    log.user([toolResult('tu-1', [text('line1'), { type: 'image', source: {} }, text('line2')])]);
    log.user('a caveat', { isMeta: true });
    log.assistant([text('a subagent reply')], { isSidechain: true });
    log.add({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'typed' } });
    log.boundary();

    const [point] = points(log);
    expect(point).toMatchObject({ trigger: 'auto', version: '2.1.304', day: '2026-10-18', session: SESSION });
    expect(point!.window).toEqual([
      { role: 'user', text: 'Fix the bug', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [] },
      { role: 'assistant', text: 'Looking.', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'tu-1', tool: 'Read', input: { file_path: 'a.ts' }, text: 'line1\nline2' }],
      },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'tu-1', text: 'line1\nline2', isError: false }] },
    ]);
  });

  it('starts the next window at the boundary, with the copies a kept compaction wrote again', () => {
    const log = new LogLines();
    log.user('First');
    log.assistant([text('One.')]);
    log.boundary();
    log.user('First', {}, '2026-10-18T10:00:01.000Z');
    log.assistant([text('One.')], {}, '2026-10-18T10:00:02.000Z');
    log.user('Second');
    log.assistant([text('Two.')]);
    log.boundary();

    expect(points(log).map((point) => point.window.map((m) => m.text))).toEqual([
      ['First', 'One.'],
      ['First', 'One.', 'Second', 'Two.'],
    ]);
  });

  it('puts the messages a summary kept by reference right after the summary', () => {
    const log = new LogLines();
    log.user('Start');
    log.assistant([text('A')]);
    const first = log.user('Keep me');
    const second = log.assistant([text('B')]);
    log.boundary({
      preservedSegment: { headUuid: first, tailUuid: second, anchorUuid: 'anchor' },
      preservedMessages: { allUuids: [first, second], uuids: [first, second], anchorUuid: 'anchor' },
    });
    log.user('Summary of the conversation', { isCompactSummary: true });
    log.user('After');
    log.boundary();

    expect(points(log)[1]!.window.map((m) => m.text)).toEqual(['Summary of the conversation', 'Keep me', 'B', 'After']);
  });

  it('adds the "Tool loaded." text Claude Code gives a tool_reference result of a turn still in progress, and no other', () => {
    /** Two turns that each load a tool; the second ends with a reply only when `ended`. */
    function toolSearches(ended: boolean): LogLines {
      const log = new LogLines();
      log.prompt = 'turn-1';
      log.user('Find a tool');
      log.assistant([toolUse('ts-1', 'ToolSearch', { query: 'a' })]);
      log.user([toolResult('ts-1', [{ type: 'tool_reference', tool_name: 'Alpha' }])]);
      log.assistant([text('Found it.')]);
      log.prompt = 'turn-2';
      log.user('Another');
      log.assistant([toolUse('ts-2', 'ToolSearch', { query: 'b' })]);
      log.user([toolResult('ts-2', [{ type: 'tool_reference', tool_name: 'Beta' }])]);
      log.assistant([toolUse('b-1', 'Bash', { command: 'ls' })]);
      log.user([toolResult('b-1', 'done')]);
      if (ended) log.assistant([text('Both found.')]);
      log.boundary();
      return log;
    }
    const loaded = (log: LogLines) =>
      points(log)[0]!.window.filter((m) => m.toolResults?.[0]?.tool_use_id.startsWith('ts-')).map((m) => m.text);

    expect(loaded(toolSearches(false))).toEqual(['', 'Tool loaded.']);
    expect(loaded(toolSearches(true))).toEqual(['', '']);
  });

  it('leaves out the /compact command that started a manual compaction', () => {
    const log = new LogLines();
    log.user('Hello');
    log.assistant([text('Hi')]);
    log.user('/compact');
    log.boundary({ trigger: 'manual' });

    expect(points(log)[0]!.window.map((m) => m.text)).toEqual(['Hello', 'Hi']);
  });
});

describe('replay R2: validating a point against the hook own lines', () => {
  it('uses a point whose rebuilt window gives the logged input: and bounds: lines exactly', () => {
    const log = new LogLines();
    threeCalls(log);
    logged(log);
    log.boundary();

    expect(validate(points(log)[0]!)).toMatchObject({ ok: true });
  });

  it('drops a point when its input: line is one char off', () => {
    const log = new LogLines();
    threeCalls(log);
    logged(log, { input: INPUT.replace('124 chars', '125 chars') });
    log.boundary();

    expect(validate(points(log)[0]!)).toEqual({ ok: false, reason: 'input-differs' });
  });

  it('drops a point when its bounds: line is one char off', () => {
    const log = new LogLines();
    threeCalls(log);
    logged(log, { bounds: BOUNDS.replace('86.3%', '86.4%') });
    log.boundary();

    expect(validate(points(log)[0]!)).toEqual({ ok: false, reason: 'bounds-differs' });
  });

  it('drops a point the hook logged nothing for', () => {
    const log = new LogLines();
    threeCalls(log);
    log.boundary();

    expect(validate(points(log)[0]!)).toEqual({ ok: false, reason: 'no-notice' });
  });

  it('drops a point whose compaction record disagrees with the log, and keeps one whose record agrees', () => {
    const log = new LogLines();
    threeCalls(log);
    logged(log);
    log.boundary();
    const [point] = points(log);

    expect(validate(point!, { messagesIn: 13, detail: FINAL })).toMatchObject({ ok: true });
    expect(validate(point!, { messagesIn: 13, detail: FINAL.replace('12/13', '11/13') })).toEqual({
      ok: false,
      reason: 'record-differs',
    });
  });
});

describe('replay R3: the logged decisions', () => {
  it('joins the (i/N) parts the hook cuts a long line into', () => {
    const long = `fallback to built-in summary (${'Jev request failed '.repeat(12)})`;
    const parts = logLines(long, 80);
    expect(parts.length).toBeGreaterThan(2);
    expect(joinParts(['input: x', ...parts, 'bounds: y'])).toEqual(['input: x', long, 'bounds: y']);
  });

  it('joins decisions (i/N): parts and maps each entry to the call collectToolCalls numbers the same', () => {
    const log = new LogLines();
    threeCalls(log);
    logged(log, { decisions: [`decisions (1/2): ${T1} ${T2}`, `decisions (2/2): ${T3}`] });
    log.boundary();

    const checked = validate(points(log)[0]!);
    expect(checked.ok).toBe(true);
    const decisions = checked.ok ? [...checked.decisions.values()] : [];
    expect(decisions).toEqual([
      { id: 't1', toolUseId: 'c-1', tool: 'Bash', action: 'keep', keepCall: 0.9, keepResult: 0.8, input: 15, output: 10 },
      { id: 't2', toolUseId: 'c-2', tool: 'Read', action: 'drop_result', keepCall: 0.7, keepResult: 0.2, input: 17, output: 20 },
      { id: 't3', toolUseId: 'c-3', tool: 'Grep', action: 'drop_call', keepCall: 0.1, keepResult: 0.1, input: 15, output: 30 },
    ]);
  });

  it('drops a point when a logged call size disagrees with the window', () => {
    const log = new LogLines();
    threeCalls(log);
    logged(log, { decisions: [`decisions: ${T1.replace('out=10', 'out=11')} ${T2} ${T3}`] });
    log.boundary();

    expect(validate(points(log)[0]!)).toEqual({ ok: false, reason: 'decisions-differ' });
  });
});

/** Five calls whose outputs hold a distinctive token at the head, middle and tail of a long output, in a short one, and none. */
function labelLog(laterCommand = 'cat TAILTOKEN_0003'): LogLines {
  const log = new LogLines();
  log.user('Start');
  const outputs: [string, string][] = [
    ['h-1', `HEADTOKEN_0001 ${'a'.repeat(3000)}`],
    ['h-2', `${'b'.repeat(1500)} MIDTOKEN_0002 ${'b'.repeat(1500)}`],
    ['h-3', `${'c'.repeat(3000)} TAILTOKEN_0003`],
    ['h-4', 'WHOLETOKEN_0004 shared_77777'],
    ['h-5', 'twin shared_77777'],
  ];
  for (const [id, output] of outputs) {
    log.assistant([toolUse(id, 'Bash', { command: id })]);
    log.user([toolResult(id, output)]);
  }
  for (let i = 0; i < 3; i += 1) {
    log.assistant([text('ok')]);
    log.user('go');
  }
  log.boundary();
  log.user('please use WHOLETOKEN_0004');
  log.assistant([text('Using HEADTOKEN_0001, MIDTOKEN_0002 and shared_77777.')]);
  log.assistant([toolUse('later-1', 'Bash', { command: laterCommand })]);
  return log;
}

function decided(entries: [string, string, LoggedDecision['action'], number, number][], window: Message[]): Map<string, LoggedDecision> {
  const sizes = callSizes(window, 6);
  return new Map(
    entries.map(([id, toolUseId, action, keepCall, keepResult]) => [
      id,
      { id, toolUseId, tool: 'Bash', action, keepCall, keepResult, input: sizes.get(id)!.input, output: sizes.get(id)!.output },
    ]),
  );
}

describe('replay R4: labels', () => {
  // A tool input is read by its strings: in its JSON text a newline is `\n`, whose n would glue onto the token.
  const laterCommands = ['cat TAILTOKEN_0003', 'cat\nTAILTOKEN_0003'];

  it.each(laterCommands)('labels an old output by its distinctive token reused first in later assistant text or tool input (%j)', async (command) => {
    const log = labelLog(command);
    const reader = new LogReader('session.jsonl', SESSION);
    const labels = new Labels();
    for (const line of log.lines) {
      for (const event of reader.push(line)) {
        if (event.kind === 'later') labels.later(event.texts);
        else {
          const decisions = decided(
            [
              ['t1', 'h-1', 'keep', 0.9, 0.9],
              ['t2', 'h-2', 'drop_result', 0.9, 0.1],
              ['t3', 'h-3', 'drop_call', 0.1, 0.1],
              ['t4', 'h-4', 'keep', 0.9, 0.9],
              ['t5', 'h-5', 'keep', 0.9, 0.9],
            ],
            event.point.window,
          );
          const { runs } = await runRules(event.point.window, decisions);
          labels.track(0, event.point.window, runs);
        }
      }
    }

    const outputs = labels.outputs(0).map(({ toolUseId, label, usable }) => ({
      toolUseId,
      label,
      main: usable.main,
      cutAll: usable['cut-all'],
    }));
    // h-4's token came back only in user text and h-5 holds no token found in it alone: neither is later-needed.
    expect(outputs).toEqual([
      { toolUseId: 'h-1', label: 'HEADTOKEN_0001', main: true, cutAll: true },
      { toolUseId: 'h-2', label: 'MIDTOKEN_0002', main: false, cutAll: false },
      { toolUseId: 'h-3', label: 'TAILTOKEN_0003', main: false, cutAll: true },
    ]);
    expect(labels.counts(0)).toMatchObject({ needed: 3, usable: { main: 1, 'cut-all': 2 } });
  });

  it('does not count a token as distinctive of an output when another tool input holds it after a tab', () => {
    const window: Message[] = [message('user', 'Start')];
    for (const [id, command, output] of [
      ['h-3', 'h-3', 'TAILTOKEN_0003 OWNTOKEN_0033'],
      ['h-6', 'grep\tTAILTOKEN_0003', 'no match'],
    ] as const) {
      window.push(
        message('assistant', '', { toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command }, text: output }] }),
        message('user', '', { toolResults: [{ tool_use_id: id, text: output, isError: false }] }),
      );
    }
    for (let i = 0; i < 3; i += 1) window.push(message('assistant', 'ok'), message('user', 'go'));

    expect(distinctiveTokens(window)).toEqual(new Map([['h-3', ['OWNTOKEN_0033']]]));
  });
});

/** Ten unpinned calls with outputs of the given sizes, then six newest messages. Every char is distinct by position. */
function tenCalls(): Message[] {
  const sizes = [3000, 1000, 5000, 2600, 200, 4000, 2500, 8000, 100, 6000];
  const window: Message[] = [message('user', 'Start')];
  sizes.forEach((size, index) => {
    const id = `tu-${index + 1}`;
    let output = '';
    for (let n = 0; output.length < size; n += 1) output += `${index + 1}:${n} `;
    output = output.slice(0, size);
    window.push(
      message('assistant', '', { toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: `cmd ${index + 1}` }, text: output }] }),
      message('user', '', { toolResults: [{ tool_use_id: id, text: output, isError: false }] }),
    );
  });
  for (let i = 0; i < 3; i += 1) window.push(message('assistant', 'ok'), message('user', 'next'));
  return window;
}

const TEN_DECISIONS: [string, string, LoggedDecision['action'], number, number][] = [
  ['t1', 'tu-1', 'keep', 0.9, 0.9],
  ['t2', 'tu-2', 'drop_result', 0.8, 0.3],
  ['t3', 'tu-3', 'drop_call', 0.2, 0.1],
  ['t4', 'tu-4', 'keep', 0.6, 0.5],
  // Logged as 0.50 but dropped: Jev's value was just under the threshold before toFixed(2) rounded it.
  ['t5', 'tu-5', 'drop_result', 0.5, 0.5],
  ['t6', 'tu-6', 'drop_call', 0.5, 0.1],
  ['t7', 'tu-7', 'keep', 0.7, 0.95],
  ['t8', 'tu-8', 'drop_result', 0.95, 0.05],
  ['t9', 'tu-9', 'keep', 1, 1],
  ['t10', 'tu-10', 'drop_call', 0, 0],
];

function resultText(messages: readonly Message[], id: string): string | undefined {
  for (const m of messages) for (const r of m.toolResults ?? []) if (r.tool_use_id === id) return r.text;
  return undefined;
}

describe('replay R5: the rules on a ten-call window', () => {
  it('main reproduces every logged action through the real compact(), rounded scores included', async () => {
    const window = tenCalls();
    const { result } = await runMain(window, decided(TEN_DECISIONS, window));
    expect(result.decisions.map((d) => d.action)).toEqual([
      'keep',
      'drop_result',
      'drop_call',
      'keep',
      'drop_result',
      'drop_call',
      'keep',
      'drop_result',
      'keep',
      'drop_call',
    ]);
  });

  it('cut-all cuts every old output over 2,500 chars to its first 1,000 and last 500, and leaves the rest whole', () => {
    const window = tenCalls();
    const run = runCut(window, 'cut-all');
    expect(run.cut.map((c) => c.toolUseId)).toEqual(['tu-1', 'tu-3', 'tu-4', 'tu-6', 'tu-8', 'tu-10']);
    for (const id of ['tu-1', 'tu-3', 'tu-4', 'tu-6', 'tu-8', 'tu-10']) {
      const before = resultText(window, id)!;
      const after = resultText(run.messages, id)!;
      expect(after.startsWith(before.slice(0, 1000))).toBe(true);
      expect(after.endsWith(before.slice(-500))).toBe(true);
      expect(after.length).toBeLessThan(before.length);
    }
    for (const id of ['tu-2', 'tu-5', 'tu-7', 'tu-9']) expect(resultText(run.messages, id)).toBe(resultText(window, id));
  });

  it('cut-newest and cut-jev restore outputs whole in their order, and stop at the first that would take the reduction under T', () => {
    const window = tenCalls();
    const decisions = decided(TEN_DECISIONS, window);
    const cutIds = (rule: Parameters<typeof runCut>[1]) => runCut(window, rule, decisions).cut.map((c) => c.toolUseId);
    // Newest first: tu-10 fits under 0.30, tu-8 would not, so nothing older comes back either.
    expect(cutIds('cut-newest@0.30')).toEqual(['tu-1', 'tu-3', 'tu-4', 'tu-6', 'tu-8']);
    // Highest logged keepResult first: tu-1 (0.90), tu-4 (0.50), then the 0.10 tie newest first, tu-6 and tu-3.
    expect(cutIds('cut-jev@0.30')).toEqual(['tu-8', 'tu-10']);
    expect(cutIds('cut-jev@0.45')).toEqual(['tu-3', 'tu-6', 'tu-8', 'tu-10']);
    for (const rule of ['cut-newest@0.30', 'cut-jev@0.30'] as const) {
      expect(runCut(window, rule, decisions).reduction).toBeGreaterThanOrEqual(0.3);
    }
    expect(runCut(window, 'cut-jev@0.45', decisions).reduction).toBeGreaterThanOrEqual(0.45);
  });

  it('a cut rule short of 25% shortens the inputs of the calls it cut, as main does for dropped results', () => {
    const window: Message[] = [message('user', 'Start')];
    for (const [id, command, output] of [
      ['r-1', 'x'.repeat(20_000), 'o'.repeat(2_600)],
      ['r-2', 'y'.repeat(20_000), 'p'.repeat(100)],
    ] as const) {
      window.push(
        message('assistant', '', { toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command }, text: output }] }),
        message('user', '', { toolResults: [{ tool_use_id: id, text: output, isError: false }] }),
      );
    }
    for (let i = 0; i < 3; i += 1) window.push(message('assistant', 'ok'), message('user', 'next'));

    const run = runCut(window, 'cut-all');
    expect(run.reduction).toBeGreaterThanOrEqual(0.25);
    const inputs = new Map(run.messages.flatMap((m) => m.toolUses.map((t) => [t.tool_use_id, String(t.input['command'])])));
    expect(inputs.get('r-1')).toMatch(/\[fast-jev-compaction shortened \d+ chars of this tool input\]/);
    expect(inputs.get('r-2')).toBe('y'.repeat(20_000));
  });
});

describe('replay R6: the report and the run', () => {
  const PRIVATE_SESSION = '9a9a9a9a-5555-6666-7777-888888888888';
  const PRIVATE_FILE = `/home/alice/.claude/projects/-home-alice-code-secret-project/${PRIVATE_SESSION}.jsonl`;
  const SECRET = 'sk-ant-api03-SECRETSECRET0123456789';

  /** One point that validates, whose middle output holds a secret-like token the assistant reuses later. */
  function privateLog(): LogLines {
    const log = new LogLines(PRIVATE_SESSION);
    threeCalls(log, `see ${SECRET} here`);
    const window: Message[] = [message('user', 'Start')];
    for (const [id, tool, input, output] of [
      ['c-1', 'Bash', { command: 'a' }, 'x'.repeat(10)],
      ['c-2', 'Read', { file_path: 'b' }, `see ${SECRET} here`],
      ['c-3', 'Grep', { pattern: 'c' }, 'z'.repeat(30)],
    ] as const) {
      window.push(
        message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text: output }] }),
        message('user', '', { toolResults: [{ tool_use_id: id, text: output, isError: false }] }),
      );
    }
    for (let i = 0; i < 3; i += 1) window.push(message('assistant', 'ok'), message('user', 'go'));
    const sizes = callSizes(window, 6);
    const entry = (id: string, tool: string) => `${id}:${tool}:keep/call=0.90/result=0.90/in=${sizes.get(id)!.input}/out=${sizes.get(id)!.output}`;
    logged(log, {
      input: inputLine(inputBreakdown(window)),
      bounds: boundsLine(window, 6),
      decisions: [`decisions: ${entry('t1', 'Bash')} ${entry('t2', 'Read')} ${entry('t3', 'Grep')}`],
    });
    log.boundary();
    log.user('my private words');
    log.assistant([text(`Reading ${SECRET} again.`)]);
    return log;
  }

  function replay(minPoints: number, sample = 200) {
    const log = privateLog();
    return runReplay({
      logs: [{ file: PRIVATE_FILE, session: PRIVATE_SESSION, lines: () => log.lines }],
      records: [],
      since: '2026-10-17',
      until: '2026-10-20',
      seed: 20,
      sample,
      minPoints,
      command: 'npm run replay -- --since 2026-10-17 --until 2026-10-20',
      runDate: '2026-10-20',
    });
  }

  it('writes a report with one row per rule and no log text, token, path, session id or project name', async () => {
    const { exitCode, markdown } = await replay(1);
    expect(exitCode).toBe(0);
    for (const rule of ['main', 'cut-jev@0.30', 'cut-jev@0.45', 'cut-newest@0.30', 'cut-newest@0.45', 'cut-all']) {
      expect(markdown).toContain(rule);
    }
    for (const secret of [SECRET, 'SECRETSECRET', '/home/alice', 'secret-project', PRIVATE_SESSION, '9a9a9a9a', 'my private words']) {
      expect(markdown).not.toContain(secret);
    }
  });

  it('exits 1 and writes no report when fewer points validate, or are sampled, than the minimum', async () => {
    // One point validates: a minimum of 2 is not met, and a sample of 0 replays none.
    for (const [minPoints, sample] of [
      [2, 200],
      [1, 0],
    ] as const) {
      const { exitCode, markdown } = await replay(minPoints, sample);
      expect(exitCode).toBe(1);
      expect(markdown).toBeUndefined();
    }
  });

  it('refuses a minimum under 100 points, and a sample smaller than the minimum', () => {
    const args = ['--since', '2026-10-17', '--until', '2026-10-20', '--out', 'report.md'];
    expect(() => parseArgs([...args, '--min-points', '99'])).toThrow(/--min-points/);
    expect(() => parseArgs([...args, '--min-points', '0'])).toThrow(/--min-points/);
    expect(() => parseArgs([...args, '--sample', '50'])).toThrow(/--sample/);
    expect(parseArgs([...args, '--sample', '100'])).toMatchObject({ sample: 100, minPoints: 100 });
    expect(parseArgs(args)).toMatchObject({ sample: 200, minPoints: 100 });
  });

  it('draws the same seeded sample every time, spread across sessions before any session gives a second point', () => {
    const all = [
      ...Array.from({ length: 10 }, (_, n) => ({ session: 'big', n })),
      { session: 'mid', n: 0 },
      { session: 'mid', n: 1 },
      { session: 'one', n: 0 },
    ];
    const sample = stratifiedSample(all, 6, 20);
    const perSession = Object.fromEntries(['big', 'mid', 'one'].map((s) => [s, sample.filter((p) => p.session === s).length]));
    expect(perSession).toEqual({ big: 3, mid: 2, one: 1 });
    expect(stratifiedSample(all, 6, 20)).toEqual(sample);
  });
});
