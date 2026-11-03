import { bench, describe } from 'vitest';
import {
  BOOKS_PER_SHELF,
  LIBRARY_SIZE,
  PAGE_LENGTH,
  fromLinear,
  type BookAddress,
} from '../address';
import { PAGE_ALPHABET } from '../alphabet';
import { intToDigits } from '../bignum';
import { getPage, getTitle, locate } from '../library';
import { benchOptions } from './bench-samples';

/**
 * Reported numbers for `npm run bench`. The threshold is *asserted* in
 * `performance.test.ts`, not here: a `bench` task reports a measurement but
 * cannot fail a build, and an `expect` placed in a `.bench.ts` file runs in
 * neither `vitest run` nor `vitest bench` — so it would guarantee nothing.
 *
 * `npm run bench:report` runs the same tasks and renders their medians as a
 * table, which the `generation-cost` CI job publishes to the run summary with
 * the runner's CPU and Node version beside it. That job reports and never
 * fails: a number nobody can reproduce is the problem it exists to fix
 * (ADR-0013), and a second gate that can go red on runner variance is what
 * ADR-0013 removed from the first one.
 *
 * The reference machine's own figures are in SPEC §4.4, which is their one
 * home; they are not restated here.
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

/** The same spread of locations, as books: a title is page 0 of one. */
const books = addresses.map(({ room, wall, shelf, volume }) => ({
  room,
  wall,
  shelf,
  volume,
}));

/**
 * One shelf's worth of books per sample: the 32 volumes of a single shelf, the
 * unit the renderer actually asks for when the camera arrives at one.
 *
 * A spread of shelves rather than one repeated, for the same reason as
 * `addresses` above — and the whole shelf is built up front so that the
 * measured task is the 32 `getTitle` calls and not the address arithmetic
 * around them.
 */
const shelves = addresses.map(({ room, wall, shelf }) =>
  Array.from({ length: BOOKS_PER_SHELF }, (_unused, volume): BookAddress => ({
    room,
    wall,
    shelf,
    volume,
  }))
);

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
    benchOptions
  );

  let title = 0;

  // Against `getPage` above: both run the Feistel network in full, and the
  // difference between them is the 3175 digits a title does not render.
  bench(
    'getTitle — book to its 25-character title',
    () => {
      getTitle(cycle(books, title++));
    },
    benchOptions
  );

  let backward = 0;

  bench(
    'locate — 3200 characters to address',
    () => {
      locate(cycle(pages, backward++));
    },
    benchOptions
  );

  let edge = 0;

  bench(
    'locate — the all-spaces and maximum-value pages',
    () => {
      locate(cycle(edgePages, edge++));
    },
    benchOptions
  );
});

describe('a shelf', () => {
  let shelf = 0;

  /**
   * The number M3's review gate is about: a shelf is 32 spines, their titles
   * are resolved together when the camera gets close enough to read them
   * (architecture §3), and the gate asks whether doing so drops a frame.
   *
   * Measured as one task rather than multiplied up from `getTitle`, because
   * 32 consecutive calls are not 32 independent ones: they share a warm JIT
   * and a warm allocator, and the Feistel network's `bigint` intermediates are
   * the same size every time.
   */
  bench(
    'getTitle × 32 — one shelf of titles',
    () => {
      for (const book of cycle(shelves, shelf++)) {
        getTitle(book);
      }
    },
    benchOptions
  );
});
