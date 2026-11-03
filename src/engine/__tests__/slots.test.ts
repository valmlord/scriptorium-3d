import { describe, expect, it } from 'vitest';
import {
  BOOKS_PER_SHELF,
  PAGES_PER_BOOK,
  PAGES_PER_ROOM,
  ROOM_COUNT,
  SHELVES_PER_WALL,
  WALLS_PER_ROOM,
  toLinear,
} from '@core/address';
import type { BookAddress } from '@core/address';
import { InvalidInstanceSlotError } from '@engine/errors';
import {
  SPINES_PER_ROOM,
  bookAddressToSlot,
  occupiedSlotCount,
  slotToBookAddress,
  slotToCoordinates,
} from '@engine/slots';

/**
 * The instance slot is how a raycast hit becomes an address: three.js hands
 * back an `instanceId` and nothing else, so if this mapping is wrong the
 * reader opens a book that is not the one they clicked — and both the spine
 * and the book look exactly as plausible either way. Hence all 640 slots in
 * both directions rather than a sample.
 *
 * The bounds come from `core`'s constants. Writing `640` here would be a
 * second copy of the address model that agrees with the first until one of
 * them changes.
 */

/** A few rooms that exercise the arithmetic at both ends of the library. */
const ROOMS: readonly bigint[] = [0n, 1n, 37n, 1_000_003n, ROOM_COUNT - 2n];

describe('instance slot to coordinates', () => {
  it('covers exactly the four walls, five shelves and thirty-two volumes', () => {
    const seen = new Set<string>();

    for (let slot = 0; slot < SPINES_PER_ROOM; slot += 1) {
      const { wall, shelf, volume } = slotToCoordinates(slot);

      expect(wall).toBeGreaterThanOrEqual(0);
      expect(wall).toBeLessThan(WALLS_PER_ROOM);
      expect(shelf).toBeGreaterThanOrEqual(0);
      expect(shelf).toBeLessThan(SHELVES_PER_WALL);
      expect(volume).toBeGreaterThanOrEqual(0);
      expect(volume).toBeLessThan(BOOKS_PER_SHELF);
      seen.add(`${String(wall)}/${String(shelf)}/${String(volume)}`);
    }

    expect(seen.size).toBe(SPINES_PER_ROOM);
    expect(SPINES_PER_ROOM).toBe(WALLS_PER_ROOM * SHELVES_PER_WALL * BOOKS_PER_SHELF);
  });

  it('runs volumes fastest and walls slowest, as SPEC §3 linearises them', () => {
    expect(slotToCoordinates(0)).toEqual({ wall: 0, shelf: 0, volume: 0 });
    expect(slotToCoordinates(1)).toEqual({ wall: 0, shelf: 0, volume: 1 });
    expect(slotToCoordinates(BOOKS_PER_SHELF)).toEqual({
      wall: 0,
      shelf: 1,
      volume: 0,
    });
    expect(slotToCoordinates(BOOKS_PER_SHELF * SHELVES_PER_WALL)).toEqual({
      wall: 1,
      shelf: 0,
      volume: 0,
    });
    expect(slotToCoordinates(SPINES_PER_ROOM - 1)).toEqual({
      wall: WALLS_PER_ROOM - 1,
      shelf: SHELVES_PER_WALL - 1,
      volume: BOOKS_PER_SHELF - 1,
    });
  });

  it('refuses a slot no room has', () => {
    expect(() => slotToCoordinates(SPINES_PER_ROOM)).toThrow(InvalidInstanceSlotError);
    expect(() => slotToCoordinates(-1)).toThrow(InvalidInstanceSlotError);
    expect(() => slotToCoordinates(1.5)).toThrow(InvalidInstanceSlotError);
    expect(() => slotToCoordinates(Number.NaN)).toThrow(InvalidInstanceSlotError);
    expect(() => slotToCoordinates(SPINES_PER_ROOM)).toThrow(
      /Instance slot 640 is not an integer in \[0, 640\)/
    );
  });
});

describe('instance slot to address and back, over every slot of a room', () => {
  for (const room of ROOMS) {
    it(`round-trips all ${String(SPINES_PER_ROOM)} slots of room ${room.toString(36).slice(0, 12)}`, () => {
      for (let slot = 0; slot < SPINES_PER_ROOM; slot += 1) {
        const address = slotToBookAddress(room, slot);

        expect(address.room).toBe(room);
        expect(bookAddressToSlot(address)).toBe(slot);
      }
    });
  }

  it('round-trips every address of a room back to the slot it came from', () => {
    const room = 42n;
    const slots: number[] = [];

    for (let wall = 0; wall < WALLS_PER_ROOM; wall += 1) {
      for (let shelf = 0; shelf < SHELVES_PER_WALL; shelf += 1) {
        for (let volume = 0; volume < BOOKS_PER_SHELF; volume += 1) {
          const address: BookAddress = { room, wall, shelf, volume };
          const slot = bookAddressToSlot(address);

          expect(slotToBookAddress(room, slot)).toEqual(address);
          slots.push(slot);
        }
      }
    }

    expect(slots).toHaveLength(SPINES_PER_ROOM);
    expect(new Set(slots).size).toBe(SPINES_PER_ROOM);
    expect(Math.min(...slots)).toBe(0);
    expect(Math.max(...slots)).toBe(SPINES_PER_ROOM - 1);
  });

  it('is the book term of the linearisation of SPEC §3, not a second ordering', () => {
    const room = 7n;

    for (let slot = 0; slot < SPINES_PER_ROOM; slot += 1) {
      const address = slotToBookAddress(room, slot);
      const withinRoom =
        toLinear({ ...address, page: 0 }) - room * BigInt(PAGES_PER_ROOM);

      expect(withinRoom).toBe(BigInt(slot) * BigInt(PAGES_PER_BOOK));
    }
  });

  it('refuses an address whose components are outside the model', () => {
    expect(() =>
      bookAddressToSlot({ room: 0n, wall: WALLS_PER_ROOM, shelf: 0, volume: 0 })
    ).toThrow(/wall/);
    expect(() =>
      bookAddressToSlot({ room: 0n, wall: 0, shelf: 0, volume: BOOKS_PER_SHELF })
    ).toThrow(/volume/);
    expect(() =>
      bookAddressToSlot({ room: ROOM_COUNT, wall: 0, shelf: 0, volume: 0 })
    ).toThrow(/room/);
  });
});

describe('occupied slots', () => {
  it('fills every slot of every room but the last', () => {
    for (const room of ROOMS) {
      expect(occupiedSlotCount(room)).toBe(SPINES_PER_ROOM);
    }
  });

  it('stops where the library stops in the partially-filled last room', () => {
    // SPEC §3: the last room holds 261 376 pages, not 262 400. That is 637
    // whole volumes and 206 pages of a 638th, so 638 slots stand for a volume
    // that has a page in it and the last two stand for nothing at all.
    expect(occupiedSlotCount(ROOM_COUNT - 1n)).toBe(638);
    expect(occupiedSlotCount(ROOM_COUNT - 1n)).toBeLessThan(SPINES_PER_ROOM);
  });

  it('agrees with what the address model will open', () => {
    const lastRoom = ROOM_COUNT - 1n;
    const occupied = occupiedSlotCount(lastRoom);

    // Every occupied slot has a first page; the first unoccupied one does not.
    expect(() => slotToBookAddress(lastRoom, occupied - 1)).not.toThrow();
    expect(() => slotToBookAddress(lastRoom, occupied)).toThrow();
  });

  it('refuses a room the library does not have', () => {
    expect(() => occupiedSlotCount(ROOM_COUNT)).toThrow(/room/);
    expect(() => occupiedSlotCount(-1n)).toThrow(/room/);
  });
});
