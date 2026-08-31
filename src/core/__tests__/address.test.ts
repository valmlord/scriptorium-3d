import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  BOOKS_PER_SHELF,
  LIBRARY_SIZE,
  PAGE_LENGTH,
  PAGES_IN_LAST_ROOM,
  PAGES_PER_BOOK,
  PAGES_PER_ROOM,
  ROOM_COUNT,
  SHELVES_PER_WALL,
  WALLS_PER_ROOM,
  assertValidAddress,
  fromLinear,
  isCanonicalRoomName,
  roomFromName,
  roomToName,
  toLinear,
  type Address,
} from '../address';
import {
  AddressBeyondLibraryError,
  InvalidAddressError,
  UnknownSymbolError,
} from '../errors';

/** A generator of valid addresses, reaching the edges of every component. */
const validAddress: fc.Arbitrary<Address> = fc
  .record({
    room: fc.bigInt({ min: 0n, max: ROOM_COUNT - 1n }),
    wall: fc.integer({ min: 0, max: WALLS_PER_ROOM - 1 }),
    shelf: fc.integer({ min: 0, max: SHELVES_PER_WALL - 1 }),
    volume: fc.integer({ min: 0, max: BOOKS_PER_SHELF - 1 }),
    page: fc.integer({ min: 0, max: PAGES_PER_BOOK - 1 }),
  })
  .filter((a) => {
    try {
      assertValidAddress(a);
      return true;
    } catch {
      return false;
    }
  });

describe('constants', () => {
  it('matches the SPEC §3 values', () => {
    expect(PAGE_LENGTH).toBe(3200);
    expect(PAGES_PER_BOOK).toBe(410);
    expect(BOOKS_PER_SHELF).toBe(32);
    expect(SHELVES_PER_WALL).toBe(5);
    expect(WALLS_PER_ROOM).toBe(4);
    expect(PAGES_PER_ROOM).toBe(262400);
    expect(LIBRARY_SIZE).toBe(36n ** 3200n);
    expect(PAGES_IN_LAST_ROOM).toBe(261376n);
  });

  it('ROOM_COUNT is ceil(LIBRARY_SIZE / PAGES_PER_ROOM)', () => {
    const expected =
      (LIBRARY_SIZE + BigInt(PAGES_PER_ROOM) - 1n) / BigInt(PAGES_PER_ROOM);
    expect(ROOM_COUNT).toBe(expected);
  });

  it('the last room is partially filled', () => {
    expect(PAGES_IN_LAST_ROOM).toBeLessThan(BigInt(PAGES_PER_ROOM));
    expect(PAGES_IN_LAST_ROOM).toBeGreaterThan(0n);
  });
});

describe('toLinear / fromLinear', () => {
  it('fromLinear(toLinear(a)) === a over generated valid addresses', () => {
    fc.assert(
      fc.property(validAddress, (a) => {
        const roundTripped = fromLinear(toLinear(a));
        return (
          roundTripped.room === a.room &&
          roundTripped.wall === a.wall &&
          roundTripped.shelf === a.shelf &&
          roundTripped.volume === a.volume &&
          roundTripped.page === a.page
        );
      }),
      { numRuns: 1000 }
    );
  });

  it('toLinear(fromLinear(n)) === n over generated n in [0, LIBRARY_SIZE)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: LIBRARY_SIZE - 1n }),
        (n) => toLinear(fromLinear(n)) === n
      ),
      { numRuns: 1000 }
    );
  });

  it('linearises room 0 page 0 to 0', () => {
    expect(toLinear({ room: 0n, wall: 0, shelf: 0, volume: 0, page: 0 })).toBe(0n);
  });

  it('linearises the last legal address to LIBRARY_SIZE - 1', () => {
    const last = fromLinear(LIBRARY_SIZE - 1n);
    expect(toLinear(last)).toBe(LIBRARY_SIZE - 1n);
  });

  it('the first invalid address linearises to LIBRARY_SIZE', () => {
    const firstInvalid = fromLinear(LIBRARY_SIZE);
    expect(toLinear(firstInvalid)).toBe(LIBRARY_SIZE);
  });

  it('decomposes a known linear index into its components', () => {
    // room 1, wall 2, shelf 3, volume 4, page 5
    const linear =
      1n * BigInt(PAGES_PER_ROOM) +
      BigInt((2 * SHELVES_PER_WALL + 3) * BOOKS_PER_SHELF + 4) *
        BigInt(PAGES_PER_BOOK) +
      5n;
    const a = fromLinear(linear);
    expect(a.room).toBe(1n);
    expect(a.wall).toBe(2);
    expect(a.shelf).toBe(3);
    expect(a.volume).toBe(4);
    expect(a.page).toBe(5);
  });
});

describe('assertValidAddress', () => {
  it('accepts room 0 at both page bounds', () => {
    expect(() => {
      assertValidAddress({ room: 0n, wall: 0, shelf: 0, volume: 0, page: 0 });
    }).not.toThrow();
    expect(() => {
      assertValidAddress({ room: 0n, wall: 3, shelf: 4, volume: 31, page: 409 });
    }).not.toThrow();
  });

  it('accepts the last legal room', () => {
    const last = fromLinear(LIBRARY_SIZE - 1n);
    expect(() => {
      assertValidAddress(last);
    }).not.toThrow();
  });

  it('rejects the first invalid address after the partially-filled tail', () => {
    const firstInvalid = fromLinear(LIBRARY_SIZE);
    expect(() => {
      assertValidAddress(firstInvalid);
    }).toThrow(AddressBeyondLibraryError);
  });

  it('rejects a room at or above ROOM_COUNT', () => {
    expect(() => {
      assertValidAddress({ room: ROOM_COUNT, wall: 0, shelf: 0, volume: 0, page: 0 });
    }).toThrow(InvalidAddressError);
    expect(() => {
      assertValidAddress({ room: -1n, wall: 0, shelf: 0, volume: 0, page: 0 });
    }).toThrow(InvalidAddressError);
  });

  it('rejects wall, shelf, volume and page at their upper bounds', () => {
    const base = { room: 0n, wall: 0, shelf: 0, volume: 0, page: 0 };
    expect(() => {
      assertValidAddress({ ...base, wall: WALLS_PER_ROOM });
    }).toThrow(InvalidAddressError);
    expect(() => {
      assertValidAddress({ ...base, shelf: SHELVES_PER_WALL });
    }).toThrow(InvalidAddressError);
    expect(() => {
      assertValidAddress({ ...base, volume: BOOKS_PER_SHELF });
    }).toThrow(InvalidAddressError);
    expect(() => {
      assertValidAddress({ ...base, page: PAGES_PER_BOOK });
    }).toThrow(InvalidAddressError);
  });

  it('rejects negative components', () => {
    const base = { room: 0n, wall: 0, shelf: 0, volume: 0, page: 0 };
    expect(() => {
      assertValidAddress({ ...base, wall: -1 });
    }).toThrow(InvalidAddressError);
    expect(() => {
      assertValidAddress({ ...base, shelf: -1 });
    }).toThrow(InvalidAddressError);
    expect(() => {
      assertValidAddress({ ...base, volume: -1 });
    }).toThrow(InvalidAddressError);
    expect(() => {
      assertValidAddress({ ...base, page: -1 });
    }).toThrow(InvalidAddressError);
  });

  it('names the offending component and its range on the error', () => {
    try {
      assertValidAddress({ room: 0n, wall: 9, shelf: 0, volume: 0, page: 0 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidAddressError);
      const err = e as InvalidAddressError;
      expect(err.component).toBe('wall');
      expect(err.value).toBe(9);
      expect(err.max).toBe(WALLS_PER_ROOM - 1);
    }
  });

  it('rejects an address beyond the library with the new error, naming the real cause', () => {
    // Every component is individually legal; it is the volume that pushes the
    // linear index past the end of the partially-filled last room. The page is
    // 0 and legal, so the error must not blame the page.
    const beyond = {
      room: ROOM_COUNT - 1n,
      wall: 3,
      shelf: 4,
      volume: 31,
      page: 0,
    };
    try {
      assertValidAddress(beyond);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AddressBeyondLibraryError);
      const err = e as AddressBeyondLibraryError;
      expect(err.linear).toBe(toLinear(beyond));
      expect(err.linear).toBeGreaterThanOrEqual(LIBRARY_SIZE);
      expect(err.librarySize).toBe(LIBRARY_SIZE);
      expect(err.message).toContain('beyond the end of the library');
      expect(err.message).toContain(String(LIBRARY_SIZE));
      // The message must not claim the page is out of range.
      expect(err.message).not.toContain("'page'");
    }
  });

  it('accepts the last legal page of the last room', () => {
    const last = fromLinear(LIBRARY_SIZE - 1n);
    expect(() => {
      assertValidAddress(last);
    }).not.toThrow();
  });
});

describe('roomToName / roomFromName', () => {
  it('round-trips over generated rooms', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: ROOM_COUNT - 1n }),
        (room) => roomFromName(roomToName(room)) === room
      ),
      { numRuns: 1000 }
    );
  });

  it('names room 0 as "0"', () => {
    expect(roomToName(0n)).toBe('0');
    expect(roomFromName('0')).toBe(0n);
  });

  it('names the last room with 3197 characters', () => {
    const name = roomToName(ROOM_COUNT - 1n);
    expect(name.length).toBe(3197);
    expect(roomFromName(name)).toBe(ROOM_COUNT - 1n);
  });

  it('uses only 0-9a-z characters', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: ROOM_COUNT - 1n }), (room) =>
        /^[0-9a-z]+$/.test(roomToName(room))
      ),
      { numRuns: 1000 }
    );
  });

  it('throws UnknownSymbolError for a name with a foreign character', () => {
    expect(() => roomFromName('abc!')).toThrow(UnknownSymbolError);
  });

  it('throws InvalidAddressError for a negative room', () => {
    expect(() => roomToName(-1n)).toThrow(InvalidAddressError);
  });

  it('rejects an empty name instead of silently meaning room 0', () => {
    expect(() => roomFromName('')).toThrow(InvalidAddressError);
  });

  it('resolves a non-canonical name with leading zeros', () => {
    expect(roomFromName('0001')).toBe(1n);
  });
});

describe('isCanonicalRoomName', () => {
  it('accepts room 0 as "0"', () => {
    expect(isCanonicalRoomName('0')).toBe(true);
  });

  it('accepts a name with no leading zeros', () => {
    expect(isCanonicalRoomName('1')).toBe(true);
    expect(isCanonicalRoomName('a')).toBe(true);
    expect(isCanonicalRoomName('zz')).toBe(true);
  });

  it('rejects a name with leading zeros', () => {
    expect(isCanonicalRoomName('0001')).toBe(false);
    expect(isCanonicalRoomName('01')).toBe(false);
    expect(isCanonicalRoomName('00')).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(isCanonicalRoomName('')).toBe(false);
  });

  it('every roomToName output is canonical', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: ROOM_COUNT - 1n }), (room) =>
        isCanonicalRoomName(roomToName(room))
      ),
      { numRuns: 1000 }
    );
  });
});
