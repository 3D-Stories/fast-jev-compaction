import { describe, expect, it } from 'vitest';
import { inputBreakdown, inputLine } from '../hooks/fast-jev.ts';
import { isStopHookFeedback, STOP_HOOK_FEEDBACK_PREFIX } from '../src/feedback.js';
import { messageChars, type Message } from '../src/index.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

/** A Stop hook feedback copy, a typed prompt, assistant text, and one call with its result and `text` mirror. */
function transcript(): Message[] {
  return [
    message('user', 'Stop hook feedback:\n[goal text]: Not satisfied. reason'),
    message('user', 'Fix the failing test.'),
    message('assistant', 'Running the tests.', {
      toolUses: [{ tool_use_id: 'tool-1', tool: 'Bash', input: { command: 'npm test' }, text: 'FAIL b.test.ts' }],
    }),
    message('user', '', { toolResults: [{ tool_use_id: 'tool-1', text: 'FAIL b.test.ts: expected 2 to be 3', isError: true }] }),
    message('assistant', 'Fixing now.'),
  ];
}

describe('isStopHookFeedback', () => {
  it.each([
    ['a space', 'Stop hook feedback: [goal]: not met'],
    ['a newline', 'Stop hook feedback:\n[goal]: not met'],
    ['a tab', 'Stop hook feedback:\t[goal]: not met'],
    ['no whitespace', 'Stop hook feedback:[goal]: not met'],
  ])('accepts the prefix with %s before the bracket', (_, text) => {
    expect(isStopHookFeedback(message('user', text))).toBe(true);
  });

  it.each([
    ['indented', '  Stop hook feedback: [goal]: not met'],
    ['quoted with >', '> Stop hook feedback: [goal]: not met'],
    ['in quotation marks', '"Stop hook feedback: [goal]: not met"'],
    ['mid-text', 'I saw Stop hook feedback: [goal]: not met'],
    ['without a bracket', 'Stop hook feedback: the goal is not met'],
  ])('rejects text %s', (_, text) => {
    expect(isStopHookFeedback(message('user', text))).toBe(false);
  });

  it('rejects an assistant message', () => {
    expect(isStopHookFeedback(message('assistant', 'Stop hook feedback:\n[goal]: not met'))).toBe(false);
  });

  it('rejects a user message with a tool result', () => {
    const carrier = message('user', 'Stop hook feedback:\n[goal]: not met', {
      toolResults: [{ tool_use_id: 'tool-1', text: 'done' }],
    });
    expect(isStopHookFeedback(carrier)).toBe(false);
  });

  it('rejects a message with a tool use', () => {
    const caller = message('user', 'Stop hook feedback:\n[goal]: not met', {
      toolUses: [{ tool_use_id: 'tool-1', tool: 'Bash', input: {} }],
    });
    expect(isStopHookFeedback(caller)).toBe(false);
  });

  it('anchors the prefix at the very start', () => {
    expect(STOP_HOOK_FEEDBACK_PREFIX.test('x\nStop hook feedback: [goal]: not met')).toBe(false);
  });
});

describe('inputBreakdown', () => {
  it('counts messages and chars by kind, with the feedback copies inside the user text', () => {
    expect(inputBreakdown(transcript())).toEqual({
      messages: 5,
      userMessages: 3,
      assistantMessages: 2,
      chars: 160,
      userText: 75,
      feedbackCopies: 1,
      feedbackChars: 54,
      assistantText: 29,
      toolInput: 22,
      toolOutput: 34,
      toolUseMirrors: 14,
    });
  });

  it('totals exactly what messageChars counts, so the mirrors stay out', () => {
    const messages = transcript();
    const breakdown = inputBreakdown(messages);
    const sum = messages.reduce((total, m) => total + messageChars(m), 0);
    expect(breakdown.chars).toBe(sum);
    expect(breakdown.userText + breakdown.assistantText + breakdown.toolInput + breakdown.toolOutput).toBe(sum);
  });

  it('counts a tool input JSON cannot write as 20 chars, as messageChars does', () => {
    const messages = [message('assistant', '', { toolUses: [{ tool_use_id: 'tool-1', tool: 'X', input: { n: 1n } }] })];
    expect(inputBreakdown(messages).toolInput).toBe(20);
    expect(inputBreakdown(messages).chars).toBe(messageChars(messages[0]!));
  });

  it('counts nothing for no messages', () => {
    expect(inputLine(inputBreakdown([]))).toBe(
      'input: 0 messages (0 user, 0 assistant), 0 chars: user text 0 (0 Stop hook feedback copies, 0 chars), assistant text 0, tool input 0, tool output 0; tool-use mirrors 0 chars, not counted',
    );
  });
});

describe('inputLine', () => {
  it('states the counts and nothing else', () => {
    const line = inputLine(inputBreakdown(transcript()));
    expect(line).toBe(
      'input: 5 messages (3 user, 2 assistant), 160 chars: user text 75 (1 Stop hook feedback copies, 54 chars), assistant text 29, tool input 22, tool output 34; tool-use mirrors 14 chars, not counted',
    );
    for (const words of ['goal text', 'Not satisfied', 'Fix the failing', 'npm test', 'expected 2']) {
      expect(line).not.toContain(words);
    }
  });
});
