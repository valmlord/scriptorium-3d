/**
 * When a replaced room is let go.
 *
 * three.js frees a shader program the moment nothing uses it, so disposing the
 * old room before the new one is drawn makes the swap frame link its five
 * programs again, measured at 17.6 to 32.5 ms in Chromium on Metal and 17 to
 * 33 ms in WebKit. The new room holds those five as soon as it renders once;
 * the titled spine variant (`./titles.ts`) it holds only once it renders with
 * titles. So a replaced room that has rendered with titles is kept until the
 * loaded room has too, through any number of swaps in between, and one that
 * has not is kept no longer than the next render.
 *
 * The policy is the single holder of the retiring room, and it holds nothing
 * else but one fact about the loaded room: whether any render since it was
 * loaded had titles. The viewer keeps the loaded room itself, and reports each
 * render from one place (`./viewer.ts`, `renderFrame`); where it reports is
 * what `__tests__/render-frame.test.ts` guards, because nothing here can see it.
 *
 * No three.js in it, so every rule is unit-tested without a WebGL context.
 */

/** What the policy needs of a room: the way to release it. */
export interface Disposable {
  dispose(): void;
}

/** The one-slot retirement policy of the viewer. */
export interface Retirement {
  /**
   * A room is about to be loaded in place of `outgoing`, already taken out of
   * the scene, or `null` when nothing is being replaced. Disposes at once
   * whichever of `outgoing` and the retiring room is not worth keeping.
   */
  replace(outgoing: Disposable | null): void;
  /**
   * The loaded room was just drawn, with titles or without. Releases the
   * retiring room once keeping it buys nothing.
   */
  noteRender(isTitled: boolean): void;
  /** Whether a replaced room is being kept. */
  readonly isOccupied: boolean;
  /** Dispose the retiring room, if any, and keep nothing. */
  dispose(): void;
}

/**
 * A retiring room and whether it rendered with titles while it was loaded.
 * Held together, so "the slot is empty or its room is untitled" is one test on
 * one value, and a condition that forgets the empty slot does not compile.
 */
interface Slot {
  readonly room: Disposable;
  readonly titled: boolean;
}

/** Build the policy, with nothing retiring and nothing loaded. */
export function createRetirement(): Retirement {
  let slot: Slot | null = null;
  let hasLoadedRenderedTitled = false;

  return {
    get isOccupied(): boolean {
      return slot !== null;
    },

    replace(outgoing: Disposable | null): void {
      // A titled retiring room holds every program the outgoing room does, the
      // titled one included, so while it is kept the outgoing room adds
      // nothing. Whether the outgoing room is titled is deliberately not asked:
      // with a titled room retiring it cannot be, because its first titled
      // render released that room.
      if (slot === null || !slot.titled) {
        slot?.room.dispose();
        slot =
          outgoing === null
            ? null
            : { room: outgoing, titled: hasLoadedRenderedTitled };
      } else {
        outgoing?.dispose();
      }
      hasLoadedRenderedTitled = false;
    },

    noteRender(isTitled: boolean): void {
      hasLoadedRenderedTitled ||= isTitled;
      if (slot === null) {
        return;
      }
      // Released by a titled render because that render has just linked the
      // titled program while the retiring room still held it; by any render
      // when the retiring room is untitled, because the five programs it holds
      // are now held by the loaded room as well.
      if (hasLoadedRenderedTitled || !slot.titled) {
        slot.room.dispose();
        slot = null;
      }
    },

    dispose(): void {
      slot?.room.dispose();
      slot = null;
    },
  };
}
