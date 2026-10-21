import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { fallbackNotice, summarize } from '../hooks/fast-jev.js';
import { reductionRatio } from '../src/compact.js';
import type { CompactResult } from '../src/types.js';
import { Labels } from './replay/labels.js';
import { logEvents, validate, type LoggedDecision, type Point, type Reason } from './replay/log.js';
import { renderReport, type Fidelity, type OutputNumbers, type PointNumbers, type RuleNumbers } from './replay/report.js';
import { MAIN_OPTIONS, RULES, runRules, type RuleName } from './replay/rules.js';

/** One session log: where it is, whose it is, and its lines, read afresh on each call. */
export type LogSource = { file: string; session: string; lines: () => AsyncIterable<string> | Iterable<string> };

/** The fields of a compaction record (`~/.claude/fast-jev-compaction/records/`) the replay reads. */
export type RecordLike = { session: string; at: string; agentId: string | null; messagesIn: number; detail: string };

export type ReplayOptions = {
  logs: LogSource[];
  records: RecordLike[];
  since: string;
  until: string;
  seed: number;
  sample: number;
  minPoints: number;
  command: string;
  runDate: string;
  progress?: (text: string) => void;
};

/** A record is the point's when it is the main conversation's, of the same session, stamped this close to its `input:` line. */
const RECORD_MATCH_MS = 10_000;
/** `$.fs.read` rejects a file over 4 MiB. */
const FS_READ_LIMIT = 4 * 1024 * 1024;

const REASONS: readonly Reason[] = ['no-notice', 'input-differs', 'bounds-differs', 'no-decisions', 'decisions-differ', 'record-differs'];

/** A seeded generator of numbers in [0, 1) (mulberry32). */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * A seeded sample of `size`, stratified by session: sessions in a seeded order, each session's points in
 * a seeded order, one point from each session in turn, so no session gives a second point before every
 * session has given one, and a long session cannot outweigh the rest.
 */
export function stratifiedSample<T extends { session: string }>(points: readonly T[], size: number, seed: number): T[] {
  const random = seeded(seed);
  const bySession = new Map<string, T[]>();
  for (const point of points) bySession.set(point.session, [...(bySession.get(point.session) ?? []), point]);
  const queues = shuffled([...bySession.keys()].sort(), random).map((session) => shuffled(bySession.get(session)!, random));
  const sample: T[] = [];
  for (let round = 0; sample.length < size && queues.some((queue) => queue.length > round); round += 1) {
    for (const queue of queues) if (round < queue.length && sample.length < size) sample.push(queue[round]!);
  }
  return sample;
}

function recordOf(point: Point, records: ReadonlyMap<string, RecordLike[]>): RecordLike | undefined {
  const at = Date.parse(point.notices?.at ?? '');
  if (!Number.isFinite(at)) return undefined;
  let best: RecordLike | undefined;
  let gap = Infinity;
  for (const record of records.get(point.session) ?? []) {
    const distance = Math.abs(Date.parse(record.at) - at);
    if (distance <= RECORD_MATCH_MS && distance < gap) {
      best = record;
      gap = distance;
    }
  }
  return best;
}

type Found = {
  key: string;
  source: number;
  session: string;
  day: string;
  version: string;
  ok: boolean;
  reason?: Reason;
  record?: RecordLike;
};

const PERCENT = /(\d+)% reduction/;

/** Whether `main`'s replay gives the hook's closing line: the reduction it printed, and its whole summary. */
function agreement(result: CompactResult, final: string | undefined): { reduction: boolean; summary: boolean } {
  if (final === undefined) return { reduction: false, summary: false };
  const minimum = MAIN_OPTIONS.minReduction ?? 0;
  const expected = reductionRatio(result) < minimum ? fallbackNotice(result, minimum) : `no summary (${summarize(result)})`;
  return {
    reduction: PERCENT.exec(final)?.[1] !== undefined && PERCENT.exec(final)?.[1] === PERCENT.exec(expected)?.[1],
    summary: expected.startsWith('fallback') ? final === expected : final.startsWith('kept ') && final.endsWith(`, ${expected}`),
  };
}

/** Every string of the sources that must never reach the report: paths, project folder names, session ids. */
function privateStrings(logs: readonly LogSource[]): Set<string> {
  const found = new Set<string>();
  for (const log of logs) {
    found.add(log.file);
    found.add(log.session);
    const folder = basename(dirname(log.file));
    if (folder.length >= 8) found.add(folder);
  }
  return found;
}

/**
 * The replay: pass one finds every compaction point in the range and validates it; a seeded,
 * session-stratified sample of the points that pass is drawn; pass two replays every rule on each
 * sampled point and labels its old outputs from what the session wrote later. Exit 1, and no report,
 * when fewer than `minPoints` points pass.
 */
export async function runReplay(options: ReplayOptions): Promise<{ exitCode: number; markdown?: string; summary: string[] }> {
  const progress = options.progress ?? (() => {});
  const records = new Map<string, RecordLike[]>();
  let recordsInRange = 0;
  for (const record of options.records) {
    if (record.agentId !== null) continue;
    const day = record.at.slice(0, 10);
    if (day >= options.since && day <= options.until) recordsInRange += 1;
    records.set(record.session, [...(records.get(record.session) ?? []), record]);
  }

  const found = new Map<string, Found>();
  let copies = 0;
  for (const [source, log] of options.logs.entries()) {
    for await (const event of logEvents(log.file, log.session, log.lines())) {
      if (event.kind !== 'point') continue;
      const { point } = event;
      if (point.day < options.since || point.day > options.until) continue;
      const record = recordOf(point, records);
      const checked = validate(point, record);
      const key = point.uuid || `${source}:${point.index}`;
      const prior = found.get(key);
      if (prior) {
        copies += 1;
        if (prior.ok || !checked.ok) continue;
      }
      const entry: Found = { key, source, session: log.session, day: point.day, version: point.version, ok: checked.ok };
      if (!checked.ok) entry.reason = checked.reason;
      if (record) entry.record = record;
      found.set(key, entry);
    }
    progress(`read ${source + 1} of ${options.logs.length} logs: ${found.size} points so far`);
  }

  const all = [...found.values()];
  const excluded = Object.fromEntries(REASONS.map((reason) => [reason, all.filter((point) => point.reason === reason).length])) as Record<Reason, number>;
  const usable = all.filter((point) => point.ok);
  const summary = [
    `compaction points found: ${all.length} (${copies} more copies in a second log file)`,
    ...REASONS.map((reason) => `excluded, ${reason}: ${excluded[reason]}`),
    `usable: ${usable.length}`,
  ];
  if (usable.length < options.minPoints) {
    summary.push(`fewer than ${options.minPoints} points pass: no report`);
    return { exitCode: 1, summary };
  }

  const sample = stratifiedSample(usable, options.sample, options.seed);
  const sampleIndex = new Map(sample.map((point, index) => [point.key, index]));
  const numbers: PointNumbers[] = [];
  const largest = new Map<RuleName, number>();
  const big = new Map<RuleName, Set<string>>();
  let actionsAgree = 0;
  let reductionAgree = 0;
  let summaryAgree = 0;
  const sources = [...new Set(sample.map((point) => point.source))].sort((a, b) => a - b);
  for (const source of sources) {
    const log = options.logs[source]!;
    const labels = new Labels();
    const tracked: number[] = [];
    for await (const event of logEvents(log.file, log.session, log.lines())) {
      if (event.kind === 'later') {
        labels.later(event.texts);
        continue;
      }
      const { point } = event;
      const index = sampleIndex.get(point.uuid || `${source}:${point.index}`);
      if (index === undefined || sample[index]!.source !== source) continue;
      const checked = validate(point, sample[index]!.record);
      if (!checked.ok) throw new Error(`a sampled point no longer validates (${checked.reason})`);
      const { runs, main } = await runRules(point.window, checked.decisions);
      labels.track(index, point.window, runs);
      tracked.push(index);
      const logged = new Map<string, LoggedDecision>([...checked.decisions.values()].map((decision) => [decision.id, decision]));
      if (main.decisions.every((decision) => decision.reason === 'pinned' || logged.get(decision.id)?.action === decision.action)) actionsAgree += 1;
      const agrees = agreement(main, point.notices?.final);
      if (agrees.reduction) reductionAgree += 1;
      if (agrees.summary) summaryAgree += 1;
      const rules = {} as Record<RuleName, RuleNumbers>;
      for (const run of runs) {
        rules[run.rule] = {
          reduction: run.reduction,
          passes: run.passes,
          usable: 0,
          cutCount: run.cut.length,
          charsWritten: run.cut.reduce((sum, output) => sum + output.chars, 0),
        };
        for (const output of run.cut) {
          largest.set(run.rule, Math.max(largest.get(run.rule) ?? 0, output.chars));
          if (output.bytes > FS_READ_LIMIT) big.set(run.rule, (big.get(run.rule) ?? new Set()).add(`${log.session}\n${output.toolUseId}`));
        }
      }
      numbers[index] = { needed: 0, rules };
    }
    for (const index of tracked) {
      const counts = labels.counts(index);
      numbers[index]!.needed = counts.needed;
      for (const rule of RULES) numbers[index]!.rules[rule].usable = counts.usable[rule] ?? 0;
    }
    progress(`replayed ${numbers.filter(Boolean).length} of ${sample.length} sampled points`);
  }
  if (numbers.filter(Boolean).length !== sample.length) throw new Error('a sampled point was not found again in its log');

  const outputs: OutputNumbers = {};
  for (const rule of RULES) {
    if (rule !== 'main') outputs[rule] = { largest: largest.get(rule) ?? 0, over4MiB: big.get(rule)?.size ?? 0 };
  }
  const tallyBy = (points: readonly Found[], field: 'version' | 'day') => {
    const counts: Record<string, number> = {};
    for (const point of points) counts[point[field]] = (counts[point[field]] ?? 0) + 1;
    return counts;
  };
  const fidelity: Fidelity = {
    logsRead: options.logs.length,
    sessions: new Set(all.map((point) => point.session)).size,
    found: all.length,
    copies,
    excluded,
    usable: usable.length,
    sampled: sample.length,
    actionsAgree,
    reductionAgree,
    summaryAgree,
    records: { inRange: recordsInRange, matched: all.filter((point) => point.record).length },
    versions: tallyBy(all, 'version'),
    sampledVersions: tallyBy(sample, 'version'),
    days: tallyBy(all, 'day'),
  };
  const markdown = renderReport({
    points: numbers,
    outputs,
    fidelity,
    meta: {
      command: options.command,
      runDate: options.runDate,
      since: options.since,
      until: options.until,
      seed: options.seed,
      sample: options.sample,
      minPoints: options.minPoints,
    },
  });
  for (const text of privateStrings(options.logs)) {
    if (markdown.includes(text)) throw new Error('the report would hold a path, project folder or session id; nothing written');
  }
  summary.push(`sampled: ${sample.length}`);
  return { exitCode: 0, markdown, summary };
}

/** A file's lines up to `size` bytes: what it held when the run listed it, so both passes read the same log. */
async function* fileLines(path: string, size: number): AsyncGenerator<string> {
  if (size === 0) return;
  const lines = createInterface({ input: createReadStream(path, { start: 0, end: size - 1 }), crlfDelay: Infinity });
  yield* lines;
}

/** The main-conversation logs, `<projects>/<folder>/<session>.jsonl`, written to on or after `since`; the largest first. */
function listLogs(projects: string, since: string): LogSource[] {
  const from = Date.parse(`${since}T00:00:00Z`);
  const logs: { file: string; session: string; size: number }[] = [];
  for (const folder of readdirSync(projects, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    for (const name of readdirSync(`${projects}/${folder.name}`)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = `${projects}/${folder.name}/${name}`;
      const stat = statSync(file);
      if (!stat.isFile() || stat.mtimeMs < from) continue;
      logs.push({ file, session: name.slice(0, -'.jsonl'.length), size: stat.size });
    }
  }
  logs.sort((a, b) => b.size - a.size || a.file.localeCompare(b.file));
  return logs.map(({ file, session, size }) => ({ file, session, lines: () => fileLines(file, size) }));
}

function readRecords(folder: string): RecordLike[] {
  const records: RecordLike[] = [];
  let sessions: string[] = [];
  try {
    sessions = readdirSync(folder);
  } catch {
    return records;
  }
  for (const session of sessions) {
    let names: string[] = [];
    try {
      names = readdirSync(`${folder}/${session}`);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const value = JSON.parse(readFileSync(`${folder}/${session}/${name}`, 'utf8')) as Record<string, unknown>;
        if (
          typeof value.session === 'string' &&
          typeof value.at === 'string' &&
          (value.agentId === null || typeof value.agentId === 'string') &&
          typeof value.messagesIn === 'number' &&
          typeof value.detail === 'string'
        ) {
          records.push({ session: value.session, at: value.at, agentId: value.agentId, messagesIn: value.messagesIn, detail: value.detail });
        }
      } catch {
        // A record that does not parse is not used.
      }
    }
  }
  return records;
}

const DAY = /^\d{4}-\d\d-\d\d$/;

type Args = { since: string; until: string; out: string; seed: number; sample: number; minPoints: number; projects?: string; records?: string };

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if (!flag.startsWith('--') || value === undefined) throw new Error(`expected --flag value pairs, got ${flag}`);
    values.set(flag.slice(2), value);
  }
  const known = new Set(['since', 'until', 'out', 'seed', 'sample', 'min-points', 'projects', 'records']);
  for (const flag of values.keys()) if (!known.has(flag)) throw new Error(`unknown flag --${flag}`);
  const since = values.get('since') ?? '';
  const until = values.get('until') ?? '';
  const out = values.get('out') ?? '';
  if (!DAY.test(since) || !DAY.test(until) || since > until) throw new Error('--since and --until take YYYY-MM-DD, since first');
  if (!out) throw new Error('--out names the markdown file to write');
  const number = (flag: string, fallback: number) => {
    const value = Number(values.get(flag) ?? fallback);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${flag} takes a whole number`);
    return value;
  };
  const args: Args = { since, until, out, seed: number('seed', 20), sample: number('sample', 200), minPoints: number('min-points', 100) };
  const projects = values.get('projects');
  if (projects) args.projects = projects;
  const records = values.get('records');
  if (records) args.records = records;
  return args;
}

/** The command as the report prints it: folders are named by role only, and only a relative output path is shown. */
function commandOf(args: Args): string {
  const parts = ['npm run replay --', '--since', args.since, '--until', args.until, '--out', isAbsolute(args.out) || args.out.includes('..') ? '<file>' : args.out];
  if (args.seed !== 20) parts.push('--seed', String(args.seed));
  if (args.sample !== 200) parts.push('--sample', String(args.sample));
  if (args.minPoints !== 100) parts.push('--min-points', String(args.minPoints));
  if (args.projects) parts.push('--projects', '<folder>');
  if (args.records) parts.push('--records', '<folder>');
  return parts.join(' ');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const home = homedir();
  const logs = listLogs(args.projects ?? `${home}/.claude/projects`, args.since);
  const records = readRecords(args.records ?? `${home}/.claude/fast-jev-compaction/records`);
  const started = Date.now();
  const { exitCode, markdown, summary } = await runReplay({
    logs,
    records,
    since: args.since,
    until: args.until,
    seed: args.seed,
    sample: args.sample,
    minPoints: args.minPoints,
    command: commandOf(args),
    runDate: new Date().toISOString().slice(0, 10),
    progress: (text) => console.error(text),
  });
  for (const line of summary) console.error(line);
  if (markdown !== undefined) {
    writeFileSync(args.out, markdown);
    console.error(`wrote the report in ${Math.round((Date.now() - started) / 1000)} s`);
  }
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
