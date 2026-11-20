import { describe, expect, it } from 'vitest';
import { BOOKS_PER_SHELF, SHELVES_PER_WALL, WALLS_PER_ROOM } from '@core/address';
import {
  ATLAS_BLANK_OFFSET,
  ATLAS_BLANK_ROW,
  ATLAS_CELL_HEIGHT,
  ATLAS_CELL_SPAN,
  ATLAS_CELL_WIDTH,
  ATLAS_COLUMNS,
  ATLAS_HEIGHT,
  ATLAS_ROWS,
  ATLAS_SHELF_ROWS,
  ATLAS_WIDTH,
  SHELVES_PER_ROOM,
  assertShelfTitleCount,
  cellOffset,
  createShelfRowAllocator,
  firstSlotOfShelf,
  shelfIndexOfFirstSlot,
} from '@engine/atlas';
import { InvalidShelfSlotError, ShelfTitleCountError } from '@engine/errors';
import { SPINES_PER_ROOM } from '@engine/slots';

/**
 * The atlas's arithmetic, tested without a browser.
 *
 * The canvas, the drawing and the shader patch are `../titles.ts` and are
 * asserted in `titles.test.ts` beside it, each over a stand-in rather than a
 * browser (`docs/testing.md` §1). That sentence used to say "end to end",
 * which was not true of the shader patch and was the reason nothing could fail
 * when a chunk marker stopped matching. What is here is what decides
 * *which* title a spine shows: a cell's texture coordinates and which shelf
 * holds which row. Both are places where being wrong produces a spine
 * carrying another book's title, which looks exactly as plausible as the
 * right one.
 */

/** Every shelf of a room, as the allocator is keyed. */
const EVERY_SHELF = [...Array.from({ length: SHELVES_PER_ROOM }).keys()];

describe('the atlas geometry', () => {
  it('gives a whole shelf one row and a volume one cell of it', () => {
    expect(ATLAS_COLUMNS).toBe(BOOKS_PER_SHELF);
    expect(SHELVES_PER_ROOM).toBe(WALLS_PER_ROOM * SHELVES_PER_WALL);
    expect(SHELVES_PER_ROOM * BOOKS_PER_SHELF).toBe(SPINES_PER_ROOM);
  });

  it('is its cells tiled, with nothing left over', () => {
    expect(ATLAS_WIDTH).toBe(ATLAS_COLUMNS * ATLAS_CELL_WIDTH);
    expect(ATLAS_HEIGHT).toBe(ATLAS_ROWS * ATLAS_CELL_HEIGHT);
    expect(ATLAS_ROWS).toBe(ATLAS_SHELF_ROWS + 1);
  });

  it('spans one cell per offset step, in both directions', () => {
    expect(ATLAS_CELL_SPAN.u * ATLAS_COLUMNS).toBe(1);
    expect(ATLAS_CELL_SPAN.v * ATLAS_ROWS).toBe(1);
  });

  it('measures v from the bottom, because a canvas is uploaded flipped', () => {
    // Row 0 is the top band of canvas pixels, which is the highest band of v.
    expect(cellOffset(0, 0).v).toBeCloseTo(1 - ATLAS_CELL_SPAN.v, 12);
    expect(cellOffset(ATLAS_ROWS - 1, 0).v).toBeCloseTo(0, 12);
  });

  it('keeps every cell inside the texture', () => {
    for (let row = 0; row < ATLAS_ROWS; row += 1) {
      for (let column = 0; column < ATLAS_COLUMNS; column += 1) {
        const offset = cellOffset(row, column);

        expect(offset.u).toBeGreaterThanOrEqual(0);
        expect(offset.v).toBeGreaterThanOrEqual(0);
        expect(offset.u + ATLAS_CELL_SPAN.u).toBeLessThanOrEqual(1);
        expect(offset.v + ATLAS_CELL_SPAN.v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('gives every cell of the atlas its own corner', () => {
    const corners = new Set<string>();
    for (let row = 0; row < ATLAS_ROWS; row += 1) {
      for (let column = 0; column < ATLAS_COLUMNS; column += 1) {
        const offset = cellOffset(row, column);
        corners.add(`${String(offset.u)},${String(offset.v)}`);
      }
    }

    expect(corners.size).toBe(ATLAS_ROWS * ATLAS_COLUMNS);
  });

  it('points an untitled spine at the blank row', () => {
    expect(ATLAS_BLANK_OFFSET).toEqual(cellOffset(ATLAS_BLANK_ROW, 0));
  });
});

describe('naming a shelf by its first slot', () => {
  it('round-trips every shelf of a room', () => {
    for (const shelf of EVERY_SHELF) {
      expect(shelfIndexOfFirstSlot(firstSlotOfShelf(shelf))).toBe(shelf);
    }
  });

  it('reads the first slot of a shelf as that shelf', () => {
    expect(shelfIndexOfFirstSlot(0)).toBe(0);
    expect(shelfIndexOfFirstSlot(BOOKS_PER_SHELF)).toBe(1);
    expect(shelfIndexOfFirstSlot(SPINES_PER_ROOM - BOOKS_PER_SHELF)).toBe(
      SHELVES_PER_ROOM - 1
    );
  });

  it('refuses a slot part-way along a shelf, naming the stride', () => {
    expect(() => shelfIndexOfFirstSlot(1)).toThrow(InvalidShelfSlotError);
    expect(() => shelfIndexOfFirstSlot(BOOKS_PER_SHELF + 1)).toThrow(
      InvalidShelfSlotError
    );
    expect(() => shelfIndexOfFirstSlot(1)).toThrow(
      /does not begin a shelf: a shelf starts at a multiple of 32 below 640/
    );
  });

  it('refuses a slot outside the room', () => {
    expect(() => shelfIndexOfFirstSlot(-BOOKS_PER_SHELF)).toThrow(
      InvalidShelfSlotError
    );
    expect(() => shelfIndexOfFirstSlot(SPINES_PER_ROOM)).toThrow(InvalidShelfSlotError);
  });
});

describe('a shelf of titles', () => {
  it('is accepted when it is a whole shelf', () => {
    expect(() => {
      assertShelfTitleCount(BOOKS_PER_SHELF);
    }).not.toThrow();
  });

  it('is refused when it is short or long, naming both counts', () => {
    expect(() => {
      assertShelfTitleCount(BOOKS_PER_SHELF - 1);
    }).toThrow(ShelfTitleCountError);
    expect(() => {
      assertShelfTitleCount(BOOKS_PER_SHELF + 1);
    }).toThrow(ShelfTitleCountError);
    expect(() => {
      assertShelfTitleCount(0);
    }).toThrow(/given 0 titles and holds 32 volumes/);
  });
});

describe('which shelf holds which row', () => {
  it('holds nothing until a shelf claims a row', () => {
    const allocator = createShelfRowAllocator();

    expect(allocator.held).toEqual([]);
    expect(allocator.rowOf(0)).toBeUndefined();
  });

  it('gives each new shelf a row of its own', () => {
    const allocator = createShelfRowAllocator();

    const rows = EVERY_SHELF.slice(0, ATLAS_SHELF_ROWS).map(
      (shelf) => allocator.claim(shelf).row
    );

    expect(new Set(rows).size).toBe(ATLAS_SHELF_ROWS);
    expect(allocator.held).toHaveLength(ATLAS_SHELF_ROWS);
  });

  it('never gives away the blank row', () => {
    const allocator = createShelfRowAllocator();

    // Twice round the atlas, so the eviction path is covered as well.
    for (const shelf of [...EVERY_SHELF, ...EVERY_SHELF]) {
      expect(allocator.claim(shelf).row).not.toBe(ATLAS_BLANK_ROW);
    }
  });

  it('keeps a shelf on the row it already holds, displacing nothing', () => {
    const allocator = createShelfRowAllocator();
    const first = allocator.claim(3);

    const again = allocator.claim(3);

    expect(again).toEqual({ row: first.row, evicted: null });
    expect(allocator.held).toEqual([3]);
  });

  it('displaces the shelf whose row it takes, and names it', () => {
    const allocator = createShelfRowAllocator();
    for (const shelf of EVERY_SHELF.slice(0, ATLAS_SHELF_ROWS)) {
      allocator.claim(shelf);
    }

    const claim = allocator.claim(ATLAS_SHELF_ROWS);

    // The rows are taken in turn, so the one that goes is the first claimed.
    expect(claim.evicted).toBe(0);
    expect(claim.row).toBe(allocator.rowOf(ATLAS_SHELF_ROWS));
    expect(allocator.rowOf(0)).toBeUndefined();
    expect(allocator.held).toHaveLength(ATLAS_SHELF_ROWS);
  });

  it('never lets two shelves hold the same row', () => {
    const allocator = createShelfRowAllocator();

    for (const shelf of [...EVERY_SHELF, ...EVERY_SHELF]) {
      allocator.claim(shelf);
      const rows = allocator.held.map((held) => allocator.rowOf(held));

      expect(new Set(rows).size).toBe(rows.length);
      expect(rows).not.toContain(undefined);
    }
  });

  it('holds no more shelves than the atlas has rows for', () => {
    const allocator = createShelfRowAllocator();

    for (const shelf of EVERY_SHELF) {
      allocator.claim(shelf);

      expect(allocator.held.length).toBeLessThanOrEqual(ATLAS_SHELF_ROWS);
    }
  });
});
