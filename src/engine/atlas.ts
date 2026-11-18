import { BOOKS_PER_SHELF } from '@core/address';
import { InvalidShelfSlotError, ShelfTitleCountError } from './errors';
import { SPINES_PER_ROOM } from './slots';

/**
 * The geometry of the spine title atlas, and which shelf holds which of its
 * rows. Arithmetic only: the canvas, the texture and the drawing are
 * `./titles.ts`, which needs a browser and is asserted end to end.
 *
 * **One row per shelf, one column per volume.** A shelf is `BOOKS_PER_SHELF`
 * volumes, so a row of that many cells is exactly a shelf and a cell's column
 * is its volume. The arithmetic for "which cell does this spine sample" is
 * then a division and a remainder rather than a free allocator over 640 cells,
 * and a shelf arriving or being evicted is one row either way.
 *
 * **Row 0 is blank, and nothing is ever allocated to it.** Every spine starts
 * pointing at it and an evicted shelf's spines are pointed back at it, so a
 * spine without a title samples white, which the material multiplies into its
 * own colour and leaves it as it was. The alternative is a branch in the
 * fragment shader for 640 instances, which is a branch per fragment to say
 * that most of them have nothing to draw.
 *
 * **Seven shelves of a room's twenty, because the camera visits one at a
 * time.** Generating all twenty at once is the stall ADR-0005 measured and is
 * not what the atlas is sized for: the resolver asks for the shelf the camera
 * is at and cancels what it has left behind. What the seven rows buy is that a
 * wall holds five shelves (`SHELVES_PER_WALL`), so walking one up and down
 * never displaces a row, and a displaced row costs a redraw rather than a
 * regeneration — the worker's cache holds a whole room of titles
 * (`@worker/cache`).
 *
 * **It is not sized to save the redraw, which is free.** Measured on an Apple
 * M4 in Chromium: drawing a shelf's 32 cells is 0.0 ms median and 0.2 ms at
 * worst, while uploading the atlas is 3.4 ms, because three.js has no partial
 * upload for a `CanvasTexture`. So rows are cheap to fill and the *atlas* is
 * what is expensive to send, and the figure that matters is how often it is
 * sent rather than how often a cell is painted: `titles.ts` sends it once per
 * shelf acquired and never for a shelf it already holds. Eight rows of 256
 * pixels is 8.4 MB on the device and about as much again for the canvas that
 * backs it; a room's worth would be 21 rows and 22.0 MB, for titles nineteen
 * twentieths of which are behind the camera.
 */

/** Cell width in pixels: across the spine, where nothing is drawn but ground. */
export const ATLAS_CELL_WIDTH = 32;

/** Cell height in pixels: along the spine, which is where the title runs. */
export const ATLAS_CELL_HEIGHT = 256;

/** Cells across the atlas: one per volume of a shelf. */
export const ATLAS_COLUMNS = BOOKS_PER_SHELF;

/** How many shelves the atlas holds at once. */
export const ATLAS_SHELF_ROWS = 7;

/** The row every spine points at until it has a title, and after it loses one. */
export const ATLAS_BLANK_ROW = 0;

/** Cells down the atlas: the blank row, then one row per shelf held. */
export const ATLAS_ROWS = ATLAS_SHELF_ROWS + 1;

/** The canvas the cells tile, in pixels. */
export const ATLAS_WIDTH = ATLAS_COLUMNS * ATLAS_CELL_WIDTH;
export const ATLAS_HEIGHT = ATLAS_ROWS * ATLAS_CELL_HEIGHT;

/** Shelves in one room: the rows the resolver can ask for. */
export const SHELVES_PER_ROOM = SPINES_PER_ROOM / BOOKS_PER_SHELF;

/**
 * The texture coordinates of one cell: where its corner is, in `[0, 1]`, and
 * how much of the atlas it spans. The shader adds the offset to the spine's
 * own `uv` scaled by the span, so one `vec2` per instance is the whole of the
 * per-instance appearance.
 */
export interface AtlasCellOffset {
  readonly u: number;
  readonly v: number;
}

/** How much of the atlas one cell spans, in texture coordinates. */
export const ATLAS_CELL_SPAN: AtlasCellOffset = {
  u: 1 / ATLAS_COLUMNS,
  v: 1 / ATLAS_ROWS,
};

/**
 * The texture coordinates of the cell at `row` and `column`.
 *
 * `v` is measured from the bottom because that is where a texture's
 * coordinates start, while a canvas is drawn from the top and three.js uploads
 * it flipped (`flipY`, the default). Row 0 of the canvas is therefore the
 * topmost band of pixels and the *highest* band of `v`, which is the one
 * conversion this module exists to keep in one place.
 */
export function cellOffset(row: number, column: number): AtlasCellOffset {
  return {
    u: column * ATLAS_CELL_SPAN.u,
    v: 1 - (row + 1) * ATLAS_CELL_SPAN.v,
  };
}

/** The cell every spine without a title samples. */
export const ATLAS_BLANK_OFFSET: AtlasCellOffset = cellOffset(ATLAS_BLANK_ROW, 0);

/**
 * The shelf an instance slot belongs to, from the slot of its first volume.
 *
 * Refuses anything that is not the first slot of a shelf: the atlas writes a
 * whole row at a time, and a slot part-way along a shelf would write 32 cells
 * starting in the middle of one shelf and ending in the middle of the next.
 */
export function shelfIndexOfFirstSlot(firstSlot: number): number {
  const index = firstSlot / BOOKS_PER_SHELF;
  if (!Number.isInteger(index) || index < 0 || index >= SHELVES_PER_ROOM) {
    throw new InvalidShelfSlotError(firstSlot, BOOKS_PER_SHELF, SPINES_PER_ROOM);
  }
  return index;
}

/** The instance slot of the first volume of shelf `index`. */
export function firstSlotOfShelf(index: number): number {
  return index * BOOKS_PER_SHELF;
}

/**
 * Refuse a set of titles that is not a whole shelf.
 *
 * The client fans a shelf out over `BOOKS_PER_SHELF` requests and aggregates
 * them in volume order, so a shorter list is a bug on the way here rather than
 * a shelf with gaps in it — and writing it would leave the last cells of the
 * row holding another shelf's titles, which is a spine that lies about which
 * book it is.
 */
export function assertShelfTitleCount(count: number): void {
  if (count !== BOOKS_PER_SHELF) {
    throw new ShelfTitleCountError(count, BOOKS_PER_SHELF);
  }
}

/** A row of the atlas given to a shelf, and the shelf it displaced. */
export interface ShelfRowClaim {
  /** The atlas row that shelf now owns. Never `ATLAS_BLANK_ROW`. */
  readonly row: number;
  /** The shelf whose titles that row no longer holds, if it displaced one. */
  readonly evicted: number | null;
}

/**
 * Which shelf holds which of the atlas's rows.
 *
 * **Round-robin rather than least recently used.** A shelf that still holds a
 * row keeps it, so revisiting one costs nothing either way; what differs is
 * which row a new shelf takes, and taking them in turn needs no recency
 * bookkeeping and has no "the table is empty" case to get wrong. The two
 * policies diverge only for a pattern that cycles through more than
 * `ATLAS_SHELF_ROWS` shelves and returns to the oldest, which is not a pattern
 * a camera walking a wall makes.
 *
 * A row is never redrawn while it is held, because a title is a pure function
 * of its address and cannot change (SPEC §4).
 */
export interface ShelfRowAllocator {
  /** The row shelf `index` holds, or `undefined` if it holds none. */
  rowOf(index: number): number | undefined;
  /** Give shelf `index` a row, reusing or displacing as needed. */
  claim(index: number): ShelfRowClaim;
  /** The shelves holding a row, in no particular order. */
  readonly held: readonly number[];
}

/** Build an allocator over the atlas's shelf rows. */
export function createShelfRowAllocator(): ShelfRowAllocator {
  const rowOfShelf = new Map<number, number>();
  /** Which shelf is in each shelf row, indexed from the first one after the blank. */
  const shelfInRow: (number | null)[] = Array.from(
    { length: ATLAS_SHELF_ROWS },
    () => null
  );
  let nextRow = 0;

  return {
    rowOf(index: number): number | undefined {
      return rowOfShelf.get(index);
    },

    get held(): readonly number[] {
      return [...rowOfShelf.keys()];
    },

    claim(index: number): ShelfRowClaim {
      const held = rowOfShelf.get(index);
      if (held !== undefined) {
        return { row: held, evicted: null };
      }
      const position = nextRow % ATLAS_SHELF_ROWS;
      nextRow += 1;
      // A row that has never been claimed holds nobody, which is the same
      // answer as one whose shelf has already been displaced.
      const evicted = shelfInRow[position] ?? null;
      if (evicted !== null) {
        rowOfShelf.delete(evicted);
      }
      shelfInRow[position] = index;
      const row = position + ATLAS_BLANK_ROW + 1;
      rowOfShelf.set(index, row);
      return { row, evicted };
    },
  };
}
