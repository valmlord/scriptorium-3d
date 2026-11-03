import { describe, expect, it, vi } from 'vitest';
import { ROOM_COUNT } from '@core/address';
import { createRoom } from '@engine/room';
import type { RoomHandle } from '@engine/room';
import { SPINES_PER_ROOM } from '@engine/slots';

/**
 * The test that makes the library a place.
 *
 * `docs/architecture.md` §3 and §5: per-instance appearance is derived from
 * the address and never from `Math.random()`, because otherwise a room looks
 * different each time it is entered. Nothing about that is visible in a
 * screenshot of one visit — it only shows up on the second — so it is asserted
 * on the buffers themselves: all 10 240 matrix elements and all 1 920 colour
 * channels, element by element, not two objects both being truthy.
 *
 * No WebGL context is needed to build a room: geometries, materials and
 * instance buffers are plain JavaScript until a renderer uploads them.
 */

/** Rooms worth checking: the first, a middle one, and the partially filled last. */
const ROOMS: readonly bigint[] = [0n, 0x5f3759dfn, ROOM_COUNT - 1n];

/** Every instance matrix of a room's spines, as plain numbers. */
function matrixElements(handle: RoomHandle): number[] {
  return Array.from(handle.spines.instanceMatrix.array);
}

/** Every instance colour channel of a room's spines, as plain numbers. */
function colorChannels(handle: RoomHandle): number[] {
  const attribute = handle.spines.instanceColor;
  if (attribute === null) {
    throw new Error('The spines carry no per-instance colour at all');
  }
  return Array.from(attribute.array);
}

/** Build a room, read what it produced, and release it again. */
function build<T>(room: bigint, read: (handle: RoomHandle) => T): T {
  const handle = createRoom(room);
  try {
    return read(handle);
  } finally {
    handle.dispose();
  }
}

describe('building the same room twice', () => {
  for (const room of ROOMS) {
    it(`gives room ${room.toString(36).slice(0, 10)} the same matrices and the same colours`, () => {
      const first = build(room, (handle) => ({
        matrices: matrixElements(handle),
        colors: colorChannels(handle),
        count: handle.spines.count,
      }));

      const second = build(room, (handle) => ({
        matrices: matrixElements(handle),
        colors: colorChannels(handle),
        count: handle.spines.count,
      }));

      expect(second.matrices).toEqual(first.matrices);
      expect(second.colors).toEqual(first.colors);
      expect(second.count).toBe(first.count);
    });
  }

  it('fills the buffers it is compared on, so the comparison is not of two empty rooms', () => {
    const { matrices, colors } = build(0n, (handle) => ({
      matrices: matrixElements(handle),
      colors: colorChannels(handle),
    }));

    // 16 elements per instance matrix, 3 channels per instance colour.
    expect(matrices).toHaveLength(SPINES_PER_ROOM * 16);
    expect(colors).toHaveLength(SPINES_PER_ROOM * 3);
    expect(matrices.some((element) => element !== 0)).toBe(true);
    expect(colors.every((channel) => channel > 0 && channel <= 1)).toBe(true);
    expect(new Set(colors).size).toBeGreaterThan(SPINES_PER_ROOM);
  });
});

describe('two different rooms', () => {
  it('stand their volumes in the same places, because a room is a room', () => {
    const first = build(0n, matrixElements);
    const other = build(0x5f3759dfn, matrixElements);

    expect(other).toEqual(first);
  });

  it('bind their volumes in different colours, because the colour is the address', () => {
    const first = build(0n, colorChannels);
    const other = build(0x5f3759dfn, colorChannels);

    expect(other).not.toEqual(first);
    // Not merely different somewhere: a change of room repaints essentially
    // every binding, which is what rules out a colour that depends on the
    // slot alone with the room mixed in as an afterthought.
    const unchanged = first.filter((channel, index) => channel === other[index]).length;
    expect(unchanged).toBeLessThan(first.length / 100);
  });
});

describe('a freshly loaded module', () => {
  it('builds the same room as one that has already built rooms', async () => {
    const before = build(11n, (handle) => ({
      matrices: matrixElements(handle),
      colors: colorChannels(handle),
    }));

    // Reloading proves there is no accumulated state behind the result — a
    // counter in a module, a reused buffer not fully overwritten. Identity of
    // output across module instances is the only way to see that from outside,
    // and the assertion below that the two builders are different functions is
    // what keeps this from quietly comparing one module with itself.
    vi.resetModules();
    const reloaded = await import('@engine/room');
    expect(reloaded.createRoom).not.toBe(createRoom);

    const fresh = reloaded.createRoom(11n);
    const after = {
      matrices: Array.from(fresh.spines.instanceMatrix.array),
      colors: Array.from(fresh.spines.instanceColor?.array ?? []),
    };
    fresh.dispose();

    expect(after.matrices).toEqual(before.matrices);
    expect(after.colors).toEqual(before.colors);
  });
});
