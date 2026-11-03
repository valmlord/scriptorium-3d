import {
  BOOKS_PER_SHELF,
  LIBRARY_SIZE,
  PAGES_PER_BOOK,
  PAGES_PER_ROOM,
  SHELVES_PER_WALL,
  WALLS_PER_ROOM,
  assertValidAddress,
  fromLinear,
  toLinear,
} from '@core/address';
import type { BookAddress } from '@core/address';
import { InvalidInstanceSlotError } from './errors';

/**
 * The mapping between an instance slot — an index into the room's single
 * `InstancedMesh` of spines — and the volume that spine stands for.
 *
 * Both directions are `core`'s linearisation (SPEC §3) restricted to one room
 * and read at book granularity, not a second ordering invented here. The book
 * term of that formula is
 *
 *   ((wall * SHELVES_PER_WALL + shelf) * BOOKS_PER_SHELF + volume) * PAGES_PER_BOOK
 *
 * so the slot of a volume is exactly its linear index within the room divided
 * by `PAGES_PER_BOOK`, and the volume at a slot is `fromLinear` of that slot
 * scaled back up. Composing the canonical ordering rather than re-deriving it
 * means a change to SPEC §3 moves the spines with it instead of silently
 * disagreeing — and the round trip over all 640 slots in
 * `__tests__/slots.test.ts` is what holds the two together.
 *
 * `core` is reached here at runtime, which `docs/architecture.md` §1 confines
 * to the worker client. The rule it states is ADR-0005's, and ADR-0005 is
 * about *generation*: `getPage` costs single-digit milliseconds and must not
 * run on the main thread. `toLinear` and `fromLinear` are integer arithmetic
 * with no hashing in them, they are what the address model *is*, and the
 * `@engine` lint block restricts `@ui`, `gsap` and the other layers while
 * leaving `@core` alone — the lint rule being the specification, per
 * `docs/architecture.md` §1. Titles and page text still go through the worker.
 */

/** Volumes on display in one room: 4 walls * 5 shelves * 32 volumes. */
export const SPINES_PER_ROOM = WALLS_PER_ROOM * SHELVES_PER_WALL * BOOKS_PER_SHELF;

const MAX_SLOT = SPINES_PER_ROOM - 1;

/** Where a volume sits inside its room, independent of which room that is. */
export interface SlotCoordinates {
  wall: number;
  shelf: number;
  volume: number;
}

/**
 * Decompose an instance slot into the wall, shelf and volume it stands for.
 * Room-independent: a slot means the same place in every room, which is what
 * lets one set of instance matrices serve any room.
 */
export function slotToCoordinates(slot: number): SlotCoordinates {
  assertValidSlot(slot);
  // Read at room 0, where the linear index of a book is the slot times the
  // pages in it. The decomposition is structural and the same in every room,
  // so this reads `core`'s ordering on a small bigint rather than on a
  // 16545-bit one.
  const { wall, shelf, volume } = fromLinear(BigInt(slot) * BigInt(PAGES_PER_BOOK));
  return { wall, shelf, volume };
}

/** The volume at an instance slot of the given room, as a `BookAddress`. */
export function slotToBookAddress(room: bigint, slot: number): BookAddress {
  const { wall, shelf, volume } = slotToCoordinates(slot);
  const address: BookAddress = { room, wall, shelf, volume };
  assertValidAddress({ ...address, page: 0 });
  return address;
}

/**
 * The inverse: the instance slot that carries a given volume. Validates the
 * address through `core` first, so a wall of 7 is refused by the layer that
 * owns that range rather than wrapping around to a real spine.
 */
export function bookAddressToSlot(address: BookAddress): number {
  assertValidAddress({ ...address, page: 0 });
  const withinRoom =
    toLinear({ ...address, page: 0 }) - address.room * BigInt(PAGES_PER_ROOM);
  return Number(withinRoom / BigInt(PAGES_PER_BOOK));
}

/**
 * How many of a room's slots hold a volume that exists.
 *
 * Every room but the last holds all 640. The last room is partially filled
 * (SPEC §3): the library ends part-way along one of its shelves, so the slots
 * past that point stand for volumes with no pages at all. They are left
 * undrawn rather than drawn and ignored — a spine you can fly to and not open
 * is worse than a gap in the shelf.
 *
 * A volume is occupied when its page 0 is inside the library, and the linear
 * index of a volume grows with its slot, so the occupied slots are a prefix
 * and their count is how many whole volumes the pages remaining from the start
 * of this room can fill — rounded up, because a volume holding 206 of its 410
 * pages is still a volume.
 */
export function occupiedSlotCount(room: bigint): number {
  // Refuses a room outside [0, ROOM_COUNT) through the layer that owns that
  // range. Walls, shelves and volumes are at their first legal value here, so
  // this reports on the room and nothing else.
  assertValidAddress({ room, wall: 0, shelf: 0, volume: 0, page: 0 });

  const pagesFromHere = LIBRARY_SIZE - room * BigInt(PAGES_PER_ROOM);
  const volumesFromHere =
    (pagesFromHere + BigInt(PAGES_PER_BOOK) - 1n) / BigInt(PAGES_PER_BOOK);
  return volumesFromHere >= BigInt(SPINES_PER_ROOM)
    ? SPINES_PER_ROOM
    : Number(volumesFromHere);
}

function assertValidSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT) {
    throw new InvalidInstanceSlotError(slot, MAX_SLOT);
  }
}
