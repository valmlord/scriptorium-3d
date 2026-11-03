import { bench, describe } from 'vitest';
import { PAGE_LENGTH } from '../address';
import { PAGE_ALPHABET } from '../alphabet';
import { digitsToInt, intToDigits } from '../bignum';
import { benchOptions } from './bench-samples';

/**
 * The 3200-character round-trip is the hot path of the whole library: every
 * page read and every search goes through it. The committed budget is in
 * testing.md §5, calibrated on the slowest machine that enforces it
 * (ADR-0013); its margin is there to catch an accidental O(n²) radix
 * conversion, not to police microseconds.
 *
 * This file reports the number for humans. The assertion lives in
 * `performance.test.ts`: `vitest run` does not collect `.bench.ts` files and
 * `vitest bench` does not run `it` tasks, so an `expect` written here would
 * execute in neither mode.
 *
 * The sample count comes from `bench-samples.ts`, the same place
 * `library.bench.ts` takes it from, so that every row of the
 * `generation-cost` report is a median of the same number of samples. It was
 * on a wall-clock budget of its own until the report printed 309 samples for
 * this row against 50 for every other and contradicted its own footnote.
 */
describe('bignum round-trip', () => {
  bench(
    '3200-character page round-trip',
    () => {
      const value = digitsToInt('а'.repeat(PAGE_LENGTH), PAGE_ALPHABET);
      intToDigits(value, PAGE_ALPHABET, PAGE_LENGTH);
    },
    benchOptions
  );
});
