import { bench, describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { PAGE_ALPHABET } from '../alphabet';
import { digitsToInt, intToDigits } from '../bignum';

/**
 * The 3200-character round-trip is the hot path of the whole library: every
 * page read and every search goes through it. The committed baseline is 5 ms
 * (testing.md §5); the reference machine does it in well under that. The
 * margin is wide because CI machines are not reference machines — the point is
 * to catch an accidental O(n²) radix conversion, not to police microseconds.
 *
 * The `bench` below reports the number for humans. The `it` test is the
 * assertion: vitest's bench runner does not surface per-task hooks, so a
 * genuine threshold check lives in a normal test that times the round-trip
 * directly.
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

  it('a full 3200-character round-trip stays under 5 ms', () => {
    const text = 'а'.repeat(3200);
    const start = performance.now();
    const value = digitsToInt(text, PAGE_ALPHABET);
    const roundTripped = intToDigits(value, PAGE_ALPHABET, 3200);
    const elapsed = performance.now() - start;
    expect(roundTripped).toBe(text);
    expect(elapsed).toBeLessThan(5);
  });
});
