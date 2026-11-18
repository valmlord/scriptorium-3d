/**
 * Refuse a mutation report whose survivors did not run the tests they were
 * planned to run.
 *
 * Stryker decides a mutant survived when no test *failed*. Its Vitest runner
 * reads verdicts from test tasks, and a test file whose import throws
 * registers no tasks at all — so a mutant that breaks a module body produces a
 * red suite, an empty result set, and the verdict `Survived` (ADR-0031). Eight
 * mutants were reported that way in every nightly run of one commit, and a
 * person could only tell by applying each one by hand.
 *
 * The report says it, though, in a field nobody was reading. A survivor is a
 * mutant that ran its tests and none of them minded, so the test count is part
 * of the claim:
 *
 * - a **static** mutant is planned with no test filter, so it runs every test
 *   in the dry run;
 * - any other mutant runs the tests that cover it.
 *
 * A survivor that completed fewer tests than that did not survive anything; the
 * run was truncated and the verdict is void. This script fails the job on it,
 * which is the opposite of what the report did on its own: a truncated run that
 * reads as a pass is the failure this repository keeps finding (ADR-0014, and
 * `scripts/check-mutation-harness.sh` for the dry run's version of it).
 *
 * It fails on a missing, unparseable or mutant-free report too, for the same
 * reason: those are also ways for a job to stay green having measured nothing.
 *
 * Run with:  npm run test:mutation  (which runs this afterwards)
 */
import { readFileSync } from 'node:fs';

/** Where the `json` reporter in `stryker.config.json` leaves the report. */
const DEFAULT_REPORT_PATH = 'reports/mutation/mutation.json';

/**
 * The fields this script reads out of Stryker's report.
 *
 * Declared rather than imported: the shape is the mutation-testing-elements
 * schema, which arrives as JSON from another tool, so it is `unknown` until
 * checked (code-style §2). `testsCompleted` is optional in the schema, and a
 * missing one is treated as a shortfall rather than as a pass — a survivor
 * whose test count the report does not state is exactly as unverifiable as one
 * that ran too few.
 */
interface SurvivingMutant {
  readonly file: string;
  readonly line: number;
  readonly mutatorName: string;
  readonly replacement: string;
  readonly isStatic: boolean;
  readonly coveredByCount: number;
  readonly testsCompleted: number | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string') {
    throw new TypeError(
      `Mutation report field "${key}" is ${JSON.stringify(value)}, expected a string`
    );
  }
  return value;
}

function readLine(mutant: Record<string, unknown>): number {
  const location = mutant.location;
  if (!isRecord(location) || !isRecord(location.start)) {
    throw new TypeError('Mutation report mutant has no location.start');
  }
  const line = location.start.line;
  if (typeof line !== 'number' || !Number.isInteger(line)) {
    throw new TypeError(
      `Mutation report location.start.line is ${JSON.stringify(line)}, expected an integer`
    );
  }
  return line;
}

function readOptionalCount(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `Mutation report test count is ${JSON.stringify(value)}, expected a non-negative integer`
    );
  }
  return value;
}

interface Report {
  readonly totalTests: number;
  readonly mutantCount: number;
  readonly survivors: readonly SurvivingMutant[];
}

function parseReport(text: string): Report {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !isRecord(parsed.files)) {
    throw new TypeError('Mutation report has no "files" object');
  }

  const testFiles = parsed.testFiles;
  let totalTests = 0;
  if (isRecord(testFiles)) {
    for (const testFile of Object.values(testFiles)) {
      if (isRecord(testFile) && Array.isArray(testFile.tests)) {
        totalTests += testFile.tests.length;
      }
    }
  }

  const survivors: SurvivingMutant[] = [];
  let mutantCount = 0;
  for (const [file, entry] of Object.entries(parsed.files)) {
    if (!isRecord(entry) || !Array.isArray(entry.mutants)) {
      throw new TypeError(`Mutation report entry for "${file}" has no mutants array`);
    }
    for (const mutant of entry.mutants) {
      if (!isRecord(mutant)) {
        throw new TypeError(
          `Mutation report entry for "${file}" has a non-object mutant`
        );
      }
      mutantCount += 1;
      if (readString(mutant, 'status') !== 'Survived') {
        continue;
      }
      const coveredBy = mutant.coveredBy;
      survivors.push({
        file,
        line: readLine(mutant),
        mutatorName: readString(mutant, 'mutatorName'),
        replacement: readString(mutant, 'replacement'),
        isStatic: mutant.static === true,
        coveredByCount: Array.isArray(coveredBy) ? coveredBy.length : 0,
        testsCompleted: readOptionalCount(mutant.testsCompleted),
      });
    }
  }

  return { totalTests, mutantCount, survivors };
}

/** How many tests this survivor's run plan was supposed to complete. */
function plannedTests(mutant: SurvivingMutant, totalTests: number): number {
  return mutant.isStatic ? totalTests : mutant.coveredByCount;
}

function main(): void {
  const path = process.argv[2] ?? DEFAULT_REPORT_PATH;

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`check-mutation-report: cannot read ${path}: ${reason}`);
    process.exit(1);
  }

  let report: Report;
  try {
    report = parseReport(text);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`check-mutation-report: ${path} is not a mutation report: ${reason}`);
    process.exit(1);
  }

  if (report.mutantCount === 0) {
    console.error(`check-mutation-report: ${path} reports no mutants at all`);
    process.exit(1);
  }
  if (report.totalTests === 0) {
    console.error(`check-mutation-report: ${path} reports no tests at all`);
    process.exit(1);
  }

  const truncated = report.survivors.filter((mutant) => {
    const planned = plannedTests(mutant, report.totalTests);
    return mutant.testsCompleted === undefined || mutant.testsCompleted < planned;
  });

  if (truncated.length > 0) {
    console.error(
      `check-mutation-report: ${String(truncated.length)} of ${String(report.survivors.length)} ` +
        `survivors ran fewer tests than their run plan, so their verdict is void:`
    );
    for (const mutant of truncated) {
      const planned = plannedTests(mutant, report.totalTests);
      console.error(
        `  ${mutant.file}:${String(mutant.line)} ${mutant.mutatorName} -> ${mutant.replacement}\n` +
          `    ran ${String(mutant.testsCompleted ?? 0)} of ${String(planned)} planned tests ` +
          `(${mutant.isStatic ? 'static: the whole suite' : 'its covering tests'})`
      );
    }
    console.error(
      'check-mutation-report: a test file whose import throws registers no failing test, so a\n' +
        '  mutant that breaks a module body is reported as a survivor (ADR-0031). Apply the\n' +
        '  mutation by hand and run `vitest run --config vitest.stryker.config.ts` to see what\n' +
        '  the suite does with it.'
    );
    process.exit(1);
  }

  console.log(
    `check-mutation-report: ${String(report.survivors.length)} survivor(s) of ` +
      `${String(report.mutantCount)} mutants, each having run every test its plan named ` +
      `(${String(report.totalTests)} tests in the suite)`
  );
}

main();
