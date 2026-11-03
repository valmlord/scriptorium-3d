/**
 * Report what generation costs on the machine this runs on: the warm medians
 * `src/core/__tests__/*.bench.ts` produced, plus a cold-start reading this
 * script takes itself. Written to stdout and — inside GitHub Actions — to the
 * job summary of the run.
 *
 * It exists because of ADR-0013: a performance figure is only evidence if it
 * names the machine it was taken on. ADR-0005 justified the worker with
 * "~1.3 ms a page" and "~42 ms a shelf" and named no machine for either, and
 * the machines this library has been measured on differ by close to a factor
 * of ten — so neither figure could be reproduced or refuted. This script
 * answers that for the machine that matters to a review gate: the runner,
 * whose CPU model and Node version it prints beside the numbers.
 *
 * **It reports and never fails.** The enforcing gate is the committed budget
 * of testing.md §5, asserted in `src/core/__tests__/performance.test.ts`. A
 * second gate here would be a threshold sitting on the runner's own value,
 * which is exactly the arrangement ADR-0013 removed after it failed one CI run
 * at 5.052 ms and passed the next.
 *
 * Run with:  npm run bench:report
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { BOOKS_PER_SHELF, LIBRARY_SIZE, fromLinear } from '../src/core/address';
import { getPage } from '../src/core/library';

/** One frame at 60 fps, in milliseconds — the unit M3's review gate counts in. */
const FRAME_MS = 1000 / 60;

/** Where `npm run bench:report` leaves the JSON for this script to read. */
const DEFAULT_REPORT_PATH = 'bench-report.json';

/**
 * Calls behind the cold-start reading below.
 *
 * Deliberately small. The point of that reading is to catch the cost *before*
 * V8 has finished optimising the `bigint` arithmetic, so a count large enough
 * to be smooth would measure the thing it is trying to avoid measuring. 15 is
 * enough that one scheduler hiccup cannot move the median — it would have to
 * take 8 of them — and small enough to still be inside the warm-up.
 */
const COLD_SAMPLES = 15;

/**
 * The fields this script reads out of Vitest's benchmark JSON.
 *
 * Declared rather than imported: benchmarking is flagged experimental in
 * Vitest 4 and its report shape is not part of the package's public types, so
 * a structural check at the boundary is the only thing that can notice the
 * shape changing (code-style §1). Everything is `unknown` until validated.
 */
interface BenchmarkResult {
  name: string;
  median: number;
  mean: number;
  min: number;
  p99: number;
  sampleCount: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const readNumber = (source: Record<string, unknown>, key: string): number => {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(
      `Benchmark report field "${key}" is ${JSON.stringify(value)}, expected a finite number`
    );
  }
  return value;
};

const readString = (source: Record<string, unknown>, key: string): string => {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(
      `Benchmark report field "${key}" is ${JSON.stringify(value)}, expected a non-empty string`
    );
  }
  return value;
};

const readArray = (source: Record<string, unknown>, key: string): unknown[] => {
  const value = source[key];
  if (!Array.isArray(value)) {
    throw new TypeError(
      `Benchmark report field "${key}" is ${JSON.stringify(value)}, expected an array`
    );
  }
  return value;
};

/**
 * Flatten Vitest's `files → groups → benchmarks` tree into rows, validating
 * every field on the way through. A group's name is read for the error
 * messages below rather than reported: the task names are already unique, and
 * which `describe` block a task sits in is a fact about the bench file.
 */
function parseRows(report: unknown): BenchmarkResult[] {
  if (!isRecord(report)) {
    throw new TypeError('Benchmark report is not an object');
  }
  const rows: BenchmarkResult[] = [];
  for (const file of readArray(report, 'files')) {
    if (!isRecord(file)) {
      throw new TypeError(
        'Benchmark report contains a file entry that is not an object'
      );
    }
    for (const group of readArray(file, 'groups')) {
      if (!isRecord(group)) {
        throw new TypeError('Benchmark report contains a group that is not an object');
      }
      const fullName = readString(group, 'fullName');
      for (const benchmark of readArray(group, 'benchmarks')) {
        if (!isRecord(benchmark)) {
          throw new TypeError(
            `Benchmark report entry in "${fullName}" is not an object`
          );
        }
        rows.push({
          name: readString(benchmark, 'name'),
          median: readNumber(benchmark, 'median'),
          mean: readNumber(benchmark, 'mean'),
          min: readNumber(benchmark, 'min'),
          p99: readNumber(benchmark, 'p99'),
          sampleCount: readNumber(benchmark, 'sampleCount'),
        });
      }
    }
  }
  if (rows.length === 0) {
    throw new Error(
      'Benchmark report holds no benchmarks. A silently empty run would publish an ' +
        'empty table and read as a pass, which is the failure mode ADR-0014 names.'
    );
  }
  return rows;
}

const milliseconds = (value: number): string => value.toFixed(3);

/** What the first pages of a fresh process cost; see `measureColdStart`. */
interface ColdStart {
  /** The very first call, the one a reader waiting on a page load pays. */
  first: number;
  /** The median of the first `COLD_SAMPLES` calls. */
  median: number;
}

/** The middle value of `timings`, which must not be empty. */
function median(timings: readonly number[]): number {
  const sorted = [...timings].sort((left, right) => left - right);
  const middle = sorted[Math.floor(sorted.length / 2)];
  if (middle === undefined) {
    throw new Error('Cannot take the median of an empty sample set');
  }
  return middle;
}

/**
 * What the first pages of a process cost, before V8 has optimised anything.
 *
 * This is a different measurement from the bench file's, not a duplicate of
 * it, and both are published because they answer different questions. Vitest
 * warms each task up before timing it, so its medians are what the second and
 * later calls cost — the right figure for a shelf, whose 32 titles are
 * resolved back to back. They are *not* what the first page after a page load
 * costs, and they are not comparable to the budget of testing.md §5, which is
 * asserted on an unwarmed median of its own.
 *
 * The gap is the whole reason M3's worker warms up on startup. Reporting the
 * warm figure alone would hide it, and someone would read the warm median
 * against the committed budget and conclude there is an order of magnitude of
 * headroom that is not there.
 *
 * This runs in a fresh process — the bench ran in its own — so "cold" here is
 * genuinely cold, and it runs before anything else in this script so that
 * nothing else has warmed the path first.
 */
function measureColdStart(): ColdStart {
  const addresses = Array.from({ length: COLD_SAMPLES }, (_unused, index) =>
    fromLinear((LIBRARY_SIZE / BigInt(COLD_SAMPLES)) * BigInt(index) + BigInt(index))
  );
  const timings: number[] = [];
  for (const address of addresses) {
    const start = performance.now();
    getPage(address);
    timings.push(performance.now() - start);
  }
  const first = timings[0];
  if (first === undefined) {
    throw new Error('Cold-start measurement produced no samples');
  }
  return { first, median: median(timings) };
}

/** How many 60 fps frames a cost occupies, to one decimal place. */
const frames = (value: number): string => (value / FRAME_MS).toFixed(1);

/**
 * The machine, named in the report rather than left for the reader to infer
 * from which CI job produced it. This line is the whole point of the script.
 */
function describeMachine(): string {
  const processors = cpus();
  const model = processors[0]?.model.trim() ?? 'unknown CPU';
  const memoryGib = (totalmem() / 1024 ** 3).toFixed(1);
  const runner = process.env.RUNNER_NAME;
  const image = process.env.ImageOS;
  const where = [runner, image].filter((part) => part !== undefined && part !== '');
  return [
    `- **CPU** — ${model} (${String(processors.length)} logical cores)`,
    `- **Memory** — ${memoryGib} GiB`,
    `- **Node** — ${process.version} on ${process.platform}/${process.arch}`,
    ...(where.length > 0 ? [`- **Runner** — ${where.join(', ')}`] : []),
  ].join('\n');
}

/**
 * Most expensive first, rather than in the order Vitest walks the files.
 *
 * The reader's question is which operations cost a frame, so the costs that
 * might are at the top; file order would answer with whichever bench file
 * sorts first by path.
 */
function render(rows: readonly BenchmarkResult[], cold: ColdStart): string {
  const ordered = [...rows].sort((left, right) => right.median - left.median);
  const table = [
    '| Operation | Median | Mean | Min | p99 | Frames at 60 fps (median) | Samples |',
    '| --- | --: | --: | --: | --: | --: | --: |',
    ...ordered.map(
      (row) =>
        `| ${row.name} | ${milliseconds(row.median)} ms | ${milliseconds(row.mean)} ms | ` +
        `${milliseconds(row.min)} ms | ${milliseconds(row.p99)} ms | ${frames(row.median)} | ` +
        `${String(row.sampleCount)} |`
    ),
  ].join('\n');

  return [
    '## Generation cost',
    '',
    'Measured on this runner, by `npm run bench:report`. **This job reports; it never fails.**',
    'The budget that does fail a build is the one in `testing.md` §5, asserted by the `verify`',
    'job — a second threshold sitting on the runner’s own value is what ADR-0013 removed.',
    '',
    describeMachine(),
    '',
    '### Warm — second and later calls',
    '',
    table,
    '',
    `One frame at 60 fps is ${FRAME_MS.toFixed(1)} ms, and a shelf is ${String(BOOKS_PER_SHELF)} volumes.`,
    'Each median is over the sample count in its own row; the bench files fix that count so it does',
    'not vary with how fast the machine is. Vitest warms every task up before timing it, so these',
    'are what a call costs once the path is hot — the right figure for a shelf, whose titles are',
    'resolved back to back.',
    '',
    '### Cold — the first pages of a fresh process',
    '',
    `- **First \`getPage\` call** — ${milliseconds(cold.first)} ms, ${frames(cold.first)} frames`,
    `- **Median of the first ${String(COLD_SAMPLES)} calls** — ${milliseconds(cold.median)} ms, ` +
      `${frames(cold.median)} frames`,
    '',
    'Not comparable with the warm table above, and that is the point. The first page of a process',
    'costs several times a warm one, which is why M3 warms the worker up on startup rather than',
    'letting the first reader pay for it. It is also the apparatus the committed budget uses, so',
    'this is the figure to read against `testing.md` §5 — not the warm median.',
    '',
  ].join('\n');
}

// Before anything else in this script touches `core`, so that the reading is
// cold. The bench ran in its own process, so nothing has warmed this one.
const coldStart = measureColdStart();

const reportPath = process.argv[2] ?? DEFAULT_REPORT_PATH;
const markdown = render(
  parseRows(JSON.parse(readFileSync(reportPath, 'utf8'))),
  coldStart
);

process.stdout.write(`${markdown}\n`);

// GitHub renders this file on the run's own page, so the numbers are readable
// without opening a job log. Absent everywhere else, which is why it is
// optional rather than a requirement of the script.
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath !== undefined && summaryPath !== '') {
  appendFileSync(summaryPath, `${markdown}\n`);
}
