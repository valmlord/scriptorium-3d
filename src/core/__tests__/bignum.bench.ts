import { bench, describe } from 'vitest';
import { PAGE_ALPHABET } from '../alphabet';
import { digitsToInt, intToDigits } from '../bignum';

/**
 * The 3200-character round-trip is the hot path of the whole library: every
 * page read and every search goes through it. The committed baseline is 5 ms
 * (testing.md §5); the reference machine does it in well under that. The
 * margin is wide because CI machines are not reference machines — the point is
 * to catch an accidental O(n²) radix conversion, not to police microseconds.
 *
 * This file reports the number for humans. The assertion lives in
 * `performance.test.ts`: `vitest run` does not collect `.bench.ts` files and
 * `vitest bench` does not run `it` tasks, so an `expect` written here would
 * execute in neither mode.
 */
describe('bignum round-trip', () => {
  bench(
    '3200-character page round-trip stays under 5 ms',
    () => {
      const value = digitsToInt('а'.repeat(3200), PAGE_ALPHABET);
      intToDigits(value, PAGE_ALPHABET, 3200);
    },
    { time: 100 }
  );
});
