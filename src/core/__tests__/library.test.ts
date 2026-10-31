import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  BOOKS_PER_SHELF,
  LIBRARY_SIZE,
  PAGES_IN_LAST_ROOM,
  PAGES_PER_BOOK,
  PAGES_PER_ROOM,
  PAGE_LENGTH,
  ROOM_COUNT,
  SHELVES_PER_WALL,
  WALLS_PER_ROOM,
  fromLinear,
  toLinear,
  type Address,
} from '../address';
import { PAGE_ALPHABET, digitToSymbol, normalize } from '../alphabet';
import { intToDigits } from '../bignum';
import {
  AddressBeyondLibraryError,
  InvalidPageLengthError,
  InvalidSearchOffsetError,
  InvalidSearchQueryError,
  UnknownSymbolError,
} from '../errors';
import {
  FORMAT_VERSION,
  TITLE_LENGTH,
  defaultRandomSource,
  getPage,
  getTitle,
  locate,
  randomAddress,
  search,
  type RandomSource,
} from '../library';

const SPACE = digitToSymbol(PAGE_ALPHABET, 0);

/**
 * A property test over 1000 cases of a 16544-bit permutation is seconds of
 * real work, and several times that under the v8 coverage instrumentation of
 * `npm run coverage`. Vitest's 5-second default is sized for unit tests, so
 * the three properties that testing.md §2 requires to run at >= 1000 cases
 * carry an explicit budget instead. This raises no bar and weakens no
 * assertion: the run count stays at 1000 and a wrong bijection still fails.
 */
const PROPERTY_TIMEOUT_MS = 120_000;

/** Every page in the library, with both ends of the domain reached on purpose. */
const validLinear = fc.oneof(
  { arbitrary: fc.constant(0n), weight: 1 },
  { arbitrary: fc.constant(1n), weight: 1 },
  { arbitrary: fc.constant(LIBRARY_SIZE - 1n), weight: 1 },
  { arbitrary: fc.bigInt({ min: 0n, max: LIBRARY_SIZE - 1n }), weight: 12 }
);

const validAddress: fc.Arbitrary<Address> = validLinear.map(fromLinear);

/** A page of text: a uniform value in `[0, N)` rendered at full width. */
const validPage: fc.Arbitrary<string> = validLinear.map((value) =>
  intToDigits(value, PAGE_ALPHABET, PAGE_LENGTH)
);

/**
 * A deterministic byte source, so that tests covering the two random
 * user-facing choices are reproducible. A 64-bit xorshift is plenty: these
 * bytes pick a book, not a key.
 */
const seededRandomSource = (seed: bigint): RandomSource => {
  const mask = (1n << 64n) - 1n;
  // The seed is mixed before use: a bare `seed | 1n` would give consecutive
  // seeds the same state, and a test asserting that two sources differ would
  // then fail for a reason that has nothing to do with the library.
  let state = ((seed * 0x9e3779b97f4a7c15n) & mask) | 1n;
  return (byteLength: number): Uint8Array => {
    const bytes = new Uint8Array(byteLength);
    for (let i = 0; i < byteLength; i++) {
      state = (state ^ (state << 13n)) & mask;
      state = state ^ (state >> 7n);
      state = (state ^ (state << 17n)) & mask;
      bytes[i] = Number(state & 0xffn);
    }
    return bytes;
  };
};

/** The address one page past the end of the library: the first invalid one. */
const firstInvalidAddress: Address = (() => {
  const lastRoom = ROOM_COUNT - 1n;
  const offsetInRoom = PAGES_IN_LAST_ROOM; // one past the last real page
  const bookIndex = offsetInRoom / BigInt(PAGES_PER_BOOK);
  const page = Number(offsetInRoom % BigInt(PAGES_PER_BOOK));
  const volume = Number(bookIndex % BigInt(BOOKS_PER_SHELF));
  const shelfIndex = bookIndex / BigInt(BOOKS_PER_SHELF);
  return {
    room: lastRoom,
    wall: Number(shelfIndex / BigInt(SHELVES_PER_WALL)),
    shelf: Number(shelfIndex % BigInt(SHELVES_PER_WALL)),
    volume,
    page,
  };
})();

describe('SPEC §5 constants', () => {
  it('exports FORMAT_VERSION 1, carried in every shareable URL', () => {
    expect(FORMAT_VERSION).toBe(1);
  });

  it('defines a title as the first 25 characters of page 0', () => {
    expect(TITLE_LENGTH).toBe(25);
  });
});

describe('getPage', () => {
  it('returns exactly PAGE_LENGTH characters for every address', () => {
    fc.assert(
      fc.property(validAddress, (address) => {
        expect(getPage(address)).toHaveLength(PAGE_LENGTH);
      }),
      { numRuns: 120 }
    );
  });

  it('returns only characters from the page alphabet', () => {
    fc.assert(
      fc.property(validAddress, (address) => {
        for (const character of getPage(address)) {
          expect(PAGE_ALPHABET.digitBySymbol.has(character)).toBe(true);
        }
      }),
      { numRuns: 40 }
    );
  });

  it('rejects an address in the unfilled tail of the last room', () => {
    expect(() => getPage(firstInvalidAddress)).toThrow(AddressBeyondLibraryError);
  });

  it('rejects an out-of-range component before generating anything', () => {
    expect(() =>
      getPage({ room: 0n, wall: WALLS_PER_ROOM, shelf: 0, volume: 0, page: 0 })
    ).toThrow(/wall/);
    expect(() =>
      getPage({ room: 0n, wall: 0, shelf: 0, volume: 0, page: PAGES_PER_BOOK })
    ).toThrow(/page/);
  });

  it('gives different pages to neighbouring addresses', () => {
    const first = getPage({ room: 0n, wall: 0, shelf: 0, volume: 0, page: 0 });
    const second = getPage({ room: 0n, wall: 0, shelf: 0, volume: 0, page: 1 });

    expect(first).not.toBe(second);
  });
});

describe('locate', () => {
  it('refuses a page that is not PAGE_LENGTH characters long', () => {
    expect(() => locate('')).toThrow(InvalidPageLengthError);
    expect(() => locate(SPACE.repeat(PAGE_LENGTH - 1))).toThrow(InvalidPageLengthError);
    expect(() => locate(SPACE.repeat(PAGE_LENGTH + 1))).toThrow(InvalidPageLengthError);
  });

  it('reports the length it received, so the caller can see the shortfall', () => {
    try {
      locate(SPACE.repeat(10));
      expect.unreachable('locate should have refused a 10-character page');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPageLengthError);
      const lengthError = error as InvalidPageLengthError;
      expect(lengthError.expected).toBe(PAGE_LENGTH);
      expect(lengthError.received).toBe(10);
    }
  });

  it('counts length in code points, not UTF-16 units', () => {
    // An astral character is two UTF-16 units but one code point, so a page
    // padded with one is the right length and holds an unknown symbol — it is
    // not silently the wrong length.
    const withAstral = `\u{1F4D6}${SPACE.repeat(PAGE_LENGTH - 1)}`;

    expect(withAstral.length).toBe(PAGE_LENGTH + 1);
    expect(() => locate(withAstral)).toThrow(UnknownSymbolError);
  });

  it('names every character outside the alphabet, with its position', () => {
    const page = `x${SPACE.repeat(PAGE_LENGTH - 2)}y`;

    try {
      locate(page);
      expect.unreachable('locate should have refused a page with unknown symbols');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownSymbolError);
      const symbolError = error as UnknownSymbolError;
      expect(symbolError.symbols).toEqual([
        { symbol: 'x', index: 0 },
        { symbol: 'y', index: PAGE_LENGTH - 1 },
      ]);
    }
  });
});

describe('the bijection holds in both directions', () => {
  it(
    'locate(getPage(address)) === address over at least 1000 addresses',
    () => {
      fc.assert(
        fc.property(validAddress, (address) => {
          expect(locate(getPage(address))).toEqual(address);
        }),
        { numRuns: 1000 }
      );
    },
    PROPERTY_TIMEOUT_MS
  );

  it(
    'getPage(locate(page)) === page over at least 1000 pages',
    () => {
      fc.assert(
        fc.property(validPage, (page) => {
          expect(getPage(locate(page))).toBe(page);
        }),
        { numRuns: 1000 }
      );
    },
    PROPERTY_TIMEOUT_MS
  );
});

describe('domain edges', () => {
  it('round-trips room 0, the very first address in the library', () => {
    const first: Address = { room: 0n, wall: 0, shelf: 0, volume: 0, page: 0 };

    expect(toLinear(first)).toBe(0n);
    expect(locate(getPage(first))).toEqual(first);
  });

  it('round-trips the last address of room 0', () => {
    const last: Address = {
      room: 0n,
      wall: WALLS_PER_ROOM - 1,
      shelf: SHELVES_PER_WALL - 1,
      volume: BOOKS_PER_SHELF - 1,
      page: PAGES_PER_BOOK - 1,
    };

    expect(toLinear(last)).toBe(BigInt(PAGES_PER_ROOM) - 1n);
    expect(locate(getPage(last))).toEqual(last);
  });

  it('round-trips the last legal address in the partially filled final room', () => {
    const last = fromLinear(LIBRARY_SIZE - 1n);

    expect(last.room).toBe(ROOM_COUNT - 1n);
    expect(toLinear(last)).toBe(LIBRARY_SIZE - 1n);
    expect(locate(getPage(last))).toEqual(last);
  });

  it('refuses the first invalid address, one page past the end of the library', () => {
    expect(firstInvalidAddress.room).toBe(ROOM_COUNT - 1n);
    expect(toLinear(firstInvalidAddress)).toBe(LIBRARY_SIZE);

    expect(() => getPage(firstInvalidAddress)).toThrow(AddressBeyondLibraryError);
  });

  it('locates a page of 3200 index-0 symbols, where leading zeros break', () => {
    const allSpaces = SPACE.repeat(PAGE_LENGTH);

    const address = locate(allSpaces);

    expect(getPage(address)).toBe(allSpaces);
  });

  it('locates the page holding the value one below 36^3200', () => {
    const lastPage = intToDigits(LIBRARY_SIZE - 1n, PAGE_ALPHABET, PAGE_LENGTH);

    const address = locate(lastPage);

    expect(lastPage).toBe('.'.repeat(PAGE_LENGTH));
    expect(getPage(address)).toBe(lastPage);
  });

  it('round-trips the first page of the last room', () => {
    const firstOfLastRoom: Address = {
      room: ROOM_COUNT - 1n,
      wall: 0,
      shelf: 0,
      volume: 0,
      page: 0,
    };

    expect(locate(getPage(firstOfLastRoom))).toEqual(firstOfLastRoom);
  });
});

describe('getTitle', () => {
  it('is the first 25 characters of page 0 of that book', () => {
    const book = { room: 42n, wall: 1, shelf: 2, volume: 3 };

    expect(getTitle(book)).toBe(getPage({ ...book, page: 0 }).slice(0, TITLE_LENGTH));
    expect(getTitle(book)).toHaveLength(TITLE_LENGTH);
  });

  it('ignores any page field already on the object it is handed', () => {
    const book = { room: 42n, wall: 1, shelf: 2, volume: 3 };

    expect(getTitle({ ...book, page: 409 } as never)).toBe(getTitle(book));
  });

  it('gives different titles to neighbouring volumes', () => {
    expect(getTitle({ room: 7n, wall: 0, shelf: 0, volume: 0 })).not.toBe(
      getTitle({ room: 7n, wall: 0, shelf: 0, volume: 1 })
    );
  });
});

describe('search', () => {
  const query = fc
    .array(fc.integer({ min: 0, max: 35 }), { minLength: 1, maxLength: 60 })
    .map((digits) =>
      digits.map((digit) => digitToSymbol(PAGE_ALPHABET, digit)).join('')
    );

  it(
    'puts the query at the offset it reports, over at least 1000 cases',
    () => {
      fc.assert(
        fc.property(
          query,
          fc.constantFrom<'spaces' | 'random'>('spaces', 'random'),
          fc.integer({ min: 0, max: 3139 }),
          fc.bigInt({ min: 1n, max: 2n ** 63n }),
          (text, mode, rawOffset, seed) => {
            const offset = Math.min(rawOffset, PAGE_LENGTH - text.length);

            const hit = search(text, mode, offset, seededRandomSource(seed));

            expect(hit.offset).toBe(offset);
            expect(getPage(hit.address).slice(offset, offset + text.length)).toBe(text);
          }
        ),
        { numRuns: 1000 }
      );
    },
    PROPERTY_TIMEOUT_MS
  );

  it('pads with spaces in "spaces" mode and leaves nothing else behind', () => {
    const hit = search('книга', 'spaces', 100);
    const page = getPage(hit.address);

    expect(page.slice(0, 100)).toBe(SPACE.repeat(100));
    expect(page.slice(105)).toBe(SPACE.repeat(PAGE_LENGTH - 105));
  });

  it('pads with alphabet symbols in "random" mode', () => {
    const hit = search('книга', 'random', 100, seededRandomSource(99n));
    const page = getPage(hit.address);

    expect(page.slice(100, 105)).toBe('книга');
    for (const character of page) {
      expect(PAGE_ALPHABET.digitBySymbol.has(character)).toBe(true);
    }
    expect(page.slice(0, 100)).not.toBe(SPACE.repeat(100));
  });

  it('chooses an offset when none is given, and reports the one it chose', () => {
    const hit = search('слово', 'spaces', undefined, seededRandomSource(7n));

    expect(hit.offset).toBeGreaterThanOrEqual(0);
    expect(hit.offset).toBeLessThanOrEqual(PAGE_LENGTH - 5);
    expect(getPage(hit.address).slice(hit.offset, hit.offset + 5)).toBe('слово');
  });

  it('accepts a query that fills the whole page, leaving no padding', () => {
    const text = intToDigits(LIBRARY_SIZE / 2n, PAGE_ALPHABET, PAGE_LENGTH);

    const hit = search(text, 'random', 0, seededRandomSource(3n));

    expect(hit.offset).toBe(0);
    expect(getPage(hit.address)).toBe(text);
    expect(hit.address).toEqual(locate(text));
  });

  it('chooses offset 0 for a full-page query, the only offset that fits', () => {
    // The random offset is drawn from `[0, 1)`, which has exactly one member.
    // A draw over a single-element range must not consume randomness or loop.
    const text = intToDigits(LIBRARY_SIZE / 3n, PAGE_ALPHABET, PAGE_LENGTH);

    const hit = search(text, 'spaces', undefined, () => {
      throw new Error('a single-offset range must not draw random bytes');
    });

    expect(hit.offset).toBe(0);
    expect(getPage(hit.address)).toBe(text);
  });

  it('places a query at the very last offset that still fits', () => {
    const hit = search('я', 'spaces', PAGE_LENGTH - 1);

    expect(getPage(hit.address).slice(PAGE_LENGTH - 1)).toBe('я');
  });

  it('finds a book by its title, which is search with no second mechanism', () => {
    const book = { room: 5n, wall: 0, shelf: 1, volume: 2 };
    const title = getTitle(book);

    const hit = search(title, 'spaces', 0);

    expect(getPage(hit.address).slice(0, TITLE_LENGTH)).toBe(title);
  });

  it('refuses an empty query rather than returning an arbitrary page', () => {
    expect(() => search('', 'spaces', 0)).toThrow(InvalidSearchQueryError);
  });

  it('refuses a query longer than a page', () => {
    try {
      search(SPACE.repeat(PAGE_LENGTH + 1), 'spaces', 0);
      expect.unreachable('search should have refused an over-long query');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidSearchQueryError);
      const queryError = error as InvalidSearchQueryError;
      expect(queryError.length).toBe(PAGE_LENGTH + 1);
      expect(queryError.max).toBe(PAGE_LENGTH);
    }
  });

  it('refuses an offset that would push the query past the end of the page', () => {
    try {
      search('книга', 'spaces', PAGE_LENGTH - 4);
      expect.unreachable('search should have refused an offset that does not fit');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidSearchOffsetError);
      const offsetError = error as InvalidSearchOffsetError;
      expect(offsetError.offset).toBe(PAGE_LENGTH - 4);
      expect(offsetError.queryLength).toBe(5);
      expect(offsetError.maxOffset).toBe(PAGE_LENGTH - 5);
    }
  });

  it('refuses a negative or fractional offset', () => {
    expect(() => search('книга', 'spaces', -1)).toThrow(InvalidSearchOffsetError);
    expect(() => search('книга', 'spaces', 1.5)).toThrow(InvalidSearchOffsetError);
    expect(() => search('книга', 'spaces', Number.NaN)).toThrow(
      InvalidSearchOffsetError
    );
  });

  it('refuses characters outside the alphabet, naming all of them', () => {
    try {
      search('кoтq', 'spaces', 0);
      expect.unreachable('search should have refused Latin homoglyphs');
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownSymbolError);
      const symbolError = error as UnknownSymbolError;
      // `o` is a Latin homoglyph of `о` and `q` has no Cyrillic lookalike at
      // all. Neither is substituted: silently fixing them would send the
      // reader to a different book than the one they asked for (SPEC §2).
      expect(symbolError.symbols).toEqual([
        { symbol: 'o', index: 1 },
        { symbol: 'q', index: 3 },
      ]);
    }
  });

  it('takes the query exactly as given: normalizing is the caller‘s job', () => {
    // SPEC §2 puts normalization at the caller, because it is the caller that
    // must decide whether to reject or strip what `normalize` reports.
    expect(() => search('Книга', 'spaces', 0)).toThrow(UnknownSymbolError);

    const normalized = normalize('Книга');

    expect(normalized.unknown).toHaveLength(0);
    expect(() => search(normalized.text, 'spaces', 0)).not.toThrow();
  });

  it('keeps ё distinct from е, so the two reach different books', () => {
    const withYo = search('ёлка', 'spaces', 0);
    const withYe = search('елка', 'spaces', 0);

    expect(withYo.address).not.toEqual(withYe.address);
  });
});

describe('randomAddress', () => {
  it('returns an address the library actually holds', () => {
    for (let draw = 0; draw < 25; draw++) {
      const address = randomAddress(seededRandomSource(BigInt(draw) + 1n));

      expect(() => getPage(address)).not.toThrow();
      expect(toLinear(address)).toBeLessThan(LIBRARY_SIZE);
    }
  });

  it('is reproducible when the byte source is', () => {
    expect(randomAddress(seededRandomSource(1234n))).toEqual(
      randomAddress(seededRandomSource(1234n))
    );
  });

  it('gives different addresses from different byte sources', () => {
    const rooms = new Set(
      Array.from({ length: 10 }, (_unused, index) =>
        randomAddress(seededRandomSource(BigInt(index) + 1n)).room.toString()
      )
    );

    expect(rooms.size).toBe(10);
  });

  it('works without being handed a source at all', () => {
    const address = randomAddress();

    expect(() => getPage(address)).not.toThrow();
  });

  it('redraws rather than reducing when a draw lands outside the library', () => {
    // The first draw is all-ones, which masks to 2^16544 - 1 and so exceeds
    // 36^3200; a biased implementation would fold it back into range instead
    // of discarding it. The second draw is all-zeros, giving address 0.
    let draws = 0;
    const source: RandomSource = (byteLength: number): Uint8Array => {
      draws++;
      return new Uint8Array(byteLength).fill(draws === 1 ? 0xff : 0x00);
    };

    const address = randomAddress(source);

    expect(draws).toBe(2);
    expect(address).toEqual(fromLinear(0n));
  });

  it('refuses a byte source that returns the wrong number of bytes', () => {
    const short: RandomSource = (byteLength: number): Uint8Array =>
      new Uint8Array(byteLength - 1);

    expect(() => randomAddress(short)).toThrow(RangeError);
    expect(() => randomAddress(short)).toThrow(/expected/);
  });
});

describe('defaultRandomSource', () => {
  it('returns the number of bytes it was asked for', () => {
    expect(defaultRandomSource(0)).toHaveLength(0);
    expect(defaultRandomSource(32)).toHaveLength(32);
  });

  it('returns byte values, and not the same one every time', () => {
    const bytes = defaultRandomSource(4096);

    for (const byte of bytes) {
      expect(byte).toBeGreaterThanOrEqual(0);
      expect(byte).toBeLessThanOrEqual(255);
    }
    expect(new Set(bytes).size).toBeGreaterThan(1);
  });
});

describe('symbol distribution', () => {
  it('is uniform across the alphabet within tolerance', () => {
    // Pages are the output of a hash-driven permutation, so every symbol
    // should appear about 1/36 of the time. Asserted with Pearson's
    // chi-squared over a fixed sample: with 35 degrees of freedom the 0.1%
    // critical value is 66.62, so a statistic above that would mean the
    // generated text is measurably not uniform. The sample is a fixed list of
    // addresses, so this test is deterministic and cannot flake.
    const sampleSize = 40;
    const counts = new Map<string, number>();

    for (let index = 0; index < sampleSize; index++) {
      const address = fromLinear(BigInt(index) * (LIBRARY_SIZE / BigInt(sampleSize)));
      for (const character of getPage(address)) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
      }
    }

    const total = sampleSize * PAGE_LENGTH;
    const expectedPerSymbol = total / PAGE_ALPHABET.radix;
    let chiSquared = 0;
    for (const symbol of PAGE_ALPHABET.symbols) {
      const observed = counts.get(symbol) ?? 0;
      chiSquared += (observed - expectedPerSymbol) ** 2 / expectedPerSymbol;
    }

    expect(counts.size).toBe(PAGE_ALPHABET.radix);
    expect(chiSquared).toBeLessThan(66.62);
  });
});
