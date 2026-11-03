/**
 * Render the benchmark report of `src/core/__tests__/*.bench.ts` as a table,
 * on stdout and — when running inside GitHub Actions — in the job summary of
 * the run.
 *
 * It exists because of ADR-0013: a performance figure is only evidence if it
 * names the machine it was taken on. ADR-0005 justified the worker with
 * "~1.3 ms a page" and "~42 ms a shelf" and named no machine for either, and
 * the three machines this library has been measured on differ by close to a
 * factor of ten — so neither figure could be reproduced or refuted. This
 * script answers that for the one machine that matters to a review gate: the
 * runner, whose CPU model and Node version it prints beside the numbers.
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
import { BOOKS_PER_SHELF } from '../src/core/address';

/** One frame at 60 fps, in milliseconds — the unit M3's review gate counts in. */
const FRAME_MS = 1000 / 60;

/** Where `npm run bench:report` leaves the JSON for this script to read. */
const DEFAULT_REPORT_PATH = 'bench-report.json';

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
function render(rows: readonly BenchmarkResult[]): string {
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
    table,
    '',
    `One frame at 60 fps is ${FRAME_MS.toFixed(1)} ms, and a shelf is ${String(BOOKS_PER_SHELF)} volumes.`,
    'Each median is over the sample count in its own row; the bench files fix that count so it',
    'does not vary with how fast the machine is.',
    '',
  ].join('\n');
}

const reportPath = process.argv[2] ?? DEFAULT_REPORT_PATH;
const markdown = render(parseRows(JSON.parse(readFileSync(reportPath, 'utf8'))));

process.stdout.write(`${markdown}\n`);

// GitHub renders this file on the run's own page, so the numbers are readable
// without opening a job log. Absent everywhere else, which is why it is
// optional rather than a requirement of the script.
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath !== undefined && summaryPath !== '') {
  appendFileSync(summaryPath, `${markdown}\n`);
}
