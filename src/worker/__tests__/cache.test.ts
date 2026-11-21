import { afterEach, describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import {
  BOOKS_PER_SHELF,
  PAGES_PER_BOOK,
  PAGES_PER_ROOM,
  PAGE_LENGTH,
  ROOM_COUNT,
  SHELVES_PER_WALL,
  TITLE_LENGTH,
  WALLS_PER_ROOM,
  fromLinear,
  roomFromName,
  roomToName,
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

/**
 * The key format, written out for the same reason: a key is the room's
 * canonical name (SPEC §3), this separator, and the page's index within the
 * room in base 36.
 */
const KEY_SEPARATOR = ':';

/** The index of a page within its room, by the SPEC §3 ordering. */
function indexWithinRoom(address: Address): number {
  const volumeInRoom =
    (address.wall * SHELVES_PER_WALL + address.shelf) * BOOKS_PER_SHELF +
    address.volume;
  return volumeInRoom * PAGES_PER_BOOK + address.page;
}

/** How long the key of `address` must be, from the SPEC's constants alone. */
function expectedKeyLength(address: Address): number {
  return (
    roomToName(address.room).length +
    KEY_SEPARATOR.length +
    indexWithinRoom(address).toString(36).length
  );
}

/**
 * The longest key: the last room's name, the separator, and the largest index
 * a room has.
 */
const LONGEST_KEY_LENGTH =
  roomToName(ROOM_COUNT - 1n).length +
  KEY_SEPARATOR.length +
  (PAGES_PER_ROOM - 1).toString(36).length;

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
   * A room deep enough that its name is as long as the last room's, 3197
   * base-36 digits, which is what a key costs for any room not near the start
   * of the library — a deep link or "open a random book" lands here, not in
   * room 0. Entries are then near their worst cost, so the budgets are filled
   * by about the number of entries their derivation claims rather than by many
   * more.
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
    const worstCasePageEntry = (LONGEST_KEY_LENGTH + PAGE_LENGTH) * BYTES_PER_CHARACTER;

    expect(Math.floor(PAGE_BUDGET_BYTES / worstCasePageEntry)).toBe(PAGES_PER_BOOK);
  });

  it('holds one room of titles at the worst cost a title entry can have', () => {
    const worstCaseTitleEntry =
      (LONGEST_KEY_LENGTH + TITLE_LENGTH) * BYTES_PER_CHARACTER;

    expect(Math.floor(TITLE_BUDGET_BYTES / worstCaseTitleEntry)).toBe(
      PAGES_PER_ROOM / PAGES_PER_BOOK
    );
  });

  it('the last volume of room ROOM_COUNT - 2 keeps all 410 of its pages', () => {
    // The last volume of a room has the longest indices, and ROOM_COUNT - 2 is
    // the deepest room that holds one whole: the last room stops short of it.
    const pages: Address[] = Array.from({ length: PAGES_PER_BOOK }, (_, page) => ({
      room: ROOM_COUNT - 2n,
      wall: WALLS_PER_ROOM - 1,
      shelf: SHELVES_PER_WALL - 1,
      volume: BOOKS_PER_SHELF - 1,
      page,
    }));
    const cache = new GenerationCache();

    for (const page of pages) {
      cache.setPage(page, PAGE_TEXT);
    }

    expect(cache.pageCount).toBe(PAGES_PER_BOOK);
    expect(cache.pageBytes).toBe(
      pages.reduce(
        (total, page) =>
          total + (expectedKeyLength(page) + PAGE_LENGTH) * BYTES_PER_CHARACTER,
        0
      )
    );
  });

  it('a deep room keeps all 640 of its titles', () => {
    const volumesPerRoom = WALLS_PER_ROOM * SHELVES_PER_WALL * BOOKS_PER_SHELF;
    const books: BookAddress[] = Array.from({ length: volumesPerRoom }, (_, index) => ({
      room: deepRoom(0),
      wall: Math.floor(index / (SHELVES_PER_WALL * BOOKS_PER_SHELF)),
      shelf: Math.floor(index / BOOKS_PER_SHELF) % SHELVES_PER_WALL,
      volume: index % BOOKS_PER_SHELF,
    }));
    const cache = new GenerationCache();

    for (const book of books) {
      cache.setTitle(book, TITLE_TEXT);
    }

    expect(cache.titleCount).toBe(volumesPerRoom);
    expect(cache.titleBytes).toBe(
      books.reduce(
        (total, book) =>
          total +
          (expectedKeyLength({ ...book, page: 0 }) + TITLE_LENGTH) *
            BYTES_PER_CHARACTER,
        0
      )
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

describe('keys', () => {
  /** Room 0, the last room and anything between: names of every length. */
  const arbitraryRoom: fc.Arbitrary<bigint> = fc.oneof(
    fc.constant(0n),
    fc.constant(ROOM_COUNT - 1n),
    fc.bigInt({ min: 0n, max: ROOM_COUNT - 1n })
  );

  /** Both ends of a room and anything between: indices of every length. */
  const arbitraryIndex: fc.Arbitrary<number> = fc.oneof(
    fc.constant(0),
    fc.constant(PAGES_PER_ROOM - 1),
    fc.integer({ min: 0, max: PAGES_PER_ROOM - 1 })
  );

  /** The address of page `index` within `room`, by the SPEC §3 ordering. */
  function addressAt(room: bigint, index: number): Address {
    return fromLinear(room * BigInt(PAGES_PER_ROOM) + BigInt(index));
  }

  it('property: a key decodes back to the room and the index within the room it was made from', () => {
    // A decode rather than a comparison of two keys: a pair property stays
    // green with the separator dropped, because colliding pairs are too rare
    // for a generator to draw, while a key that cannot be split is red at once.
    fc.assert(
      fc.property(arbitraryRoom, arbitraryIndex, (room, index) => {
        const key = new GenerationCache().keyOf(addressAt(room, index));

        const parts = key.split(KEY_SEPARATOR);

        expect(parts).toHaveLength(2);
        const [roomPart = '', indexPart = ''] = parts;
        expect(roomFromName(roomPart)).toBe(room);
        expect(roomPart).toBe(roomToName(room));
        expect(Number.parseInt(indexPart, 36)).toBe(index);
        expect(indexPart).toBe(index.toString(36));
      }),
      { numRuns: 1000 }
    );
  });

  it('property: a key decodes to its own room and index when earlier keys have warmed the memo', () => {
    // One cache for every case, unlike the property above: there each key is
    // the first its cache makes, so the room-name memo is always empty and a
    // memo that answers with another room's name stays green. Here every key
    // after the first is made with the memo holding other rooms. The second
    // arm draws from four rooms so that consecutive keys revisit them and
    // both memo entries are hit and displaced. Because the cache outlives each
    // case, a reported counterexample reproduces only after the cases before
    // it, which the pinned seed replays.
    const cache = new GenerationCache();
    const revisitedRoom = fc.oneof(arbitraryRoom, fc.bigInt({ min: 0n, max: 3n }));
    const keysInOrder = fc.array(fc.tuple(revisitedRoom, arbitraryIndex), {
      minLength: 1,
      maxLength: 6,
    });

    fc.assert(
      fc.property(keysInOrder, (keys) => {
        for (const [room, index] of keys) {
          const parts = cache.keyOf(addressAt(room, index)).split(KEY_SEPARATOR);

          expect(parts).toEqual([roomToName(room), index.toString(36)]);
        }
      }),
      { numRuns: 1000 }
    );
  });

  it('room 1 index 71 and room 37 index 35 have different keys', () => {
    // Both are `11z` with the separator dropped: `1` + `1z` and `11` + `z`.
    const cache = new GenerationCache();

    const first = cache.keyOf(addressAt(1n, 71));
    const second = cache.keyOf(addressAt(37n, 35));

    expect(first).not.toBe(second);
  });

  it('property: room.toString(36) equals roomToName(room) for every valid room', () => {
    // The cache renders the room with `toString(36)` because `roomToName`
    // throws on a negative room; this is what lets it do so on a valid one.
    fc.assert(
      fc.property(arbitraryRoom, (room) => {
        expect(room.toString(36)).toBe(roomToName(room));
      }),
      { numRuns: 1000 }
    );
  });
});

describe('the room-name memo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A room whose name is 3197 digits, so converting it is the cost at stake. */
  const DEEP_ROOM = ROOM_COUNT / 2n;
  const OTHER_DEEP_ROOM = DEEP_ROOM + 1n;

  /** Volume `volume` of shelf 0 on wall 0 of `room`. */
  function bookAt(room: bigint, volume: number): BookAddress {
    return { room, wall: 0, shelf: 0, volume };
  }

  /**
   * How many times `room` itself was converted to a string. Filtered by the
   * receiver because every key also converts its index within the room, which
   * is a different `bigint`: unfiltered, a shelf of 32 keys counts 33 calls.
   */
  function conversionsOf(spy: { mock: { contexts: unknown[] } }, room: bigint): number {
    return spy.mock.contexts.filter((context) => context === room).length;
  }

  it("a shelf's 32 keys convert the room once", () => {
    const cache = new GenerationCache();
    const toString = vi.spyOn(BigInt.prototype, 'toString');

    for (let volume = 0; volume < BOOKS_PER_SHELF; volume += 1) {
      cache.getTitle(bookAt(DEEP_ROOM, volume));
    }

    expect(conversionsOf(toString, DEEP_ROOM)).toBe(1);
  });

  it('keys from two interleaved rooms convert each room once', () => {
    const cache = new GenerationCache();
    const toString = vi.spyOn(BigInt.prototype, 'toString');

    for (let volume = 0; volume < BOOKS_PER_SHELF; volume += 1) {
      cache.getTitle(bookAt(DEEP_ROOM, volume));
      cache.getTitle(bookAt(OTHER_DEEP_ROOM, volume));
    }

    expect(conversionsOf(toString, DEEP_ROOM)).toBe(1);
    expect(conversionsOf(toString, OTHER_DEEP_ROOM)).toBe(1);
  });

  it("a third room's shelf converts that room once with two other rooms remembered", () => {
    // The tests above start from an empty memo, where a memo that never
    // admits a room past its second passes them all.
    const cache = new GenerationCache();
    cache.getTitle(bookAt(5n, 0));
    cache.getTitle(bookAt(7n, 0));
    const toString = vi.spyOn(BigInt.prototype, 'toString');

    for (let volume = 0; volume < BOOKS_PER_SHELF; volume += 1) {
      cache.getTitle(bookAt(DEEP_ROOM, volume));
    }

    expect(conversionsOf(toString, DEEP_ROOM)).toBe(1);
  });

  it('remembers the two most recently used rooms and converts the third again', () => {
    // Room 5 is used again after room 7, so room 9 displaces room 7.
    const cache = new GenerationCache();
    for (const room of [5n, 7n, 5n, 9n]) {
      cache.getTitle(bookAt(room, 0));
    }
    const toString = vi.spyOn(BigInt.prototype, 'toString');

    cache.getTitle(bookAt(5n, 1));
    cache.getTitle(bookAt(9n, 1));
    cache.getTitle(bookAt(7n, 1));

    expect(conversionsOf(toString, 5n)).toBe(0);
    expect(conversionsOf(toString, 9n)).toBe(0);
    expect(conversionsOf(toString, 7n)).toBe(1);
  });

  /** Page 0 of volume 0 of shelf 0 on wall 0 of `room`: index 0 within it. */
  function firstPageOf(room: bigint): Address {
    return { room, wall: 0, shelf: 0, volume: 0, page: 0 };
  }

  it('a page of room 9 read after pages of rooms 5 and 7 is a miss, not either of theirs', () => {
    // Regression: a memo that returned its second entry without checking the
    // room gave room 9 the key of room 5, and this read returned room 5's text.
    const cache = new GenerationCache();
    cache.setPage(firstPageOf(5n), 'TEXT OF ROOM 5');
    cache.setPage(firstPageOf(7n), 'TEXT OF ROOM 7');

    const ninth = cache.getPage(firstPageOf(9n));

    expect(ninth).toBeUndefined();
    expect(cache.getPage(firstPageOf(5n))).toBe('TEXT OF ROOM 5');
    expect(cache.getPage(firstPageOf(7n))).toBe('TEXT OF ROOM 7');
  });

  it('property: with the memo warm across rooms, a page set is read back as its own text', () => {
    // One cache for every case, so the memo is never cold after the first
    // read. Six rooms and a dozen pages in each, so reads revisit pages set
    // earlier, in this case or a previous one, with other rooms in between.
    // Nothing is evicted: the 72 reachable pages hold under 0.5 MB against
    // PAGE_BUDGET_BYTES, so a page that has been set must read back exactly,
    // and a miss is only a page no step has set yet. That is what catches a
    // memo that gives a page's set and its get different keys.
    const cache = new GenerationCache();
    const setPages = new Set<string>();
    const revisitedRoom = fc.constantFrom(0n, 5n, 7n, 9n, DEEP_ROOM, OTHER_DEEP_ROOM);
    const revisitedPage: fc.Arbitrary<Address> = fc.record({
      room: revisitedRoom,
      wall: fc.integer({ min: 0, max: 1 }),
      shelf: fc.constant(0),
      volume: fc.integer({ min: 0, max: 1 }),
      page: fc.integer({ min: 0, max: 2 }),
    });
    const operation = fc.record({
      kind: fc.constantFrom<'set' | 'get'>('set', 'get'),
      address: revisitedPage,
    });
    /** Unique per address, so a text names the page it was stored for. */
    const textOf = (address: Address): string => JSON.stringify(address, replaceBigInt);

    fc.assert(
      fc.property(fc.array(operation, { minLength: 1, maxLength: 8 }), (operations) => {
        for (const { kind, address } of operations) {
          if (kind === 'set') {
            cache.setPage(address, textOf(address));
            setPages.add(textOf(address));
          }

          const read = cache.getPage(address);

          expect(read).toBe(
            setPages.has(textOf(address)) ? textOf(address) : undefined
          );
        }
      }),
      { numRuns: 1000 }
    );
  });
});

/** `JSON.stringify` throws on a `bigint`; the tests only need equality. */
function replaceBigInt(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
