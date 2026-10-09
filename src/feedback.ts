import type { Message } from './types.js';

/**
 * How Claude Code starts the message it sends back when a Stop hook (such as
 * an unmet `/goal`) blocks a stop: `Stop hook feedback:`, any whitespace, then
 * `[`. Anchored at the very start of the text, with no trimming, so an
 * indented, quoted or mid-text mention does not match.
 */
export const STOP_HOOK_FEEDBACK_PREFIX = /^Stop hook feedback:\s*\[/;

/** Whether a message is a Stop hook feedback copy: a plain user message whose text starts with the prefix. */
export function isStopHookFeedback(message: Message): boolean {
  return (
    message.role === 'user' &&
    message.toolUses.length === 0 &&
    (message.toolResults ?? []).length === 0 &&
    STOP_HOOK_FEEDBACK_PREFIX.test(message.text)
  );
}
