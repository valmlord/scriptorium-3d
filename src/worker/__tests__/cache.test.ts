import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  PAGES_PER_BOOK,
  PAGES_PER_ROOM,
  PAGE_LENGTH,
  ROOM_COUNT,
  TITLE_LENGTH,
} from '@core/index';
import type { Address, BookAddress } from '@core/index';
import {
  ByteBudgetedLru,
  GenerationCache,
  PAGE_BUDGET_BYTES,
  TITLE_BUDGET_BYTES,
} from '../cache';

/**
 * The cache is a pure data structure — no clock, no timer, no randomness — so
 * everything below is an example or a property over a generated sequence of
 * operations rather than an assertion about timing.
 *
 * The case counts are written out rather than routed through
 * `src/core/__tests__/property-runs.ts`, for the reason `handler.test.ts`
 * gives: that helper caps properties under Stryker, Stryker's Vitest
 * configuration collects only `src/core/__tests__/**` (ADR-0008), and a cap
 * that can never apply is a misleading name. The fixed seed from
 * `fast-check-setup.ts` does apply — it is a global `setupFiles` entry.
 *
 * **The byte arithmetic is written out here rather than imported from the
 * module under test.** Two bytes per UTF-16 code unit is the fact the budget
 * rests on; importing the module's own constant would make these tests assert
 * the implementation against itself, and a wrong factor would then be
 * invisible. It is duplicated on purpose, and the duplicate is the independent
 * witness.
 */
const BYTES_PER_CHARACTER = 2;

/** What the cache should charge for an entry, computed independently. */
function expectedBytes(key: string, value: string): number {
  return (key.length + value.length) * BYTES_PER_CHARACTER;
}

/**
 * The value the property tests store under a key.
 *
 * A function of the key, so a test can recompute what any stored key costs
 * without reading it back — `get` would promote it and change the recency order
 * the test is about to assert on.
 */
function valueFor(key: string): string {
  return key.repeat(3);
}

/** What the entry for `key` costs when `valueFor` produced its value. */
function costOf(key: string): number {
  return expectedBytes(key, valueFor(key));
}

/** A pool of short ASCII keys of differing lengths, so costs differ too. */
const arbitraryKey: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 63 })
  .map((n) => `k${String(n)}`);

/** A `set` of `valueFor(key)`, or a `get`, which is all the structure does. */
type Operation = { readonly kind: 'set' | 'get'; readonly key: string };

const arbitraryOperation: fc.Arbitrary<Operation> = fc.record({
  kind: fc.constantFrom<'set' | 'get'>('set', 'get'),
  key: arbitraryKey,
});

const arbitraryOperations: fc.Arbitrary<Operation[]> = fc.array(arbitraryOperation, {
  maxLength: 40,
});

/** Replay a sequence onto a cache. The model values make it reproducible. */
function apply(cache: ByteBudgetedLru, operations: readonly Operation[]): void {
  for (const operation of operations) {
    if (operation.kind === 'set') {
      cache.set(operation.key, valueFor(operation.key));
    } else {
      cache.get(operation.key);
    }
  }
}

/** An entry whose cost is the same for every key, so capacity is countable. */
const FIXED_VALUE = 'xxxxx';

/** Keys of equal length, so `FIXED_VALUE` gives every entry the same cost. */
function fixedKey(index: number): string {
  return `key${String(index).padStart(3, '0')}`;
}

const FIXED_ENTRY_BYTES = expectedBytes(fixedKey(0), FIXED_VALUE);

/** A cache holding exactly `capacity` entries of `FIXED_ENTRY_BYTES`, filled. */
function filledToCapacity(capacity: number): ByteBudgetedLru {
  const cache = new ByteBudgetedLru(capacity * FIXED_ENTRY_BYTES);
  for (let index = 0; index < capacity; index += 1) {
    cache.set(fixedKey(index), FIXED_VALUE);
  }
  return cache;
}

describe('the byte ceiling', () => {
  it('is never exceeded, after any sequence of insertions and reads', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        arbitraryOperations,
        (budgetBytes, operations) => {
          const cache = new ByteBudgetedLru(budgetBytes);

          for (const operation of operations) {
            apply(cache, [operation]);

            expect(cache.bytes).toBeLessThanOrEqual(budgetBytes);
          }
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('accounts for exactly the keys and values it is holding', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        arbitraryOperations,
        (budgetBytes, operations) => {
          const cache = new ByteBudgetedLru(budgetBytes);

          apply(cache, operations);

          const accounted = cache
            .keysLeastRecentFirst()
            .reduce((total, key) => total + costOf(key), 0);
          expect(cache.bytes).toBe(accounted);
          expect(cache.size).toBe(cache.keysLeastRecentFirst().length);
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('charges the key as well as the value, because the key is what it holds', () => {
    const key = 'a-key';
    const value = 'a-value';
    const cache = new ByteBudgetedLru(expectedBytes(key, value));

    cache.set(key, value);

    expect(cache.bytes).toBe((key.length + value.length) * BYTES_PER_CHARACTER);
    expect(cache.get(key)).toBe(value);
  });

  it('admits an entry that fills the budget exactly', () => {
    const key = 'exact';
    const value = 'fit';
    const cache = new ByteBudgetedLru(expectedBytes(key, value));

    cache.set(key, value);

    expect(cache.get(key)).toBe(value);
    expect(cache.bytes).toBe(cache.budgetBytes);
  });

  it('does not pay for the same key twice when its value is replaced', () => {
    const cache = new ByteBudgetedLru(1000);
    cache.set('key', 'first');

    cache.set('key', 'second');

    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(expectedBytes('key', 'second'));
    expect(cache.get('key')).toBe('second');
  });
});

describe('recency', () => {
  it('moves an entry to the most-recent end when it is read', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10 }), fc.nat(), (capacity, offset) => {
        const cache = filledToCapacity(capacity);
        const read = fixedKey(offset % capacity);
        const others = cache.keysLeastRecentFirst().filter((key) => key !== read);

        cache.get(read);

        expect(cache.keysLeastRecentFirst()).toEqual([...others, read]);
      }),
      { numRuns: 1000 }
    );
  });

  it('leaves the order untouched when a read misses', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (capacity) => {
        const cache = filledToCapacity(capacity);
        const before = cache.keysLeastRecentFirst();

        const missed = cache.get('a key that was never stored');

        expect(missed).toBeUndefined();
        expect(cache.keysLeastRecentFirst()).toEqual(before);
        expect(cache.bytes).toBe(before.length * FIXED_ENTRY_BYTES);
      }),
      { numRuns: 1000 }
    );
  });

  it('spares a read entry from the next eviction, and takes the next one instead', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10 }), (capacity) => {
        const cache = filledToCapacity(capacity);
        const leastRecent = fixedKey(0);
        const nextLeastRecent = fixedKey(1);

        cache.get(leastRecent);
        // A key of the same length as the others, so the entry admitted costs
        // exactly one entry and the eviction it forces is exactly one.
        cache.set(fixedKey(capacity), FIXED_VALUE);

        expect(cache.keysLeastRecentFirst()).toContain(leastRecent);
        expect(cache.keysLeastRecentFirst()).not.toContain(nextLeastRecent);
      }),
      { numRuns: 1000 }
    );
  });

  it('moves an entry to the most-recent end when its value is replaced', () => {
    const cache = filledToCapacity(3);

    cache.set(fixedKey(0), FIXED_VALUE);

    expect(cache.keysLeastRecentFirst()).toEqual([
      fixedKey(1),
      fixedKey(2),
      fixedKey(0),
    ]);
  });
});

describe('eviction', () => {
  it('takes the least recently used entries, in order, and no others', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        arbitraryOperations,
        arbitraryKey,
        (budgetBytes, operations, admitted) => {
          const cache = new ByteBudgetedLru(budgetBytes);
          apply(cache, operations);
          const before = cache.keysLeastRecentFirst().filter((key) => key !== admitted);
          const value = valueFor(admitted);
          fc.pre(expectedBytes(admitted, value) <= budgetBytes);

          cache.set(admitted, value);

          const after = cache.keysLeastRecentFirst();
          const evicted = before.length + 1 - after.length;
          expect(after).toEqual([...before.slice(evicted), admitted]);
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('takes no more entries than the ceiling requires', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        arbitraryOperations,
        arbitraryKey,
        (budgetBytes, operations, admitted) => {
          const cache = new ByteBudgetedLru(budgetBytes);
          apply(cache, operations);
          const before = cache.keysLeastRecentFirst().filter((key) => key !== admitted);
          fc.pre(costOf(admitted) <= budgetBytes);

          cache.set(admitted, valueFor(admitted));

          const evicted = before.length + 1 - cache.keysLeastRecentFirst().length;
          fc.pre(evicted > 0);
          // Keeping the last entry taken would have broken the ceiling, so
          // taking it was forced rather than chosen.
          const lastTaken = before[evicted - 1] ?? '';
          expect(cache.bytes + costOf(lastTaken)).toBeGreaterThan(budgetBytes);
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('never takes the entry it has just admitted', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        arbitraryOperations,
        arbitraryKey,
        (budgetBytes, operations, admitted) => {
          const cache = new ByteBudgetedLru(budgetBytes);
          apply(cache, operations);
          fc.pre(costOf(admitted) <= budgetBytes);

          cache.set(admitted, valueFor(admitted));

          expect(cache.get(admitted)).toBe(valueFor(admitted));
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('evicts the same entries on every replay of the same operations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        arbitraryOperations,
        (budgetBytes, operations) => {
          const first = new ByteBudgetedLru(budgetBytes);
          const second = new ByteBudgetedLru(budgetBytes);

          apply(first, operations);
          apply(second, operations);

          expect(first.keysLeastRecentFirst()).toEqual(second.keysLeastRecentFirst());
          expect(first.bytes).toBe(second.bytes);
        }
      ),
      { numRuns: 1000 }
    );
  });
});

describe('an entry larger than the whole budget', () => {
  /** A value no budget of `budgetBytes` can hold, whatever the key. */
  function oversizedValue(budgetBytes: number): string {
    return 'x'.repeat(budgetBytes);
  }

  it('is refused, leaving the cache byte for byte as it was', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        arbitraryOperations,
        arbitraryKey,
        (budgetBytes, operations, key) => {
          const cache = new ByteBudgetedLru(budgetBytes);
          apply(cache, operations);
          const before = cache.keysLeastRecentFirst();
          const bytesBefore = cache.bytes;

          cache.set(key, oversizedValue(budgetBytes));

          expect(cache.keysLeastRecentFirst()).toEqual(before);
          expect(cache.bytes).toBe(bytesBefore);
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('does not displace the entry already stored under its key', () => {
    const cache = new ByteBudgetedLru(100);
    cache.set('key', 'kept');

    cache.set('key', oversizedValue(100));

    expect(cache.get('key')).toBe('kept');
    expect(cache.bytes).toBe(expectedBytes('key', 'kept'));
  });

  it('does not empty the cache to make room for itself', () => {
    const cache = filledToCapacity(4);
    const before = cache.keysLeastRecentFirst();

    cache.set('too big', oversizedValue(cache.budgetBytes));

    expect(cache.keysLeastRecentFirst()).toEqual(before);
    expect(cache.size).toBe(4);
    // The refusal is a miss, which is how the caller already learns to compute
    // the value again. An implementation that admitted the entry and then
    // evicted it to get back under the ceiling would also miss here, which is
    // why the entries it would have taken with it are asserted above.
    expect(cache.get('too big')).toBeUndefined();
  });
});

describe('the two budgets', () => {
  /**
   * A room deep enough that its linear index needs the full `PAGE_LENGTH`
   * base-36 digits, which is what a key costs for any room not near the start
   * of the library — a deep link or "open a random book" lands here, not in
   * room 0. Entries are then at their worst cost, so the budgets are filled by
   * the number of entries their derivation claims rather than by many more.
   */
  const deepRoom = (offset: number): bigint => ROOM_COUNT / 2n + BigInt(offset);

  const deepAddress = (offset: number): Address => ({
    room: deepRoom(offset),
    wall: 0,
    shelf: 0,
    volume: 0,
    page: 0,
  });

  const deepBook = (offset: number): BookAddress => ({
    room: deepRoom(offset),
    wall: 0,
    shelf: 0,
    volume: 0,
  });

  const PAGE_TEXT = 'a'.repeat(PAGE_LENGTH);
  const TITLE_TEXT = 'b'.repeat(TITLE_LENGTH);

  /** More volumes than a room holds, so the title budget is certain to evict. */
  const MORE_TITLES_THAN_FIT = (PAGES_PER_ROOM / PAGES_PER_BOOK) * 2;

  /** More pages than a volume holds, so the page budget is certain to evict. */
  const MORE_PAGES_THAN_FIT = PAGES_PER_BOOK * 2;

  it('holds one volume of pages at the worst cost a page entry can have', () => {
    const worstCasePageEntry = (PAGE_LENGTH + PAGE_LENGTH) * BYTES_PER_CHARACTER;

    expect(Math.floor(PAGE_BUDGET_BYTES / worstCasePageEntry)).toBe(PAGES_PER_BOOK);
  });

  it('holds one room of titles at the worst cost a title entry can have', () => {
    const worstCaseTitleEntry = (PAGE_LENGTH + TITLE_LENGTH) * BYTES_PER_CHARACTER;

    expect(Math.floor(TITLE_BUDGET_BYTES / worstCaseTitleEntry)).toBe(
      PAGES_PER_ROOM / PAGES_PER_BOOK
    );
  });

  it('evicts no page when the title budget is filled past its ceiling', () => {
    const cache = new GenerationCache();
    const page = deepAddress(0);
    cache.setPage(page, PAGE_TEXT);
    const pageBytes = cache.pageBytes;

    for (let offset = 0; offset < MORE_TITLES_THAN_FIT; offset += 1) {
      cache.setTitle(deepBook(offset), TITLE_TEXT);
    }

    expect(cache.titleCount).toBeLessThan(MORE_TITLES_THAN_FIT);
    expect(cache.titleBytes).toBeLessThanOrEqual(TITLE_BUDGET_BYTES);
    expect(cache.getPage(page)).toBe(PAGE_TEXT);
    expect(cache.pageCount).toBe(1);
    expect(cache.pageBytes).toBe(pageBytes);
  });

  it('evicts no title when the page budget is filled past its ceiling', () => {
    const cache = new GenerationCache();
    const book = deepBook(0);
    cache.setTitle(book, TITLE_TEXT);
    const titleBytes = cache.titleBytes;

    for (let offset = 0; offset < MORE_PAGES_THAN_FIT; offset += 1) {
      cache.setPage(deepAddress(offset), PAGE_TEXT);
    }

    expect(cache.pageCount).toBeLessThan(MORE_PAGES_THAN_FIT);
    expect(cache.pageBytes).toBeLessThanOrEqual(PAGE_BUDGET_BYTES);
    expect(cache.getTitle(book)).toBe(TITLE_TEXT);
    expect(cache.titleCount).toBe(1);
    expect(cache.titleBytes).toBe(titleBytes);
  });
});

describe('addressing', () => {
  const ADDRESS: Address = { room: 7n, wall: 1, shelf: 2, volume: 3, page: 4 };

  it('keys a page by its address, not by the identity of the address object', () => {
    const cache = new GenerationCache();

    cache.setPage(ADDRESS, 'the text');

    expect(cache.getPage({ ...ADDRESS })).toBe('the text');
  });

  it('keeps the title of a volume and page 0 of that volume apart', () => {
    const cache = new GenerationCache();
    const book: BookAddress = { room: 7n, wall: 1, shelf: 2, volume: 3 };
    const firstPage: Address = { ...book, page: 0 };

    cache.setTitle(book, 'a title');
    cache.setPage(firstPage, 'a page');

    expect(cache.getTitle(book)).toBe('a title');
    expect(cache.getPage(firstPage)).toBe('a page');
    expect(cache.titleBytes).not.toBe(cache.pageBytes);
  });

  it('gives two distinct addresses two distinct entries', () => {
    const components = fc.record({
      room: fc.bigInt({ min: 0n, max: 4n }),
      wall: fc.integer({ min: 0, max: 3 }),
      shelf: fc.integer({ min: 0, max: 4 }),
      volume: fc.integer({ min: 0, max: 31 }),
      page: fc.integer({ min: 0, max: 409 }),
    });

    fc.assert(
      fc.property(components, components, (first, second) => {
        fc.pre(
          JSON.stringify(first, replaceBigInt) !== JSON.stringify(second, replaceBigInt)
        );
        const cache = new GenerationCache();

        cache.setPage(first, 'the first page');

        expect(cache.getPage(second)).toBeUndefined();
      }),
      { numRuns: 1000 }
    );
  });
});

/** `JSON.stringify` throws on a `bigint`; the tests only need equality. */
function replaceBigInt(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
