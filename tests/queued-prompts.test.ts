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

function queuedEntry(uuid: string, parentUuid: string, kind: string, mode = 'prompt', prompt = 'note'): string {
  return logLine({
    type: 'attachment',
    uuid,
    parentUuid,
    attachment: { type: 'queued_command', prompt, commandMode: mode, origin: { kind } },
  });
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
      queuedEntry('q-1', 'hook-1', 'peer'),
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

function hookHarness(files: Record<string, string>, failRead = false) {
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
        if (failRead) throw new Error('read failed');
        if (!(path in files)) throw new Error(`missing ${path}`);
        return files[path]!;
      },
      list: async () => [],
    },
  };
  return { handler: handlers['session.compact']!, fake, logs };
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
