import { describe, expect, it } from 'vitest';
import { fallbackNotice } from '../hooks/fast-jev.ts';
import { reductionRatio, type CompactResult } from '../src/index.js';

function resultOf(charsBefore: number, charsAfter: number): CompactResult {
  return {
    messages: [],
    origins: [],
    decisions: [],
    stats: {
      messagesBefore: 0,
      messagesAfter: 0,
      charsBefore,
      charsAfter,
      calls: 0,
      kept: 0,
      resultsDropped: 0,
      callsDropped: 0,
      pinned: 0,
      inputsShortened: 0,
      textsShortened: 0,
      stateTokens: 0,
      stateStage: 'full',
      requests: 0,
      ms: 0,
    },
  };
}

const NOTICE = /^fallback to built-in summary \(below (-?\d+)% minimum: (-?\d+)% reduction; /;

const minimums = [...Array.from({ length: 99 }, (_, i) => (i + 1) / 100), 0.25, 0.2549, 1 / 3];
const sizes = [
  ...Array.from({ length: 40 }, (_, i) => 100 + i * 37),
  997, 1_000, 1_001, 4_096, 9_999, 10_007, 13_834, 65_536, 123_457, 999_983, 1_000_000, 3_141_593, 12_345_678,
];

describe('fallbackNotice', () => {
  it('always prints the reduction below the minimum it missed, for the 200 ratios closest under each minimum', () => {
    let checked = 0;
    for (const minimum of minimums) {
      for (const charsBefore of sizes) {
        // The fewest chars left that still fail the hook's gate (`reductionRatio < minimum`).
        let first = Math.floor(charsBefore * (1 - minimum)) - 2;
        while (reductionRatio(resultOf(charsBefore, first)) >= minimum) first++;
        for (let charsAfter = first; charsAfter < first + 200 && charsAfter <= charsBefore; charsAfter++) {
          const result = resultOf(charsBefore, charsAfter);
          const notice = fallbackNotice(result, minimum);
          const match = NOTICE.exec(notice);
          if (!(reductionRatio(result) < minimum) || !match || !(Number(match[2]) < Number(match[1]))) {
            expect.fail(`charsBefore ${charsBefore}, charsAfter ${charsAfter}, minimum ${minimum}: ${notice}`);
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100_000);
  });

  it('prints the minimum as before and a reduction well below it unchanged', () => {
    expect(fallbackNotice(resultOf(10_000, 8_400), 0.25)).toMatch(/^fallback to built-in summary \(below 25% minimum: 16% reduction; /);
  });
});
