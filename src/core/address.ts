import { ROOM_ALPHABET } from './alphabet';
import { digitsToInt, intToDigits } from './bignum';
import { AddressBeyondLibraryError, InvalidAddressError } from './errors';

/**
 * The address model and linearisation (SPEC §3). All quantities that touch the
 * address space are `bigint`: `Number(room)` on a 4975-digit value silently
 * returns `Infinity`.
 */

/** Fixed page length in characters (SPEC §3). */
export const PAGE_LENGTH = 3200;
/** The radix of the page-text alphabet (SPEC §3). */
export const RADIX = 36;
/** Pages per book (SPEC §3). */
export const PAGES_PER_BOOK = 410;
/** Books per shelf (SPEC §3). */
export const BOOKS_PER_SHELF = 32;
/** Shelves per wall (SPEC §3). */
export const SHELVES_PER_WALL = 5;
/** Walls per room that carry shelves; two are doorways (SPEC §3). */
export const WALLS_PER_ROOM = 4;
/** Pages per room: 4 * 5 * 32 * 410 (SPEC §3). */
export const PAGES_PER_ROOM =
  WALLS_PER_ROOM * SHELVES_PER_WALL * BOOKS_PER_SHELF * PAGES_PER_BOOK;
/** Size of the library: 36 ** 3200, ~4981 decimal digits (SPEC §3). */
export const LIBRARY_SIZE = BigInt(RADIX) ** BigInt(PAGE_LENGTH);
/** Number of rooms: ceil(LIBRARY_SIZE / PAGES_PER_ROOM) (SPEC §3). */
export const ROOM_COUNT =
  (LIBRARY_SIZE + BigInt(PAGES_PER_ROOM) - 1n) / BigInt(PAGES_PER_ROOM);
/** Pages in the partially-filled last room: LIBRARY_SIZE mod PAGES_PER_ROOM (SPEC §3). */
export const PAGES_IN_LAST_ROOM = LIBRARY_SIZE % BigInt(PAGES_PER_ROOM);

/** A location in the library: a room, a wall, a shelf, a volume and a page. */
export interface Address {
  room: bigint;
  wall: number;
  shelf: number;
  volume: number;
  page: number;
}

/** A book: everything that identifies a volume except the page within it. */
export type BookAddress = Omit<Address, 'page'>;

const MAX_WALL = WALLS_PER_ROOM - 1;
const MAX_SHELF = SHELVES_PER_WALL - 1;
const MAX_VOLUME = BOOKS_PER_SHELF - 1;
const MAX_PAGE = PAGES_PER_BOOK - 1;

/**
 * The one canonical ordering (SPEC §3):
 *
 *   linear = room * PAGES_PER_ROOM
 *          + ((wall * SHELVES_PER_WALL + shelf) * BOOKS_PER_SHELF + volume) * PAGES_PER_BOOK
 *          + page
 */
export function toLinear(address: Address): bigint {
  const { room, wall, shelf, volume, page } = address;
  const bookOffset = (wall * SHELVES_PER_WALL + shelf) * BOOKS_PER_SHELF + volume;
  return (
    room * BigInt(PAGES_PER_ROOM) +
    BigInt(bookOffset) * BigInt(PAGES_PER_BOOK) +
    BigInt(page)
  );
}

/** The inverse of `toLinear`: decompose a linear index into an `Address`. */
export function fromLinear(linear: bigint): Address {
  const room = linear / BigInt(PAGES_PER_ROOM);
  const remainder = linear % BigInt(PAGES_PER_ROOM);
  const bookIndex = remainder / BigInt(PAGES_PER_BOOK);
  const page = Number(remainder % BigInt(PAGES_PER_BOOK));
  const volume = Number(bookIndex % BigInt(BOOKS_PER_SHELF));
  const shelfIndex = bookIndex / BigInt(BOOKS_PER_SHELF);
  const shelf = Number(shelfIndex % BigInt(SHELVES_PER_WALL));
  const wall = Number(shelfIndex / BigInt(SHELVES_PER_WALL));
  return { room, wall, shelf, volume, page };
}

/**
 * Validate an address. Rejects out-of-range components and the unfilled tail
 * of the partially-filled last room. A component out of range is an
 * `InvalidAddressError` naming that component; an address whose components are
 * each legal but whose linear index lies past the end of the library is an
 * `AddressBeyondLibraryError` carrying the linear index and `LIBRARY_SIZE`.
 * The tail is a real edge of the domain, not an approximation to hide (SPEC §3).
 */
export function assertValidAddress(address: Address): void {
  const { room, wall, shelf, volume, page } = address;
  if (room < 0n || room >= ROOM_COUNT) {
    throw new InvalidAddressError('room', room, 0n, ROOM_COUNT - 1n);
  }
  if (wall < 0 || wall > MAX_WALL) {
    throw new InvalidAddressError('wall', wall, 0, MAX_WALL);
  }
  if (shelf < 0 || shelf > MAX_SHELF) {
    throw new InvalidAddressError('shelf', shelf, 0, MAX_SHELF);
  }
  if (volume < 0 || volume > MAX_VOLUME) {
    throw new InvalidAddressError('volume', volume, 0, MAX_VOLUME);
  }
  if (page < 0 || page > MAX_PAGE) {
    throw new InvalidAddressError('page', page, 0, MAX_PAGE);
  }
  // The last room holds PAGES_IN_LAST_ROOM pages, not PAGES_PER_ROOM. A page
  // beyond that tail is a linear index >= LIBRARY_SIZE and does not exist.
  // Every component is individually legal here — the address is well-formed
  // but lies beyond the end of the library — so this is a distinct situation
  // from a component out of range, and gets its own error type.
  if (room === ROOM_COUNT - 1n && toLinear(address) >= LIBRARY_SIZE) {
    throw new AddressBeyondLibraryError(toLinear(address), LIBRARY_SIZE);
  }
}

/**
 * The room number as a base-36 name over `0-9a-z`, up to 3197 characters
 * (SPEC §3). A different alphabet from page text, so the two can never be
 * confused for one another. Always produces the canonical form: no leading
 * zeros, room 0 is `0` (ADR-0009).
 */
export function roomToName(room: bigint): string {
  return intToDigits(room, ROOM_ALPHABET, roomNameLength(room));
}

/**
 * The inverse of `roomToName`: parse a base-36 room name back to a `bigint`.
 * Lenient by design (ADR-0009): leading zeros are accepted, so `0001` resolves
 * to room 1. An empty name is rejected — it is not a room number, and silently
 * reading it as room 0 would make the empty string a valid address.
 */
export function roomFromName(name: string): bigint {
  if (name.length === 0) {
    throw new InvalidAddressError('room', name, 0n, ROOM_COUNT - 1n);
  }
  return digitsToInt(name, ROOM_ALPHABET);
}

/**
 * Whether a room name is canonical: no leading zeros, with `0` allowed on its
 * own (SPEC §3, ADR-0009). `roomToName` always produces a canonical name;
 * `roomFromName` accepts non-canonical ones, so this predicate is how a caller
 * tells the two apart and rewrites a non-canonical name to the canonical form.
 */
export function isCanonicalRoomName(name: string): boolean {
  if (name.length === 0) {
    return false;
  }
  return name.length === 1 || name[0] !== '0';
}

/**
 * The minimal width of a room name for a given room value: the number of
 * base-36 digits needed to represent the room, which is 1 for room 0 and grows
 * to 3197 for the last room. Room names are minimal-width, never padded — a
 * leading `0` would be a non-canonical name (ADR-0009), so `roomToName` and
 * `roomFromName` round-trip exactly without any padding to strip.
 */
function roomNameLength(room: bigint): number {
  if (room < 0n) {
    throw new InvalidAddressError('room', room, 0n, ROOM_COUNT - 1n);
  }
  if (room === 0n) {
    return 1;
  }
  return room.toString(36).length;
}
