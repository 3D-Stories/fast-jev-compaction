import { describe, expect, it } from 'vitest';
import {
  compact,
  reductionRatio,
  resolveOptions,
  type JevAsker,
  type JevQuestions,
  type Message,
} from '../src/index.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

/** Jev keeps every call but drops every result: the input of each call stays whole today. */
const dropResults: JevAsker = {
  async ask(_state, questions: JevQuestions) {
    return {
      answers: Object.fromEntries(
        Object.keys(questions).map((key) => [
          key,
          { type: 'noul' as const, noul: key.startsWith('call_') ? 0.9 : 0.1 },
        ]),
      ),
    };
  },
};

/** Jev keeps everything. */
const keepAll: JevAsker = {
  async ask(_state, questions: JevQuestions) {
    return {
      answers: Object.fromEntries(
        Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: 0.9 }]),
      ),
    };
  },
};

const options = { preserveRecentMessages: 2, goal: 'fix the test' };
const minimum = { ...options, minReduction: 0.25 };
const NOTE = /\[fast-jev-compaction shortened \d+ chars/;

/** A window whose bulk is one 20,000-char tool input, then one smaller one, then filler. */
function inputHeavy(): Message[] {
  return [
    message('user', 'Fix the failing test.'),
    call('tool-1', 'Bash', { command: `BIG-${'x'.repeat(20_000)}`, description: 'run it' }, 'ok'),
    result('tool-1', 'ok'),
    call('tool-2', 'Bash', { command: `MID-${'y'.repeat(6_000)}` }, 'ok'),
    result('tool-2', 'ok'),
    message('assistant', 'Done with both.'),
    message('user', 'go ahead'),
  ];
}

function inputOf(messages: readonly Message[], id: string): Record<string, unknown> {
  for (const m of messages) for (const t of m.toolUses) if (t.tool_use_id === id) return t.input;
  throw new Error(`no call ${id}`);
}

describe('reaching the minimum: tool inputs', () => {
  it('is off unless asked for, so the default option leaves a call input whole', () => {
    expect(resolveOptions().minReduction).toBe(0);
  });

  it('lifts a window below the minimum by shortening the input of a call whose result was dropped', async () => {
    const before = await compact(inputHeavy(), dropResults, options);
    expect(reductionRatio(before)).toBeLessThan(0.05);
    const after = await compact(inputHeavy(), dropResults, minimum);
    expect(reductionRatio(after)).toBeGreaterThanOrEqual(0.25);
    const input = inputOf(after.messages, 'tool-1');
    expect(Object.keys(input)).toEqual(['command', 'description']);
    expect(input.description).toBe('run it');
    expect(String(input.command)).toMatch(/^BIG-x+\n\[fast-jev-compaction shortened \d+ chars of this tool input\]$/);
    expect(String(input.command).length).toBeLessThan(500);
    expect(after.stats).toMatchObject({ inputsShortened: 1, textsShortened: 0 });
  });

  it('shortens the largest input first and stops as soon as the minimum is reached', async () => {
    const after = await compact(inputHeavy(), dropResults, minimum);
    expect(String(inputOf(after.messages, 'tool-1').command)).toMatch(NOTE);
    expect(inputOf(after.messages, 'tool-2')).toEqual({ command: `MID-${'y'.repeat(6_000)}` });
  });

  it('changes nothing when the first pass already reaches the minimum', async () => {
    const messages = [
      message('user', 'Fix the failing test.'),
      call('tool-1', 'Read', { file_path: 'src/a.ts' }, 'z'.repeat(20_000)),
      result('tool-1', 'z'.repeat(20_000)),
      message('assistant', 'Done.'),
      message('user', 'go ahead'),
    ];
    const plain = await compact(messages, dropResults, options);
    expect(reductionRatio(plain)).toBeGreaterThanOrEqual(0.25);
    const asked = await compact(messages, dropResults, minimum);
    expect(asked.messages).toEqual(plain.messages);
    expect(asked.stats).toMatchObject({ inputsShortened: 0, textsShortened: 0 });
  });

  it('never shortens the input of a call Jev kept, a pinned call, or text the user wrote', async () => {
    const userText = `USER-${'u'.repeat(30_000)}`;
    const messages = [
      message('user', 'Fix the failing test.'),
      call('tool-1', 'Bash', { command: `KEEP-${'k'.repeat(20_000)}` }, 'ok'),
      result('tool-1', 'ok'),
      message('user', userText),
      call('tool-2', 'Bash', { command: `PIN-${'p'.repeat(20_000)}` }, 'ok'),
      result('tool-2', 'ok'),
    ];
    const kept = await compact(messages, keepAll, minimum);
    expect(reductionRatio(kept)).toBeLessThan(0.25);
    expect(inputOf(kept.messages, 'tool-1')).toEqual({ command: `KEEP-${'k'.repeat(20_000)}` });
    expect(inputOf(kept.messages, 'tool-2')).toEqual({ command: `PIN-${'p'.repeat(20_000)}` });
    expect(kept.messages[3]).toBe(messages[3]);
    const dropped = await compact(messages, dropResults, minimum);
    expect(inputOf(dropped.messages, 'tool-2')).toEqual({ command: `PIN-${'p'.repeat(20_000)}` });
    expect(dropped.messages[3]?.text).toBe(userText);
  });

  it('leaves short fields alone and cuts every long string field of a shortened input', async () => {
    const messages = [
      message('user', 'Fix the failing test.'),
      call('tool-1', 'Edit', { file_path: 'src/a.ts', old_string: 'o'.repeat(9_000), new_string: 'n'.repeat(9_000), n: 3 }, 'ok'),
      result('tool-1', 'ok'),
      message('assistant', 'Edited.'),
      message('user', 'go ahead'),
    ];
    const after = await compact(messages, dropResults, minimum);
    const input = inputOf(after.messages, 'tool-1');
    expect(input.file_path).toBe('src/a.ts');
    expect(input.n).toBe(3);
    expect(String(input.old_string)).toMatch(NOTE);
    expect(String(input.new_string)).toMatch(NOTE);
  });

  it('never ends a shortened field inside a surrogate pair', async () => {
    const messages = [
      message('user', 'Fix the failing test.'),
      call('tool-1', 'Bash', { command: `a${'😀'.repeat(6_000)}` }, 'ok'),
      result('tool-1', 'ok'),
      message('assistant', 'Done.'),
      message('user', 'go ahead'),
    ];
    const after = await compact(messages, dropResults, minimum);
    const text = String(inputOf(after.messages, 'tool-1').command);
    expect(text).toMatch(NOTE);
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });

  it('returns the best it could when the minimum cannot be reached, without throwing', async () => {
    const messages = [
      message('user', `PINNED-${'q'.repeat(30_000)}`),
      call('tool-1', 'Bash', { command: `BIG-${'x'.repeat(2_000)}` }, 'ok'),
      result('tool-1', 'ok'),
      message('assistant', 'Done.'),
      message('user', 'go ahead'),
    ];
    const after = await compact(messages, dropResults, minimum);
    expect(reductionRatio(after)).toBeLessThan(0.25);
    expect(after.messages[0]).toBe(messages[0]);
  });
});

/** A window whose bulk is one old 30,000-char assistant reply. */
function textHeavy(): Message[] {
  const reply = `HEAD-${'a'.repeat(14_000)}-MIDDLE-${'b'.repeat(14_000)}-TAIL`;
  return [
    message('user', 'Fix the failing test.'),
    message('assistant', reply),
    call('tool-1', 'Bash', { command: 'npm test' }, 'ok'),
    result('tool-1', 'ok'),
    message('assistant', 'Done.'),
    message('user', 'go ahead'),
  ];
}

describe('reaching the minimum: long assistant replies', () => {
  it('keeps the start and the end of an old long reply when inputs are not enough', async () => {
    const before = await compact(textHeavy(), dropResults, options);
    expect(reductionRatio(before)).toBeLessThan(0.05);
    const after = await compact(textHeavy(), dropResults, minimum);
    expect(reductionRatio(after)).toBeGreaterThanOrEqual(0.25);
    const text = after.messages[1]!.text;
    expect(text.startsWith('HEAD-a')).toBe(true);
    expect(text.endsWith('b-TAIL')).toBe(true);
    expect(text).toMatch(/\[fast-jev-compaction shortened \d+ chars of this reply\]/);
    expect(text).not.toContain('MIDDLE');
    expect(text.length).toBeLessThan(1_000);
    expect(after.stats).toMatchObject({ inputsShortened: 0, textsShortened: 1 });
  });

  it('shortens inputs first and leaves a reply whole when the inputs reach the minimum', async () => {
    const messages = inputHeavy();
    const reply = `OLD-${'r'.repeat(10_000)}`;
    messages.splice(1, 0, message('assistant', reply));
    const after = await compact(messages, dropResults, minimum);
    expect(reductionRatio(after)).toBeGreaterThanOrEqual(0.25);
    expect(after.messages[1]!.text).toBe(reply);
    expect(after.stats).toMatchObject({ inputsShortened: 1, textsShortened: 0 });
  });

  it('uses both stages when inputs alone fall short', async () => {
    const messages = [
      message('user', 'Fix the failing test.'),
      message('assistant', `OLD-${'r'.repeat(20_000)}-END`),
      call('tool-1', 'Bash', { command: `SMALL-${'s'.repeat(3_000)}` }, 'ok'),
      result('tool-1', 'ok'),
      message('assistant', 'Done.'),
      message('user', 'go ahead'),
    ];
    const after = await compact(messages, dropResults, minimum);
    expect(reductionRatio(after)).toBeGreaterThanOrEqual(0.25);
    expect(after.stats).toMatchObject({ inputsShortened: 1, textsShortened: 1 });
  });

  it('never shortens a recent reply, the first message, or a reply under the length floor', async () => {
    const recent = `RECENT-${'c'.repeat(30_000)}`;
    const small = `SMALL-${'d'.repeat(1_500)}`;
    const messages = [
      message('user', `FIRST-${'f'.repeat(30_000)}`),
      message('assistant', small),
      call('tool-1', 'Bash', { command: 'npm test' }, 'ok'),
      result('tool-1', 'ok'),
      message('assistant', recent),
      message('user', 'go ahead'),
    ];
    const after = await compact(messages, dropResults, minimum);
    expect(after.messages.map((m) => m.text)).toContain(recent);
    expect(after.messages[0]).toBe(messages[0]);
    expect(after.messages[1]!.text).toBe(small);
    expect(after.stats).toMatchObject({ inputsShortened: 0, textsShortened: 0 });
  });

  it('never ends a shortened reply inside a surrogate pair', async () => {
    const messages = textHeavy();
    messages[1] = message('assistant', `a${'😀'.repeat(15_000)}`);
    const after = await compact(messages, dropResults, minimum);
    const text = after.messages[1]!.text;
    expect(text).toMatch(/shortened \d+ chars of this reply/);
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});
