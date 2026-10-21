# Issue 20: cutting and saving old tool outputs, replayed on real compactions

Run on 2026-10-21 (UTC) over the compactions of 2026-10-17 to 2026-10-20 (UTC days), on one host's session logs, with:

```
npm run replay -- --since 2026-10-17 --until 2026-10-20 --out docs/replay/issue-20-cut-and-save.md
```

Every rule ran on the same 200 points: a seeded (seed 20), session-stratified sample of 200 of the 894 points that passed every check below (sample size asked: 200; the run stops under 100).
No Jev request was made: `main` is answered by the scores the hook logged.

## Results

| Rule | Points | Freed, median | Freed, mean | Freed, p10 | Below 25% | Later-needed outputs | Usable outputs |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `main` | 200 | 49.2% | 54.3% | 28.0% | 4 | 1,619 | 24 (1.5%) |
| `cut-jev@0.30` | 200 | 25.4% | 25.6% | 16.6% | 72 | 1,619 | 700 (43.2%) |
| `cut-jev@0.45` | 200 | 25.4% | 27.0% | 16.6% | 72 | 1,619 | 679 (41.9%) |
| `cut-newest@0.30` | 200 | 25.4% | 25.6% | 16.6% | 72 | 1,619 | 701 (43.3%) |
| `cut-newest@0.45` | 200 | 25.4% | 27.1% | 16.6% | 72 | 1,619 | 678 (41.9%) |
| `cut-all` | 200 | 25.4% | 27.7% | 16.6% | 72 | 1,619 | 671 (41.4%) |

"Freed" is the share of the window's chars (as the hook counts them) the rule removes, whether or not it reaches 25%. Below 25% the hook falls back to the built-in summary, so none of that point's outputs count as usable.

## Cut rules: what saving would write

| Rule | Outputs cut per point, median | Chars written per point, median | Chars written per point, mean | Chars written per day | Largest output cut, chars | Outputs cut over 4 MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `cut-jev@0.30` | 8 | 62,333 | 70,984 | 17,426,610 | 64,101 | 0 |
| `cut-jev@0.45` | 9 | 62,434 | 78,008 | 19,150,944 | 64,101 | 0 |
| `cut-newest@0.30` | 8 | 62,288 | 70,870 | 17,398,643 | 64,101 | 0 |
| `cut-newest@0.45` | 9 | 62,434 | 78,239 | 19,207,711 | 64,101 | 0 |
| `cut-all` | 9 | 62,434 | 81,518 | 20,012,766 | 64,101 | 0 |

Chars written per day is the mean per point times the 982 compactions found over 4 days (246 a day), as if every compaction wrote every output it cuts. Outputs over 4 MiB counts distinct outputs by their UTF-8 size; 4 MiB is the most `$.fs.read` reads.

Every output a cut rule cuts can be read back whole from its saved file. That is not counted as usable above, so the measure stays comparable with fast-compact's "stayed usable".

## Fidelity

- Session logs read: 769. Sessions with a compaction in the range: 34.
- Compaction points found: 982 (72 more copies of one of them met in a second log file of the same session, counted once).
- Excluded: 88.
  - no `input:` line from the hook for the compaction: 27
  - the rebuilt window does not give the logged `input:` line: 37
  - the rebuilt window does not give the logged `bounds:` line: 22
  - no `decisions:` line (the hook fell back before deciding): 2
  - the logged decisions do not match the calls of the window (tool or sizes): 0
  - the compaction record disagrees with the log: 0
- Passed validation (the rebuilt window gives the logged `input:` and `bounds:` lines char for char): 896.
- With matched scores (one logged decision per asked-about call, same tool and sizes): 894.
- Usable (also no disagreeing compaction record): 894; sampled: 200.
- `main` replayed through the real `compact()`: every logged action reproduced at 200 of 200 points; the logged reduction reproduced at 200; the whole logged summary (counts, state tokens, stage, requests) at 200.
- Compaction records of the main conversation in the range: 677; matched to a point, by session and within 10 s of its `input:` line: 661. A point the hook logged no `input:` line for cannot be matched.
- Claude Code versions, points found: 2.1.301 (15), 2.1.302 (510), 2.1.303 (243), 2.1.304 (214). Sampled: 2.1.301 (3), 2.1.302 (97), 2.1.303 (62), 2.1.304 (38).
- Points found per day: 2026-10-17 (295), 2026-10-18 (204), 2026-10-19 (222), 2026-10-20 (261).

## How a point is rebuilt and checked

- The window is the user and assistant entries of the main conversation (not a subagent's, not meta) between the previous boundary and this one, in file order, one message per entry: entries that share one `message.id` stay apart, as Claude Code hands them to the hook.
- After a boundary that kept messages by reference (`compactMetadata.preservedMessages`), those messages go right after the summary.
- A tool result holding `tool_reference` blocks carries Claude Code's "Tool loaded." text while its turn is still in progress (the newest entry is that turn's user entry); the log does not hold that text. This rule is measured, not documented.
- The `/compact` command that starts a manual compaction is not in the window it compacts.
- The hook's lines are its notices before the boundary; a subagent's compaction logs into the same file, so the main conversation's are the last group with a `context:` line.
- A compaction met in two log files of one session counts once, from the larger file.

## Rules

- `main`: the real `compact()` at the hook defaults (keep threshold 0.5, 6 preserved messages, a 300-char head, 25% minimum), answered by Jev's logged scores. A logged 0.50 is read as just under 0.5 where the logged action says so.
- `cut-jev@T`: every old output over 2,500 chars is cut to its first 1,000 and last 500 chars, around a note naming its saved file (a stand-in of a real path's length); the outputs with the highest logged `keepResult` are restored whole, ties newest first, while the reduction stays at or above T, stopping at the first that would take it under; then, below 25%, the hook's reach tiers, with the inputs of cut calls in place of those of dropped results.
- `cut-newest@T`: the same, newest restored first, no Jev.
- `cut-all`: every output over 2,500 chars cut, none restored. A reference only.
- T is 0.30 and 0.45.

## Definitions

- *Old output:* the result of an unpinned call. Pinning follows `isPinned` and `collectToolCalls`.
- *Token:* a maximal match of `/[A-Za-z0-9][A-Za-z0-9_.\/:@#+-]*[A-Za-z0-9]/g`, at least 8 chars long, holding a digit or one of `/ . _ : @ #`.
- *Distinctive token of output O:* it occurs in O and in no other text, input or output of the window.
- *Later-needed:* O has a distinctive token that occurs after the point in an assistant text or a `tool_use` input. Its *label* is the token reused first.
- *Usable under rule R:* R's result passes the 25% gate and the label is still somewhere in R's compacted window.
  - The denominator is every later-needed output at every point.
  - A saved file does not count as usable, so the measure stays comparable with fast-compact's "stayed usable".

## Limits

- The label is a proxy for need, not proof.
- Jev's logged scores come from the old question text.
- fast-compact's published numbers are another person's and are not checked here.
- The points are one host's, from 4 days; "later" runs to the end of each session's log.
- The saved-file note is a stand-in of realistic length; the real one waits on the design of part B.
