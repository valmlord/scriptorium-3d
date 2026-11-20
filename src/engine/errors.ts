/**
 * Dedicated error types for the ways a request to the engine can be wrong, in
 * the pattern of `src/core/errors.ts` and `src/app/errors.ts`: each carries
 * the offending value and what was expected of it.
 *
 * Address components are `core`'s business and are refused there — a wall of 7
 * raises `InvalidAddressError` from `assertValidAddress`, and nothing here
 * restates those ranges. What the engine owns is the one quantity `core` has
 * no name for: the instance slot, an index into the room's single
 * `InstancedMesh`.
 */

/**
 * An instance slot is not an integer in `[0, SPINES_PER_ROOM)`. The usual
 * cause is a raycast hit from a mesh other than the spines, whose `instanceId`
 * then indexes a room that does not have that many volumes — which would
 * otherwise resolve to a plausible address for the wrong object.
 */
export class InvalidInstanceSlotError extends Error {
  readonly slot: number;
  readonly max: number;

  constructor(slot: number, max: number) {
    super(
      `Instance slot ${String(slot)} is not an integer in [0, ${String(max + 1)}): a room holds ${String(max + 1)} volumes`
    );
    this.name = 'InvalidInstanceSlotError';
    this.slot = slot;
    this.max = max;
  }
}

/**
 * A shelf was named by a slot that is not the first of a shelf.
 *
 * The title atlas writes a whole shelf at a time, one row of cells per shelf
 * (`./atlas.ts`), so a slot part-way along a shelf would write 32 cells
 * beginning in the middle of one shelf and ending in the middle of the next.
 * Every spine in both would then carry a title from the wrong book, which is
 * exactly the plausible wrongness this project refuses to render.
 */
export class InvalidShelfSlotError extends Error {
  readonly slot: number;
  readonly booksPerShelf: number;

  constructor(slot: number, booksPerShelf: number, spinesPerRoom: number) {
    super(
      `Instance slot ${String(slot)} does not begin a shelf: a shelf starts at a multiple of ${String(booksPerShelf)} below ${String(spinesPerRoom)}`
    );
    this.name = 'InvalidShelfSlotError';
    this.slot = slot;
    this.booksPerShelf = booksPerShelf;
  }
}

/**
 * A set of titles arrived for a shelf without being a whole shelf of them.
 *
 * The worker client fans a shelf out over one request per volume and
 * aggregates them in volume order, so a short list is a bug on the way here
 * rather than a shelf with gaps in it. Writing it would leave the end of the
 * atlas row holding the titles of whichever shelf used it last.
 */
export class ShelfTitleCountError extends Error {
  readonly received: number;
  readonly expected: number;

  constructor(received: number, expected: number) {
    super(
      `A shelf was given ${String(received)} titles and holds ${String(expected)} volumes`
    );
    this.name = 'ShelfTitleCountError';
    this.received = received;
    this.expected = expected;
  }
}

/**
 * The browser would not give a 2D context for the title atlas.
 *
 * Refused by name rather than carried on as a room without titles: a context
 * request fails when the canvas is already bound to another context type or
 * when the process has run out of them, and both are conditions the next
 * thing to ask for a context will hit as well.
 */
export class Canvas2dUnavailableError extends Error {
  constructor() {
    super(
      'A 2D canvas context is not available, so the spine title atlas cannot be drawn'
    );
    this.name = 'Canvas2dUnavailableError';
  }
}
