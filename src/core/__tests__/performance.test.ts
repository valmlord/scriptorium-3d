import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { LIBRARY_SIZE, PAGE_LENGTH, fromLinear } from '../address';
import { PAGE_ALPHABET } from '../alphabet';
import { digitsToInt, intToDigits } from '../bignum';
import { getPage, locate } from '../library';

/**
 * The committed performance baseline (testing.md §5). These assertions live in
 * a `.test.ts` file on purpose: `vitest run` does not collect `.bench.ts`
 * files and `vitest bench` does not run `it` tasks, so an `expect` written
 * beside a `bench` would execute in neither mode and enforce nothing. The
 * numbers for humans are reported by `src/core/__tests__/library.bench.ts`.
 *
 * The budget is 5 ms against a reference machine that does it in ~1.3 ms. The
 * margin is wide because CI runners are not reference machines: the point is
 * to catch an accidental O(n^2) radix conversion or a round function that
 * re-hashes the whole page, not to police microseconds.
 *
 * Each measurement is the **median** of several samples rather than a single
 * reading. A median cannot be dragged over the threshold by one scheduler
 * hiccup on a shared runner, while a genuine complexity regression moves every
 * sample at once — so this is a sharper test than a single timing, not a
 * laxer one.
 */

const BUDGET_MS = 5;
const SAMPLES = 15;

/**
 * Two run modes instrument `src/core` heavily enough that a wall-clock reading
 * stops being about the library: `npm run coverage` wraps every function for
 * v8, and `npm run test:mutation` adds Stryker's mutant switching plus
 * per-test coverage hooks. The same `getPage` call measures ~0.7 ms plain,
 * ~6 ms under v8 coverage and ~8 ms under Stryker. Timing an instrumented
 * build measures the instrumentation, so the budget is asserted in the
 * uninstrumented run.
 *
 * This is not a quarantined failure. `npm run test` and the CI `verify` job
 * run with neither flag, so the 5 ms budget of testing.md §5 is enforced on
 * every push and every pull request — and the test below this suite runs in
 * all three modes, so a skipped timing assertion can never hide a broken
 * bijection. The flags are set in `vite.config.ts` and
 * `vitest.stryker.config.ts`.
 */
const isInstrumented =
  process.env.SCRIPTORIUM_COVERAGE === '1' || process.env.SCRIPTORIUM_STRYKER === '1';

/** The median elapsed milliseconds over `SAMPLES` calls of `operation`. */
const medianMs = (operation: (iteration: number) => unknown): number => {
  const timings: number[] = [];
  for (let iteration = 0; iteration < SAMPLES; iteration++) {
    const start = performance.now();
    operation(iteration);
    timings.push(performance.now() - start);
  }
  timings.sort((left, right) => left - right);
  return timings[Math.floor(timings.length / 2)] ?? Number.POSITIVE_INFINITY;
};

/** Pick a sample, cycling, and fail loudly rather than silently on empty. */
const cycle = <T>(values: readonly T[], index: number): T => {
  const value = values[index % values.length];
  if (value === undefined) {
    throw new Error('Performance sample set is empty');
  }
  return value;
};

const addresses = Array.from({ length: SAMPLES }, (_unused, index) =>
  fromLinear((LIBRARY_SIZE / BigInt(SAMPLES)) * BigInt(index) + BigInt(index))
);

describe.skipIf(isInstrumented)('generation stays inside the committed budget', () => {
  it('getPage takes under 5 ms per page', () => {
    const elapsed = medianMs((iteration) => getPage(cycle(addresses, iteration)));

    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('locate takes under 5 ms per page', () => {
    const pages = addresses.map((address) => getPage(address));

    const elapsed = medianMs((iteration) => locate(cycle(pages, iteration)));

    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('locate stays inside the budget on the all-spaces page', () => {
    // The value 0: 3200 leading zeros, the shape that breaks a naive
    // fixed-width radix conversion and the one most likely to hit a slow path.
    const allSpaces = intToDigits(0n, PAGE_ALPHABET, PAGE_LENGTH);

    const elapsed = medianMs(() => locate(allSpaces));

    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('locate stays inside the budget on the maximum-value page', () => {
    const maximum = intToDigits(LIBRARY_SIZE - 1n, PAGE_ALPHABET, PAGE_LENGTH);

    const elapsed = medianMs(() => locate(maximum));

    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('a full 3200-character radix round-trip stays under 5 ms', () => {
    // Moved here from `bignum.bench.ts`, where the same assertion was written
    // beside a `bench` task and therefore never executed in either mode.
    const text = 'а'.repeat(PAGE_LENGTH);

    const elapsed = medianMs(() => {
      const value = digitsToInt(text, PAGE_ALPHABET);
      expect(intToDigits(value, PAGE_ALPHABET, PAGE_LENGTH)).toBe(text);
    });

    expect(elapsed).toBeLessThan(BUDGET_MS);
  });
});

describe('the benchmark measures the real thing', () => {
  it('generates a full page and locates it back, in every run mode', () => {
    // Runs with and without instrumentation. If the budget suite above is
    // skipped, this still proves the code it would have timed is exercised,
    // so a skipped timing assertion can never hide a broken bijection.
    const address = cycle(addresses, 0);

    const page = getPage(address);

    expect(page).toHaveLength(PAGE_LENGTH);
    expect(locate(page)).toEqual(address);
  });
});
