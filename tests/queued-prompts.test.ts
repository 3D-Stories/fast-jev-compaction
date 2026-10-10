import { describe, expect, it } from 'vitest';
import {
  compactSession,
  projectDirName,
  register,
  typedNotes,
  typedNotesByGrep,
  withTypedWords,
} from '../hooks/fast-jev.ts';
import type { Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input: { command: id }, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }], handle: `r-${id}` });
}

function transcript(): SessionMessage[] {
  return [
    message('user', 'Run the slow check, then the tests.', { handle: 'h-0' }),
    call('tool-1', 'Bash', 'slow check done'),
    result('tool-1', 'slow check done'),
    call('tool-2', 'Bash', 'x'.repeat(400)),
    result('tool-2', 'x'.repeat(400)),
    message('assistant', 'Both ran.', { handle: 'h-5' }),
    message('user', 'go on', { handle: 'h-6' }),
  ];
}

/** Jev answers every question the same: a low keep probability drops every candidate call. */
function jevFetch(answer: number) {
  return async (_url: string, init?: { body?: string }) => {
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer }]));
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

/** One session-log line per entry, shaped as Claude Code writes them. */
function logLine(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

function toolResultEntry(uuid: string, toolUseId: string): string {
  return logLine({
    type: 'user',
    uuid,
    parentUuid: 'a-1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'done' }] },
  });
}

function queuedEntry(
  uuid: string,
  parentUuid: string,
  kind: string | undefined,
  mode = 'prompt',
  prompt: unknown = 'note',
  isMeta = false,
  source?: string,
): string {
  return logLine({
    type: 'attachment',
    uuid,
    parentUuid,
    ...(isMeta ? { isMeta: true } : {}),
    attachment: {
      type: 'queued_command',
      prompt,
      commandMode: mode,
      ...(kind === undefined ? {} : { origin: { kind } }),
      ...(source === undefined ? {} : { source_uuid: source }),
    },
  });
}

function boundaryLine(preserved: string[] = []): string {
  return logLine({
    type: 'system',
    subtype: 'compact_boundary',
    uuid: `b-${preserved.length}`,
    parentUuid: null,
    compactMetadata: { trigger: 'auto', ...(preserved.length > 0 ? { preservedMessages: { uuids: preserved, allUuids: preserved } } : {}) },
  });
}

function hookAttachment(uuid: string, parentUuid: string): string {
  return logLine({ type: 'attachment', uuid, parentUuid, attachment: { type: 'hook_success' } });
}

describe('typedNotes', () => {
  it('finds the tool call whose result carries a message typed while it ran', () => {
    const log = [toolResultEntry('u-1', 'tool-1'), queuedEntry('q-1', 'u-1', 'human', 'prompt', 'send it to w74:p7F')].join('\n');
    expect(typedNotes(log)).toEqual([{ toolUseId: 'tool-1', prompt: 'send it to w74:p7F' }]);
  });

  it('walks up through other attachments to the tool result', () => {
    const log = [
      toolResultEntry('u-1', 'tool-1'),
      logLine({ type: 'attachment', uuid: 'hook-1', parentUuid: 'u-1', attachment: { type: 'hook_success' } }),
      queuedEntry('q-1', 'hook-1', 'human'),
    ].join('\n');
    expect(typedNotes(log)).toEqual([{ toolUseId: 'tool-1', prompt: 'note' }]);
  });

  it('ignores what the engine queues itself: task notifications, auto-continuations and observer digests', () => {
    const log = [
      toolResultEntry('u-1', 'tool-1'),
      queuedEntry('q-1', 'u-1', 'task-notification', 'task-notification'),
      queuedEntry('q-2', 'u-1', 'auto-continuation'),
      queuedEntry('q-3', 'u-1', 'observer-activity'),
    ].join('\n');
    expect(typedNotes(log)).toEqual([]);
  });

  it('finds nothing for a message delivered as its own turn, and skips lines it cannot parse', () => {
    const log = [
      logLine({ type: 'user', uuid: 'p-1', parentUuid: null, message: { role: 'user', content: 'hello' } }),
      queuedEntry('q-1', 'p-1', 'human'),
      '{not json',
      '',
    ].join('\n');
    expect(typedNotes(log)).toEqual([]);
  });

  it('walks any number of attachments up to the tool result', () => {
    const chain = Array.from({ length: 12 }, (_, i) => hookAttachment(`hook-${i}`, i === 0 ? 'u-1' : `hook-${i - 1}`));
    const log = [toolResultEntry('u-1', 'tool-1'), ...chain, queuedEntry('q-1', 'hook-11', 'human')].join('\n');
    expect(typedNotes(log)).toEqual([{ toolUseId: 'tool-1', prompt: 'note' }]);
  });

  it('stops on a parent cycle without pinning anything', () => {
    const log = [hookAttachment('hook-a', 'hook-b'), hookAttachment('hook-b', 'hook-a'), queuedEntry('q-1', 'hook-a', 'human')].join('\n');
    expect(typedNotes(log)).toEqual([]);
  });

  it('counts only a person: the terminal (human), Remote Control (bridge), or an unmarked prompt with no origin', () => {
    const kinds: Array<[string | undefined, boolean, boolean]> = [
      ['human', false, true],
      ['bridge', false, true],
      [undefined, false, true],
      [undefined, true, false],
      ['peer', true, false],
      ['peer', false, false],
      ['scheduled-trigger', false, false],
      ['auto-continuation', false, false],
    ];
    for (const [kind, isMeta, counted] of kinds) {
      const log = [toolResultEntry('u-1', 'tool-1'), queuedEntry('q-1', 'u-1', kind, 'prompt', 'n', isMeta)].join('\n');
      expect([kind, isMeta, typedNotes(log).length]).toEqual([kind, isMeta, counted ? 1 : 0]);
    }
  });

  it('keeps the words of a prompt sent with an image, and says the image is not kept', () => {
    const prompt = [
      { type: 'text', text: 'why duplicates? [Image #2]' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
    ];
    const log = [toolResultEntry('u-1', 'tool-1'), queuedEntry('q-1', 'u-1', 'human', 'prompt', prompt)].join('\n');
    expect(typedNotes(log)).toEqual([{ toolUseId: 'tool-1', prompt: 'why duplicates? [Image #2] [1 image not kept]' }]);
  });

  it('names a submission once when the log holds a copy of it', () => {
    const log = [
      toolResultEntry('u-1', 'tool-1'),
      queuedEntry('q-1', 'u-1', 'human', 'prompt', 'stop after the tests', false, 's-1'),
      queuedEntry('q-2', 'u-1', 'human', 'prompt', 'stop after the tests', false, 's-1'),
    ].join('\n');
    expect(typedNotes(log)).toEqual([{ toolUseId: 'tool-1', prompt: 'stop after the tests' }]);
  });

  it('knows a copy by its delivery id when the log gives no submission id', () => {
    const delivered = (uuid: string, parentUuid: string, delivery: string) =>
      logLine({
        type: 'attachment',
        uuid,
        parentUuid,
        attachment: { type: 'queued_command', prompt: 'Use staging.', commandMode: 'prompt', origin: { kind: 'human' }, delivery_id: delivery },
      });
    const log = [toolResultEntry('u-1', 'tool-1'), delivered('q-1', 'u-1', 'd-1'), delivered('q-2', 'u-1', 'd-1'), delivered('q-3', 'q-2', 'd-2')].join('\n');
    expect(typedNotes(log).map((note) => note.prompt)).toEqual(['Use staging.', 'Use staging.']);
  });

  it('keeps every submission, in order, even when two have the same words', () => {
    const log = [
      toolResultEntry('u-1', 'tool-1'),
      queuedEntry('q-1', 'u-1', 'human', 'prompt', 'Use staging.', false, 's-1'),
      queuedEntry('q-2', 'q-1', 'human', 'prompt', 'Use production.', false, 's-2'),
      queuedEntry('q-3', 'q-2', 'human', 'prompt', 'Use staging.', false, 's-3'),
    ].join('\n');
    expect(typedNotes(log).map((note) => note.prompt)).toEqual(['Use staging.', 'Use production.', 'Use staging.']);
  });

  it('reads only the typed messages the session still holds: after its last compaction, or kept by it', () => {
    const before = [toolResultEntry('u-1', 'tool-1'), queuedEntry('q-1', 'u-1', 'human', 'prompt', 'already handled', false, 's-1')];
    const after = [toolResultEntry('u-2', 'tool-2'), queuedEntry('q-2', 'u-2', 'human', 'prompt', 'still held', false, 's-2')];
    expect(typedNotes([...before, boundaryLine(), ...after].join('\n')).map((n) => n.prompt)).toEqual(['still held']);
    expect(typedNotes([...before, boundaryLine(['q-1']), ...after].join('\n')).map((n) => n.prompt)).toEqual([
      'already handled',
      'still held',
    ]);
  });

  it('skips a typed message with no words', () => {
    const log = [toolResultEntry('u-1', 'tool-1'), queuedEntry('q-1', 'u-1', 'human', 'prompt', '  ')].join('\n');
    expect(typedNotes(log)).toEqual([]);
  });
});

describe('typedNotesByGrep', () => {
  function grepAccess(files: Record<string, string>, runs: (readonly string[])[]) {
    return { process: { run: async (argv: readonly string[]) => (runs.push(argv), fakeGrep(files, argv)) } };
  }

  it('fetches more than 200 parents in batches of 200 and finds every carrier', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 250; i++) {
      lines.push(toolResultEntry(`u-${i}`, `tool-${i}`), queuedEntry(`q-${i}`, `u-${i}`, 'human'));
    }
    const runs: (readonly string[])[] = [];
    const notes = await typedNotesByGrep(grepAccess({ '/log': lines.join('\n') }, runs), '/log');
    expect(notes.length).toBe(250);
    const patternCounts = runs.filter((argv) => !argv.includes('-c')).map((argv) => argv.filter((a) => a === '-e').length);
    // The first grep asks for typed messages and compaction boundaries; the parents come in batches of 200.
    expect(patternCounts).toEqual([2, 200, 50]);
  });

  it('never puts an id with pattern characters into a grep pattern', async () => {
    const lines = [toolResultEntry('a.b', 'tool-1'), queuedEntry('q-1', 'a.b', 'human')];
    const runs: (readonly string[])[] = [];
    const notes = await typedNotesByGrep(grepAccess({ '/log': lines.join('\n') }, runs), '/log');
    expect(notes).toEqual([]);
    expect(runs.some((argv) => argv.some((a) => a.includes('a.b')))).toBe(false);
  });

  it('gives the same notes and words as reading the log whole', async () => {
    const log = [
      toolResultEntry('u-1', 'tool-1'),
      hookAttachment('hook-0', 'u-1'),
      queuedEntry('q-1', 'hook-0', 'human', 'prompt', 'use the staging key'),
      toolResultEntry('u-2', 'tool-2'),
      queuedEntry('q-2', 'u-2', 'task-notification', 'task-notification', 'background job done'),
      queuedEntry('q-3', 'u-2', 'bridge', 'prompt', [{ type: 'text', text: 'from my phone' }]),
      boundaryLine(['q-3']),
      toolResultEntry('u-4', 'tool-4'),
      queuedEntry('q-4', 'u-4', 'human', 'prompt', 'use the staging key', false, 's-4'),
    ].join('\n');
    const notes = await typedNotesByGrep(grepAccess({ '/log': log }, []), '/log');
    expect(notes).toEqual(typedNotes(log));
    expect(notes).toEqual([
      { toolUseId: 'tool-2', prompt: 'from my phone' },
      { toolUseId: 'tool-4', prompt: 'use the staging key' },
    ]);
  });

  it('keeps every submission in order, even when two have the same words', async () => {
    const log = [
      toolResultEntry('u-1', 'tool-1'),
      queuedEntry('q-1', 'u-1', 'human', 'prompt', 'Use staging.', false, 's-1'),
      queuedEntry('q-2', 'q-1', 'human', 'prompt', 'Use production.', false, 's-2'),
      queuedEntry('q-3', 'q-2', 'human', 'prompt', 'Use staging.', false, 's-3'),
    ].join('\n');
    const notes = await typedNotesByGrep(grepAccess({ '/log': log }, []), '/log');
    expect(notes).toEqual(typedNotes(log));
    expect(notes.map((note) => note.prompt)).toEqual(['Use staging.', 'Use production.', 'Use staging.']);
  });

  it('sees a compaction boundary written with spaces or a tab after the colon, as a whole read does', async () => {
    for (const gap of ['  ', '\t']) {
      const log = [
        toolResultEntry('u-1', 'tool-1'),
        queuedEntry('q-1', 'u-1', 'human', 'prompt', 'already handled', false, 's-1'),
        boundaryLine().replace('"subtype":"compact_boundary"', `"subtype":${gap}"compact_boundary"`),
        toolResultEntry('u-2', 'tool-2'),
        queuedEntry('q-2', 'u-2', 'human', 'prompt', 'still held', false, 's-2'),
      ].join('\n');
      const notes = await typedNotesByGrep(grepAccess({ '/log': log }, []), '/log');
      expect(notes).toEqual(typedNotes(log));
      expect(notes.map((note) => note.prompt)).toEqual(['still held']);
    }
  });

  it('does not fetch a line that only holds the value "compact_boundary", so an unfinished one cannot stop the scan', async () => {
    const unfinishedCall = logLine({
      type: 'assistant',
      uuid: 'a-9',
      message: { content: [{ type: 'tool_use', id: 'tool-9', name: 'Grep', input: { value: 'compact_boundary' } }] },
    }).slice(0, -3);
    const log = [toolResultEntry('u-1', 'tool-1'), queuedEntry('q-1', 'u-1', 'human', 'prompt', 'stop', false, 's-1'), unfinishedCall].join('\n');
    const notes = await typedNotesByGrep(grepAccess({ '/log': log }, []), '/log');
    expect(notes).toEqual(typedNotes(log));
    expect(notes).toEqual([{ toolUseId: 'tool-1', prompt: 'stop' }]);
  });

  it('skips a line the log holds unfinished, as a whole read does, when grep printed lines after it', async () => {
    // A write that never finished leaves part of a line, and the next write joins it.
    const unfinished = boundaryLine().slice(0, 50) + queuedEntry('q-0', 'u-1', 'human', 'prompt', 'half written');
    const log = [
      toolResultEntry('u-1', 'tool-1'),
      unfinished,
      toolResultEntry('u-2', 'tool-2'),
      queuedEntry('q-2', 'u-2', 'human', 'prompt', 'stop', false, 's-2'),
    ].join('\n');
    const notes = await typedNotesByGrep(grepAccess({ '/log': log }, []), '/log');
    expect(notes).toEqual(typedNotes(log));
    expect(notes).toEqual([{ toolUseId: 'tool-2', prompt: 'stop' }]);
  });
});

describe('projectDirName', () => {
  it('names the project folder the way Claude Code does', () => {
    expect(projectDirName('/home/rocky00717/rawgentic/projects/rawgentic-suite')).toBe(
      '-home-rocky00717-rawgentic-projects-rawgentic-suite',
    );
    expect(projectDirName('/home/u/a.b/c d')).toBe('-home-u-a-b-c-d');
  });
});

describe('withTypedWords', () => {
  const words = '[message typed while Bash ran]: stop after the tests';
  const note = { toolUseId: 'tool-1', prompt: 'stop after the tests' };

  it('puts the words back where the dropped call was, once', () => {
    const input = transcript();
    const output = [input[0]!, input[5]!, input[6]!];
    const { messages, added } = withTypedWords(input, output, [note]);
    expect(added).toBe(1);
    expect(messages.map((m) => m.text)).toEqual(['Run the slow check, then the tests.', words, 'Both ran.', 'go on']);
    expect(messages[1]).toEqual({ role: 'user', text: words, toolUses: [] });
    expect(messages.filter((m) => m.text === words)).toHaveLength(1);
  });

  it('adds nothing when the call came back as the engine message, which keeps its attachment', () => {
    const input = transcript();
    const { messages, added } = withTypedWords(input, input, [note]);
    expect(added).toBe(0);
    expect(messages).toEqual(input);
  });

  it('adds the words when the call came back rebuilt, without its handle', () => {
    const input = transcript();
    const rebuiltCall = { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'tool-1', tool: 'Bash', input: { command: 'tool-1' }, text: 'cut' }] };
    const rebuiltResult = { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: 'tool-1', text: 'cut', isError: false }] };
    const output = [input[0]!, rebuiltCall, rebuiltResult, input[5]!, input[6]!];
    const { messages } = withTypedWords(input, output, [note]);
    expect(messages.map((m) => m.text)).toEqual(['Run the slow check, then the tests.', '', '', words, 'Both ran.', 'go on']);
  });

  it('puts back every note on one call in order, even when two have the same words', () => {
    const input = transcript();
    const notes = ['Use staging.', 'Use production.', 'Use staging.'].map((prompt) => ({ toolUseId: 'tool-1', prompt }));
    const { messages, added } = withTypedWords(input, [input[0]!, input[5]!, input[6]!], notes);
    expect(added).toBe(3);
    expect(messages.map((m) => m.text)).toEqual([
      'Run the slow check, then the tests.',
      '[message typed while Bash ran]: Use staging.',
      '[message typed while Bash ran]: Use production.',
      '[message typed while Bash ran]: Use staging.',
      'Both ran.',
      'go on',
    ]);
  });

  it('places the words before a kept message that lost its calls and came back as text only', () => {
    const input = [
      message('user', 'Run checks.', { handle: 'h-0' }),
      call('c1', 'Bash', 'a'.repeat(1000)),
      result('c1', 'a'.repeat(1000)),
      message('assistant', 'I am stopping now.', { toolUses: [{ tool_use_id: 'c2', tool: 'Bash', input: {}, text: 'b' }], handle: 'h-3' }),
      result('c2', 'b'.repeat(1000)),
      message('assistant', 'Done.', { handle: 'h-5' }),
    ];
    const textOnly = { role: 'assistant' as const, text: 'I am stopping now.', toolUses: [] };
    const { messages } = withTypedWords(input, [input[0]!, textOnly, input[5]!], [{ toolUseId: 'c1', prompt: 'Stop after the first check.' }]);
    expect(messages.map((m) => m.text)).toEqual([
      'Run checks.',
      '[message typed while Bash ran]: Stop after the first check.',
      'I am stopping now.',
      'Done.',
    ]);
  });

  it('puts the words after every result of that turn, never between a call and its result', () => {
    const input = [
      message('user', 'check both', { handle: 'h-0' }),
      call('tool-1', 'Bash', 'a'),
      call('tool-2', 'Read', 'b'),
      result('tool-1', 'a'),
      result('tool-2', 'b'),
      call('tool-3', 'Bash', 'c'.repeat(500)),
      result('tool-3', 'c'.repeat(500)),
      message('assistant', 'done', { handle: 'h-7' }),
    ];
    const cutCall = { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'tool-3', tool: 'Bash', input: { command: 'tool-3' }, text: 'c' }] };
    const cutResult = { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: 'tool-3', text: 'c', isError: false }] };
    const kept = [input[0]!, input[2]!, input[4]!, cutCall, cutResult, input[7]!];
    const { messages } = withTypedWords(input, [input[0]!, input[2]!, input[4]!, cutCall, cutResult, input[7]!], [note]);
    const at = messages.findIndex((m) => m.text === words);
    expect(messages.slice(0, at)).toEqual(kept.slice(0, 3));
    expect(messages.slice(at + 1)).toEqual(kept.slice(3));
  });

  it('does not mistake a dropped call for a kept message with no text and no calls', () => {
    const input = [
      message('user', 'Run checks.', { handle: 'h-0' }),
      call('c1', 'Bash', 'a'.repeat(1000)),
      result('c1', 'a'.repeat(1000)),
      message('assistant', '', { handle: 'h-3' }),
      message('assistant', 'Done.', { handle: 'h-4' }),
    ];
    const { messages } = withTypedWords(input, [input[0]!, input[3]!, input[4]!], [{ toolUseId: 'c1', prompt: 'stop' }]);
    expect(messages).toEqual([input[0], { role: 'user', text: '[message typed while Bash ran]: stop', toolUses: [] }, input[3], input[4]]);
  });

  it('puts the words at the end when nothing after the call was kept', () => {
    const input = transcript();
    const { messages } = withTypedWords(input, [input[0]!], [note]);
    expect(messages.map((m) => m.text)).toEqual(['Run the slow check, then the tests.', words]);
  });

  it('skips a typed message whose call is not in this compaction', () => {
    const input = transcript();
    const { added } = withTypedWords(input, [input[0]!], [{ toolUseId: 'tool-9', prompt: 'old' }]);
    expect(added).toBe(0);
  });
});

describe('withTypedWords after an old reply is shortened to reach the minimum', () => {
  const config = { apiKey: 'k', model: 'm', compactAtPercent: 60, minReductionRatio: 0.25, preserveRecentMessages: 1 };
  const words = '[message typed while Bash ran]: Use staging.';
  const note = { toolUseId: 'c1', prompt: 'Use staging.' };

  function withLongReply(): SessionMessage[] {
    return [
      message('user', 'Run tests.', { handle: 'h-0' }),
      message('assistant', 'a'.repeat(10_000), { handle: 'h-1' }),
      call('c1', 'Bash', 'ok'),
      result('c1', 'ok'),
      message('assistant', 'Done.', { handle: 'h-4' }),
      message('user', 'Continue.', { handle: 'h-5' }),
    ];
  }

  it('does not copy the words when the call it arrived with came back as the engine message', async () => {
    const input = withLongReply();
    const { result: compacted, messages: output } = await compactSession(input, config, jevFetch(0.9));
    expect(compacted.stats.textsShortened).toBe(1);
    expect(output[3]).toBe(input[3]);
    const { messages, added } = withTypedWords(input, output, [note], compacted.origins);
    expect(added).toBe(0);
    expect(messages).toEqual(output);
  });

  it('puts the words before the next kept message, not at the end', async () => {
    const input = withLongReply();
    const { result: compacted, messages: output } = await compactSession(input, config, jevFetch(0.1));
    expect(compacted.stats.textsShortened).toBe(1);
    expect(output.map((m) => m.text.slice(0, 4))).toEqual(['Run ', 'aaaa', 'Done', 'Cont']);
    const { messages, added } = withTypedWords(input, output, [note], compacted.origins);
    expect(added).toBe(1);
    expect(messages.map((m) => m.text.slice(0, 4))).toEqual(['Run ', 'aaaa', '[mes', 'Done', 'Cont']);
    expect(messages[2]!.text).toBe(words);
  });
});

type Handler = (fake: unknown, event: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;

type HarnessOptions = {
  failRead?: boolean;
  /** Reported sizes that override the text length, to stand for a log over 4 MiB. */
  sizes?: Record<string, number>;
  mtimes?: Record<string, number>;
  /** Folders under ~/.claude/projects that the scan lists. */
  dirs?: string[];
  failProcess?: boolean;
  /** What the fake process returns instead of grep's answer: one result for every run, or one per argv. */
  processResult?:
    | { exitCode: number; stdout: string; stderr: string }
    | ((argv: readonly string[]) => { exitCode: number; stdout: string; stderr: string });
  /** Environment values the fake engine returns. */
  env?: Record<string, string>;
};

/** grep -E -e P1 -e P2 … FILE, as the hook runs it: exit 0 with matches, 1 with none. */
function fakeGrep(files: Record<string, string>, argv: readonly string[]) {
  const patterns: RegExp[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '-e') patterns.push(new RegExp(argv[++i]!));
  const file = argv[argv.length - 1]!;
  const lines = (files[file] ?? '').split('\n').filter((line) => patterns.some((p) => p.test(line)));
  if (argv.includes('-c')) return { exitCode: lines.length > 0 ? 0 : 1, stdout: `${lines.length}\n`, stderr: '' };
  return { exitCode: lines.length > 0 ? 0 : 1, stdout: lines.map((l) => `${l}\n`).join(''), stderr: '' };
}

function hookHarness(files: Record<string, string>, failReadOrOptions: boolean | HarnessOptions = false) {
  const opts: HarnessOptions = typeof failReadOrOptions === 'boolean' ? { failRead: failReadOrOptions } : failReadOrOptions;
  const failRead = opts.failRead ?? false;
  const reads: string[] = [];
  const runs: (readonly string[])[] = [];
  const handlers: Record<string, Handler> = {};
  const on = (name: string, a: unknown, b?: unknown) => {
    handlers[name] = (typeof a === 'function' ? a : b) as Handler;
  };
  register(on as never, { preserveRecentMessages: 1, apiKey: 'k' });
  const logs: string[] = [];
  const fetch = jevFetch(0.05);
  const fake = {
    env: { get: async (name: string) => (name in (opts.env ?? {}) ? opts.env![name] : name === 'HOME' ? '/home/u' : undefined) },
    settings: { read: async () => ({}) },
    http: { fetch },
    ui: { log: (text: string) => logs.push(text), toast: () => undefined },
    session: { id: async () => 'sess-1', cwd: async () => '/home/u/proj' },
    fs: {
      exists: async (path: string) => path in files,
      read: async (path: string) => {
        reads.push(path);
        if (failRead) throw new Error('read failed');
        if (!(path in files)) throw new Error(`missing ${path}`);
        if ((opts.sizes?.[path] ?? 0) > 4 * 1024 * 1024) throw new Error('read over 4 MiB');
        return files[path]!;
      },
      stat: async (path: string) => {
        if (!(path in files)) throw new Error(`missing ${path}`);
        return { kind: 'file', size: opts.sizes?.[path] ?? files[path]!.length, mtimeMs: opts.mtimes?.[path] ?? 0 };
      },
      list: async () => (opts.dirs ?? []).map((name) => ({ name, kind: 'dir' })),
    },
    process: {
      run: async (argv: readonly string[]) => {
        runs.push(argv);
        if (opts.failProcess) throw new Error('grep not found');
        const override = opts.processResult;
        if (typeof override === 'function') return override(argv);
        return override ?? fakeGrep(files, argv);
      },
    },
  };
  return { handler: handlers['session.compact']!, fake, logs, reads, runs };
}

describe('the session.compact hook', () => {
  const logPath = '/home/u/.claude/projects/-home-u-proj/sess-1.jsonl';
  const log = [toolResultEntry('u-1', 'tool-1'), queuedEntry('q-1', 'u-1', 'human', 'prompt', 'do not merge #244')].join('\n');

  it('keeps the words of a message typed while a dropped call ran, read from the session log', async () => {
    const { handler, fake, logs } = hookHarness({ [logPath]: log });
    const out = (await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }))) as {
      messages: SessionMessage[];
    };
    expect(out.messages.map((m) => [m.handle, m.text])).toEqual([['h-0', 'Run the slow check, then the tests.'], [undefined, '[message typed while Bash ran]: do not merge #244'], ['h-5', 'Both ran.'], ['h-6', 'go on']]);
    expect(logs.some((line) => line.includes('kept 1 typed message(s) as text'))).toBe(true);
  });

  it('compacts as before when the session log cannot be read', async () => {
    const { handler, fake, logs } = hookHarness({ [logPath]: log }, true);
    const out = (await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }))) as {
      messages: SessionMessage[];
    };
    expect(out.messages.map((m) => m.handle)).toEqual(['h-0', 'h-5', 'h-6']);
    expect(logs.some((line) => line.includes('could not read the session log'))).toBe(true);
  });

  it('scans a log over 4 MiB with grep instead of reading it whole', async () => {
    const { handler, fake, logs, reads, runs } = hookHarness({ [logPath]: log }, { sizes: { [logPath]: 137_000_000 } });
    const out = (await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }))) as {
      messages: SessionMessage[];
    };
    expect(out.messages.map((m) => [m.handle, m.text])).toEqual([['h-0', 'Run the slow check, then the tests.'], [undefined, '[message typed while Bash ran]: do not merge #244'], ['h-5', 'Both ran.'], ['h-6', 'go on']]);
    expect(reads).not.toContain(logPath);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((argv) => argv[0] === 'grep' && argv.at(-1) === logPath)).toBe(true);
    expect(logs.some((line) => line.includes('kept 1 typed message(s) as text'))).toBe(true);
  });

  it('follows a chain of attachments when it scans a large log with grep', async () => {
    const chained = [toolResultEntry('u-1', 'tool-1'), hookAttachment('hook-0', 'u-1'), hookAttachment('hook-1', 'hook-0'), queuedEntry('q-1', 'hook-1', 'human')].join('\n');
    const { handler, fake, runs } = hookHarness({ [logPath]: chained }, { sizes: { [logPath]: 137_000_000 } });
    const out = (await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }))) as {
      messages: SessionMessage[];
    };
    expect(out.messages.map((m) => [m.handle, m.text])).toEqual([['h-0', 'Run the slow check, then the tests.'], [undefined, '[message typed while Bash ran]: note'], ['h-5', 'Both ran.'], ['h-6', 'go on']]);
    expect(runs.filter((argv) => !argv.includes('-c')).length).toBe(4);
    expect(runs.filter((argv) => argv.includes('-c')).length).toBe(4);
  });

  it('says plainly that typed messages are not protected when a large log cannot be scanned', async () => {
    const { handler, fake, logs } = hookHarness({ [logPath]: log }, { sizes: { [logPath]: 137_000_000 }, failProcess: true });
    const out = (await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }))) as {
      messages: SessionMessage[];
    };
    expect(out.messages.map((m) => m.handle)).toEqual(['h-0', 'h-5', 'h-6']);
    expect(logs.some((line) => line.includes('typed messages are not protected'))).toBe(true);
  });

  it('says plainly that typed messages are not protected when the session log is not found', async () => {
    const { handler, fake, logs } = hookHarness({});
    await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }));
    expect(logs.some((line) => line.includes('could not find the session log') && line.includes('not protected'))).toBe(true);
  });

  it('takes the newest of two same-named logs in other project folders, and says so', async () => {
    const older = '/home/u/.claude/projects/-old/sess-1.jsonl';
    const newer = '/home/u/.claude/projects/-new/sess-1.jsonl';
    const { handler, fake, logs } = hookHarness(
      { [older]: 'not a log', [newer]: log },
      { dirs: ['-old', '-new'], mtimes: { [older]: 1, [newer]: 2 } },
    );
    const out = (await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }))) as {
      messages: SessionMessage[];
    };
    expect(out.messages.map((m) => [m.handle, m.text])).toEqual([['h-0', 'Run the slow check, then the tests.'], [undefined, '[message typed while Bash ran]: do not merge #244'], ['h-5', 'Both ran.'], ['h-6', 'go on']]);
    expect(logs.some((line) => line.includes('2 session logs named sess-1.jsonl'))).toBe(true);
  });

  it('does not put words back again for a typed message an earlier compaction already handled', async () => {
    const handled = [toolResultEntry('u-1', 'tool-1'), queuedEntry('q-1', 'u-1', 'human', 'prompt', 'do not merge #244', false, 's-1'), boundaryLine()].join('\n');
    const { handler, fake, logs } = hookHarness({ [logPath]: handled });
    const out = (await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }))) as {
      messages: SessionMessage[];
    };
    expect(out.messages.map((m) => m.handle)).toEqual(['h-0', 'h-5', 'h-6']);
    expect(logs.some((line) => line.includes('typed message(s) as text'))).toBe(false);
  });

  it('falls back to the built-in summary without adding words when the reduction misses the minimum', async () => {
    const messages = [message('user', 'go', { handle: 'h-0' }), call('tool-1', 'Bash', ''), result('tool-1', '')];
    const { handler, fake, logs } = hookHarness({ [logPath]: log });
    const out = await handler(fake, { trigger: 'auto', messages }, async () => ({ skip: 'next' }));
    expect(out).toEqual({ skip: 'next' });
    expect(logs.some((line) => line.includes('fallback to built-in summary'))).toBe(true);
    expect(logs.some((line) => line.includes('typed message(s) as text'))).toBe(false);
  });

  it('does not trust grep output that was cut at the output limit', async () => {
    const cut = logLine({ type: 'attachment', uuid: 'q-1', parentUuid: 'u-1', attachment: { type: 'queued_command' } }).slice(0, 40);
    const { handler, fake, logs } = hookHarness(
      { [logPath]: log },
      { sizes: { [logPath]: 137_000_000 }, processResult: (argv) => (argv.includes('-c') ? { exitCode: 0, stdout: '1\n', stderr: '' } : { exitCode: 0, stdout: cut, stderr: '' }) },
    );
    await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }));
    expect(logs.some((line) => line.includes('typed messages are not protected'))).toBe(true);
  });

  it('does not trust grep output whose last line lacks its newline, even when that line parses', async () => {
    const note = queuedEntry('q-1', 'u-1', 'human');
    const { handler, fake, logs } = hookHarness(
      { [logPath]: log },
      { sizes: { [logPath]: 137_000_000 }, processResult: (argv) => (argv.includes('-c') ? { exitCode: 0, stdout: '2\n', stderr: '' } : { exitCode: 0, stdout: `${note}\n${note}`, stderr: '' }) },
    );
    await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }));
    expect(logs.some((line) => line.includes('cut at the output limit') && line.includes('not protected'))).toBe(true);
  });

  it('does not trust a grep line that is not JSON, even when the output ends in a newline', async () => {
    const { handler, fake, logs } = hookHarness(
      { [logPath]: log },
      { sizes: { [logPath]: 137_000_000 }, processResult: (argv) => (argv.includes('-c') ? { exitCode: 0, stdout: '1\n', stderr: '' } : { exitCode: 0, stdout: '{"type":"attach\n', stderr: '' }) },
    );
    await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }));
    expect(logs.some((line) => line.includes('not JSON') && line.includes('not protected'))).toBe(true);
  });

  it('does not read exit 1 with output as "no match"', async () => {
    const { handler, fake, logs } = hookHarness(
      { [logPath]: log },
      { sizes: { [logPath]: 137_000_000 }, processResult: (argv) => (argv.includes('-c') ? { exitCode: 0, stdout: '2\n', stderr: '' } : { exitCode: 1, stdout: `${log}\n`, stderr: '' }) },
    );
    await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }));
    expect(logs.some((line) => line.includes('typed messages are not protected'))).toBe(true);
  });

  it('finds a parent written with a space after the colon', async () => {
    const spaced = [toolResultEntry('u-1', 'tool-1').replace('"uuid":"u-1"', '"uuid": "u-1"'), queuedEntry('q-1', 'u-1', 'human')].join('\n');
    const { handler, fake } = hookHarness({ [logPath]: spaced }, { sizes: { [logPath]: 137_000_000 } });
    const out = (await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }))) as {
      messages: SessionMessage[];
    };
    expect(out.messages.map((m) => [m.handle, m.text])).toEqual([['h-0', 'Run the slow check, then the tests.'], [undefined, '[message typed while Bash ran]: note'], ['h-5', 'Both ran.'], ['h-6', 'go on']]);
  });

  it('does not trust grep output that holds fewer lines than grep -c counted', async () => {
    const note = queuedEntry('q-1', 'u-1', 'human');
    const { handler, fake, logs } = hookHarness(
      { [logPath]: log },
      {
        sizes: { [logPath]: 137_000_000 },
        processResult: (argv) =>
          argv.includes('-c') ? { exitCode: 0, stdout: '3\n', stderr: '' } : { exitCode: 0, stdout: `${note}\n`, stderr: '' },
      },
    );
    await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }));
    expect(logs.some((line) => line.includes('returned 1 of 3') && line.includes('not protected'))).toBe(true);
  });

  it('does not read a returned grep exit 2 as an answer', async () => {
    const { handler, fake, logs } = hookHarness(
      { [logPath]: log },
      { sizes: { [logPath]: 137_000_000 }, processResult: { exitCode: 2, stdout: '', stderr: 'grep: bad' } },
    );
    await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }));
    expect(logs.some((line) => line.includes('exited 2') && line.includes('not protected'))).toBe(true);
  });

  it('does not trust a grep -c count that came with exit 2', async () => {
    const { handler, fake, logs } = hookHarness(
      { [logPath]: log },
      {
        sizes: { [logPath]: 137_000_000 },
        processResult: (argv) =>
          argv.includes('-c') ? { exitCode: 2, stdout: '1\n', stderr: 'grep: read error' } : fakeGrep({ [logPath]: log }, argv),
      },
    );
    await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }));
    expect(logs.some((line) => line.includes('grep -c exited 2') && line.includes('not protected'))).toBe(true);
  });

  it('finds the session log under HOME when CLAUDE_CONFIG_DIR is set but empty', async () => {
    const { handler, fake } = hookHarness({ [logPath]: log }, { env: { CLAUDE_CONFIG_DIR: '' } });
    const out = (await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }))) as {
      messages: SessionMessage[];
    };
    expect(out.messages.map((m) => [m.handle, m.text])).toEqual([['h-0', 'Run the slow check, then the tests.'], [undefined, '[message typed while Bash ran]: do not merge #244'], ['h-5', 'Both ran.'], ['h-6', 'go on']]);
  });

  it('leaves a subagent compaction alone', async () => {
    const { handler, fake } = hookHarness({ [logPath]: log });
    const out = (await handler(
      fake,
      { trigger: 'auto', agentId: 'agent-1', messages: transcript() },
      async () => ({ skip: 'next' }),
    )) as { messages: SessionMessage[] };
    expect(out.messages.map((m) => m.handle)).toEqual(['h-0', 'h-5', 'h-6']);
  });

  it('logs the input counts first, before it reads the session log or asks Jev, in a subagent too', async () => {
    const feedback = (): SessionMessage[] => [
      message('user', 'Stop hook feedback:\n[goal text]: Not satisfied. reason'),
      message('user', 'Fix the failing test.'),
      message('assistant', 'Running the tests.', {
        toolUses: [{ tool_use_id: 'tool-1', tool: 'Bash', input: { command: 'npm test' }, text: 'FAIL b.test.ts' }],
      }),
      message('user', '', { toolResults: [{ tool_use_id: 'tool-1', text: 'FAIL b.test.ts: expected 2 to be 3', isError: true }] }),
      message('assistant', 'Fixing now.'),
    ];
    for (const agentId of [undefined, 'agent-1']) {
      const { handler, fake, logs, reads } = hookHarness({ [logPath]: log });
      let asked = 0;
      const seen: { reads: number; asked: number }[] = [];
      const watched = {
        ...fake,
        http: { fetch: async (url: string, init?: { body?: string }) => ((asked += 1), fake.http.fetch(url, init)) },
        ui: { ...fake.ui, log: (text: string) => (seen.push({ reads: reads.length, asked }), fake.ui.log(text)) },
      };
      await handler(watched, { trigger: 'auto', agentId, messages: feedback() }, async () => ({ skip: 'next' }));
      expect(logs[0]).toBe(
        'input: 5 messages (3 user, 2 assistant), 160 chars: user text 75 (1 Stop hook feedback copies, 54 chars), assistant text 29, tool input 22, tool output 34; tool-use mirrors 14 chars, not counted',
      );
      expect(seen[0]).toEqual({ reads: 0, asked: 0 });
      expect(asked).toBeGreaterThan(0);
      expect(logs.filter((line) => line.startsWith('input: '))).toHaveLength(1);
    }
  });
});
