import type { Reason } from './log.js';
import { RULES, type RuleName } from './rules.js';

// Everything here is built from numbers, dates, version numbers and fixed text: no log content reaches it.

export type RuleNumbers = {
  reduction: number;
  passes: boolean;
  /** Later-needed outputs whose label stayed in the rule's window. */
  usable: number;
  /** Outputs the rule cut, so saved to files. */
  cutCount: number;
  /** Chars of the whole outputs it cut, which their files would hold. */
  charsWritten: number;
};

export type PointNumbers = { needed: number; rules: Record<RuleName, RuleNumbers> };

/** Per cut rule: the largest output it cut, in chars, and how many distinct outputs it cut are over 4 MiB. */
export type OutputNumbers = Partial<Record<RuleName, { largest: number; over4MiB: number }>>;

export type Fidelity = {
  logsRead: number;
  sessions: number;
  found: number;
  /** The same compaction met again in a second log file of its session. */
  copies: number;
  excluded: Record<Reason, number>;
  usable: number;
  sampled: number;
  actionsAgree: number;
  reductionAgree: number;
  summaryAgree: number;
  records: { inRange: number; matched: number };
  versions: Record<string, number>;
  sampledVersions: Record<string, number>;
  days: Record<string, number>;
};

export type ReportMeta = {
  command: string;
  runDate: string;
  since: string;
  until: string;
  seed: number;
  sample: number;
  minPoints: number;
};

const REASONS: Record<Reason, string> = {
  'no-notice': 'no `input:` line from the hook for the compaction',
  'input-differs': 'the rebuilt window does not give the logged `input:` line',
  'bounds-differs': 'the rebuilt window does not give the logged `bounds:` line',
  'no-decisions': 'no `decisions:` line (the hook fell back before deciding)',
  'decisions-differ': 'the logged decisions do not match the calls of the window (tool or sizes)',
  'record-differs': 'the compaction record disagrees with the log',
};

/** The `q` quantile of `values`, linear between neighbours. */
function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function share(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function count(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function plain(text: string, pattern: RegExp): string {
  return pattern.test(text) ? text : 'other';
}

/** Days from `since` to `until`, both counted. */
function days(since: string, until: string): number {
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000) + 1;
}

function daysText(since: string, until: string): string {
  const n = days(since, until);
  return `${n} day${n === 1 ? '' : 's'}`;
}

function tally(counts: Record<string, number>, pattern: RegExp): string {
  const merged = new Map<string, number>();
  for (const [key, value] of Object.entries(counts)) {
    const name = plain(key, pattern);
    merged.set(name, (merged.get(name) ?? 0) + value);
  }
  return [...merged]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key} (${count(value)})`)
    .join(', ');
}

export function renderReport(input: { points: PointNumbers[]; outputs: OutputNumbers; fidelity: Fidelity; meta: ReportMeta }): string {
  const { points, outputs, fidelity: f, meta } = input;
  const needed = points.reduce((sum, point) => sum + point.needed, 0);
  const excluded = Object.values(f.excluded).reduce((sum, value) => sum + value, 0);
  const validated = f.found - f.excluded['no-notice'] - f.excluded['input-differs'] - f.excluded['bounds-differs'];
  const matched = validated - f.excluded['no-decisions'] - f.excluded['decisions-differ'];
  const perDay = f.found / days(meta.since, meta.until);
  const lines: string[] = [];
  const row = (cells: (string | number)[]) => lines.push(`| ${cells.join(' | ')} |`);

  lines.push('# Issue 20: cutting and saving old tool outputs, replayed on real compactions', '');
  lines.push(
    `Run on ${meta.runDate} (UTC) over the compactions of ${meta.since} to ${meta.until} (UTC days), on one host's session logs, with:`,
    '',
    '```',
    meta.command,
    '```',
    '',
    `Every rule ran on the same ${count(points.length)} points: a seeded (seed ${meta.seed}), session-stratified sample of ${count(points.length)} of the ${count(f.usable)} points that passed every check below (sample size asked: ${count(meta.sample)}; the run stops under ${count(meta.minPoints)}).`,
    'No Jev request was made: `main` is answered by the scores the hook logged.',
    '',
  );

  lines.push('## Results', '');
  row(['Rule', 'Points', 'Freed, median', 'Freed, mean', 'Freed, p10', 'Below 25%', 'Later-needed outputs', 'Usable outputs']);
  row(['---', '---:', '---:', '---:', '---:', '---:', '---:', '---:']);
  for (const rule of RULES) {
    const reductions = points.map((point) => point.rules[rule].reduction);
    const usable = points.reduce((sum, point) => sum + point.rules[rule].usable, 0);
    row([
      `\`${rule}\``,
      count(points.length),
      share(quantile(reductions, 0.5)),
      share(mean(reductions)),
      share(quantile(reductions, 0.1)),
      count(points.filter((point) => !point.rules[rule].passes).length),
      count(needed),
      `${count(usable)} (${share(needed === 0 ? 0 : usable / needed)})`,
    ]);
  }
  lines.push(
    '',
    '"Freed" is the share of the window\'s chars (as the hook counts them) the rule removes, whether or not it reaches 25%. Below 25% the hook falls back to the built-in summary, so none of that point\'s outputs count as usable.',
    '',
  );

  lines.push('## Cut rules: what saving would write', '');
  row(['Rule', 'Outputs cut per point, median', 'Chars written per point, median', 'Chars written per point, mean', 'Chars written per day', 'Largest output cut, chars', 'Outputs cut over 4 MiB']);
  row(['---', '---:', '---:', '---:', '---:', '---:', '---:']);
  for (const rule of RULES) {
    if (rule === 'main') continue;
    const written = points.map((point) => point.rules[rule].charsWritten);
    row([
      `\`${rule}\``,
      count(quantile(points.map((point) => point.rules[rule].cutCount), 0.5)),
      count(quantile(written, 0.5)),
      count(mean(written)),
      count(mean(written) * perDay),
      count(outputs[rule]?.largest ?? 0),
      count(outputs[rule]?.over4MiB ?? 0),
    ]);
  }
  lines.push(
    '',
    `Chars written per day is the mean per point times the ${count(f.found)} compactions found over ${daysText(meta.since, meta.until)} (${count(perDay)} a day), as if every compaction wrote every output it cuts. Outputs over 4 MiB counts distinct outputs by their UTF-8 size; 4 MiB is the most \`$.fs.read\` reads.`,
    '',
    'Every output a cut rule cuts can be read back whole from its saved file. That is not counted as usable above, so the measure stays comparable with fast-compact\'s "stayed usable".',
    '',
  );

  lines.push('## Fidelity', '');
  lines.push(
    `- Session logs read: ${count(f.logsRead)}. Sessions with a compaction in the range: ${count(f.sessions)}.`,
    `- Compaction points found: ${count(f.found)} (${count(f.copies)} more copies of one of them met in a second log file of the same session, counted once).`,
    `- Excluded: ${count(excluded)}.`,
  );
  for (const reason of Object.keys(REASONS) as Reason[]) lines.push(`  - ${REASONS[reason]}: ${count(f.excluded[reason])}`);
  lines.push(
    `- Passed validation (the rebuilt window gives the logged \`input:\` and \`bounds:\` lines char for char): ${count(validated)}.`,
    `- With matched scores (one logged decision per asked-about call, same tool and sizes): ${count(matched)}.`,
    `- Usable (also no disagreeing compaction record): ${count(f.usable)}; sampled: ${count(f.sampled)}.`,
    `- \`main\` replayed through the real \`compact()\`: every logged action reproduced at ${count(f.actionsAgree)} of ${count(f.sampled)} points; the logged reduction reproduced at ${count(f.reductionAgree)}; the whole logged summary (counts, state tokens, stage, requests) at ${count(f.summaryAgree)}.`,
    `- Compaction records of the main conversation in the range: ${count(f.records.inRange)}; matched to a point, by session and within 10 s of its \`input:\` line: ${count(f.records.matched)}. A point the hook logged no \`input:\` line for cannot be matched.`,
    `- Claude Code versions, points found: ${tally(f.versions, /^\d+\.\d+\.\d+$/)}. Sampled: ${tally(f.sampledVersions, /^\d+\.\d+\.\d+$/)}.`,
    `- Points found per day: ${tally(f.days, /^\d{4}-\d\d-\d\d$/)}.`,
    '',
  );

  lines.push('## How a point is rebuilt and checked', '');
  lines.push(
    '- The window is the user and assistant entries of the main conversation (not a subagent\'s, not meta) between the previous boundary and this one, in file order, one message per entry: entries that share one `message.id` stay apart, as Claude Code hands them to the hook.',
    '- After a boundary that kept messages by reference (`compactMetadata.preservedMessages`), those messages go right after the summary.',
    '- A tool result holding `tool_reference` blocks carries Claude Code\'s "Tool loaded." text while its turn is still in progress (the newest entry is that turn\'s user entry); the log does not hold that text. This rule is measured, not documented.',
    '- The `/compact` command that starts a manual compaction is not in the window it compacts.',
    '- The hook\'s lines are its notices before the boundary; a subagent\'s compaction logs into the same file, so the main conversation\'s are the last group with a `context:` line.',
    '- A compaction met in two log files of one session counts once, from the larger file.',
    '',
  );

  lines.push('## Rules', '');
  lines.push(
    '- `main`: the real `compact()` at the hook defaults (keep threshold 0.5, 6 preserved messages, a 300-char head, 25% minimum), answered by Jev\'s logged scores. A logged 0.50 is read as just under 0.5 where the logged action says so.',
    '- `cut-jev@T`: every old output over 2,500 chars is cut to its first 1,000 and last 500 chars, around a note naming its saved file (a stand-in of a real path\'s length); the outputs with the highest logged `keepResult` are restored whole, ties newest first, while the reduction stays at or above T, stopping at the first that would take it under; then, below 25%, the hook\'s reach tiers, with the inputs of cut calls in place of those of dropped results.',
    '- `cut-newest@T`: the same, newest restored first, no Jev.',
    '- `cut-all`: every output over 2,500 chars cut, none restored. A reference only.',
    '- T is 0.30 and 0.45.',
    '',
  );

  lines.push('## Definitions', '');
  lines.push(
    '- *Old output:* the result of an unpinned call. Pinning follows `isPinned` and `collectToolCalls`.',
    '- *Token:* a maximal match of `/[A-Za-z0-9][A-Za-z0-9_.\\/:@#+-]*[A-Za-z0-9]/g`, at least 8 chars long, holding a digit or one of `/ . _ : @ #`.',
    '- *Distinctive token of output O:* it occurs in O and in no other text, input or output of the window.',
    '- *Later-needed:* O has a distinctive token that occurs after the point in an assistant text or a `tool_use` input. Its *label* is the token reused first.',
    '- *Usable under rule R:* R\'s result passes the 25% gate and the label is still somewhere in R\'s compacted window.',
    '  - The denominator is every later-needed output at every point.',
    '  - A saved file does not count as usable, so the measure stays comparable with fast-compact\'s "stayed usable".',
    '',
  );

  lines.push('## Limits', '');
  lines.push(
    '- The label is a proxy for need, not proof.',
    '- Jev\'s logged scores come from the old question text.',
    '- fast-compact\'s published numbers are another person\'s and are not checked here.',
    `- The points are one host's, from ${daysText(meta.since, meta.until)}; "later" runs to the end of each session's log.`,
    '- The saved-file note is a stand-in of realistic length; the real one waits on the design of part B.',
    '',
  );
  return lines.join('\n');
}
