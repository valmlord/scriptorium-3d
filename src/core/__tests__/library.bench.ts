import { bench, describe } from 'vitest';
import { LIBRARY_SIZE, PAGE_LENGTH, fromLinear } from '../address';
import { PAGE_ALPHABET } from '../alphabet';
import { intToDigits } from '../bignum';
import { getPage, locate } from '../library';

/**
 * Reported numbers for `npx vitest bench`. The threshold is *asserted* in
 * `performance.test.ts`, not here: a `bench` task reports a measurement but
 * cannot fail a build, and an `expect` placed in a `.bench.ts` file runs in
 * neither `vitest run` nor `vitest bench` — so it would guarantee nothing.
 *
 * Reference machine (SPEC §4.4): encrypt 1.34 ms, decrypt 0.98 ms.
 */

/** Pick a sample, cycling, and fail loudly rather than silently on empty. */
const cycle = <T>(values: readonly T[], index: number): T => {
  const value = values[index % values.length];
  if (value === undefined) {
    throw new Error('Benchmark sample set is empty');
  }
  return value;
};

/** A spread of addresses, so no single value can be cached or folded away. */
const addresses = Array.from({ length: 64 }, (_unused, index) =>
  fromLinear((LIBRARY_SIZE / 64n) * BigInt(index) + BigInt(index))
);

const pages = addresses.map((address) => getPage(address));

const edgePages = [
  intToDigits(0n, PAGE_ALPHABET, PAGE_LENGTH),
  intToDigits(LIBRARY_SIZE - 1n, PAGE_ALPHABET, PAGE_LENGTH),
];

describe('the bijection', () => {
  let forward = 0;

  bench(
    'getPage — address to 3200 characters',
    () => {
      getPage(cycle(addresses, forward++));
    },
    { time: 500 }
  );

  let backward = 0;

  bench(
    'locate — 3200 characters to address',
    () => {
      locate(cycle(pages, backward++));
    },
    { time: 500 }
  );

  let edge = 0;

  bench(
    'locate — the all-spaces and maximum-value pages',
    () => {
      locate(cycle(edgePages, edge++));
    },
    { time: 500 }
  );
});
