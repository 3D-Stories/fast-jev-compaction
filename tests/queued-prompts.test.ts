import { describe, expect, it } from 'vitest';
import {
  compactSession,
  pinnedForQueuedPrompts,
  projectDirName,
  queuedPromptToolUseIds,
  register,
  resolveHookConfig,
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
  prompt = 'note',
  isMeta = false,
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
    },
  });
}

function hookAttachment(uuid: string, parentUuid: string): string {
  return logLine({ type: 'attachment', uuid, parentUuid, attachment: { type: 'hook_success' } });
}

describe('queuedPromptToolUseIds', () => {
  it('finds the tool call whose result carries a message typed while it ran', () => {
    const log = [toolResultEntry('u-1', 'tool-1'), queuedEntry('q-1', 'u-1', 'human', 'prompt', 'send it to w74:p7F')].join('\n');
    expect([...queuedPromptToolUseIds(log)]).toEqual(['tool-1']);
  });

  it('walks up through other attachments to the tool result', () => {
    const log = [
      toolResultEntry('u-1', 'tool-1'),
      logLine({ type: 'attachment', uuid: 'hook-1', parentUuid: 'u-1', attachment: { type: 'hook_success' } }),
      queuedEntry('q-1', 'hook-1', 'human'),
    ].join('\n');
    expect([...queuedPromptToolUseIds(log)]).toEqual(['tool-1']);
  });

  it('ignores what the engine queues itself: task notifications, auto-continuations and observer digests', () => {
    const log = [
      toolResultEntry('u-1', 'tool-1'),
      queuedEntry('q-1', 'u-1', 'task-notification', 'task-notification'),
      queuedEntry('q-2', 'u-1', 'auto-continuation'),
      queuedEntry('q-3', 'u-1', 'observer-activity'),
    ].join('\n');
    expect(queuedPromptToolUseIds(log).size).toBe(0);
  });

  it('finds nothing for a message delivered as its own turn, and skips lines it cannot parse', () => {
    const log = [
      logLine({ type: 'user', uuid: 'p-1', parentUuid: null, message: { role: 'user', content: 'hello' } }),
      queuedEntry('q-1', 'p-1', 'human'),
      '{not json',
      '',
    ].join('\n');
    expect(queuedPromptToolUseIds(log).size).toBe(0);
  });

  it('walks any number of attachments up to the tool result', () => {
    const chain = Array.from({ length: 12 }, (_, i) => hookAttachment(`hook-${i}`, i === 0 ? 'u-1' : `hook-${i - 1}`));
    const log = [toolResultEntry('u-1', 'tool-1'), ...chain, queuedEntry('q-1', 'hook-11', 'human')].join('\n');
    expect([...queuedPromptToolUseIds(log)]).toEqual(['tool-1']);
  });

  it('stops on a parent cycle without pinning anything', () => {
    const log = [hookAttachment('hook-a', 'hook-b'), hookAttachment('hook-b', 'hook-a'), queuedEntry('q-1', 'hook-a', 'human')].join('\n');
    expect(queuedPromptToolUseIds(log).size).toBe(0);
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
      expect([kind, isMeta, queuedPromptToolUseIds(log).size]).toEqual([kind, isMeta, counted ? 1 : 0]);
    }
  });
});

describe('pinnedForQueuedPrompts', () => {
  it('names every call answered in the message that carries the typed message', () => {
    const messages = [
      call('tool-1', 'Bash', 'a'),
      message('user', '', {
        toolResults: [
          { tool_use_id: 'tool-1', text: 'a', isError: false },
          { tool_use_id: 'tool-9', text: 'b', isError: false },
        ],
      }),
      result('tool-2', 'c'),
    ];
    expect(pinnedForQueuedPrompts(messages, new Set(['tool-1']))).toEqual(['tool-1', 'tool-9']);
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

describe('compactSession with pinToolUseIds', () => {
  it('keeps a named call and its result as the engine objects, handles included, even when Jev would drop it', async () => {
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), apiKey: 'k', pinToolUseIds: ['tool-1'] };
    const { result: output, messages } = await compactSession(transcript(), config, jevFetch(0.05));
    expect(messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-1', 'r-tool-1', 'h-5', 'h-6']);
    expect(output.decisions.map((d) => d.reason)).toEqual(['pinned', 'call_dropped']);
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
};

/** grep -F -e P1 -e P2 … FILE, as the hook runs it: exit 0 with matches, 1 with none. */
function fakeGrep(files: Record<string, string>, argv: readonly string[]) {
  const patterns: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '-e') patterns.push(argv[++i]!);
  const file = argv[argv.length - 1]!;
  const lines = (files[file] ?? '').split('\n').filter((line) => patterns.some((p) => line.includes(p)));
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
    env: { get: async (name: string) => (name === 'HOME' ? '/home/u' : undefined) },
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
        return fakeGrep(files, argv);
      },
    },
  };
  return { handler: handlers['session.compact']!, fake, logs, reads, runs };
}

describe('the session.compact hook', () => {
  const logPath = '/home/u/.claude/projects/-home-u-proj/sess-1.jsonl';
  const log = [toolResultEntry('u-1', 'tool-1'), queuedEntry('q-1', 'u-1', 'human', 'prompt', 'do not merge #244')].join('\n');

  it('keeps the call whose result carries a typed message, read from the session log', async () => {
    const { handler, fake, logs } = hookHarness({ [logPath]: log });
    const out = (await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }))) as {
      messages: SessionMessage[];
    };
    expect(out.messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-1', 'r-tool-1', 'h-5', 'h-6']);
    expect(logs.some((line) => line.includes('1 tool call(s) that carry a message typed while they ran'))).toBe(true);
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
    expect(out.messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-1', 'r-tool-1', 'h-5', 'h-6']);
    expect(reads).not.toContain(logPath);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((argv) => argv[0] === 'grep' && argv.at(-1) === logPath)).toBe(true);
    expect(logs.some((line) => line.includes('1 tool call(s) that carry a message typed while they ran'))).toBe(true);
  });

  it('follows a chain of attachments when it scans a large log with grep', async () => {
    const chained = [toolResultEntry('u-1', 'tool-1'), hookAttachment('hook-0', 'u-1'), hookAttachment('hook-1', 'hook-0'), queuedEntry('q-1', 'hook-1', 'human')].join('\n');
    const { handler, fake, runs } = hookHarness({ [logPath]: chained }, { sizes: { [logPath]: 137_000_000 } });
    const out = (await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }))) as {
      messages: SessionMessage[];
    };
    expect(out.messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-1', 'r-tool-1', 'h-5', 'h-6']);
    expect(runs.length).toBe(4);
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
    expect(out.messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-1', 'r-tool-1', 'h-5', 'h-6']);
    expect(logs.some((line) => line.includes('2 session logs named sess-1.jsonl'))).toBe(true);
  });

  it('names the size of the kept calls when the reduction misses the minimum', async () => {
    const big = [toolResultEntry('u-2', 'tool-2'), queuedEntry('q-2', 'u-2', 'human')].join('\n');
    const { handler, fake, logs } = hookHarness({ [logPath]: big });
    const out = await handler(fake, { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'next' }));
    expect(out).toEqual({ skip: 'next' });
    expect(logs.some((line) => line.includes('fallback to built-in summary') && line.includes('kept for typed messages: 400 chars'))).toBe(true);
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
});
