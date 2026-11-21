import { NoRoomLoadedError } from './errors';

/**
 * The getter the choreography reads to know which room is on screen.
 *
 * A function of its own, rather than a closure written inline in
 * `src/main.ts`, so that its refusal can be tested against the code that runs
 * (`__tests__/shown-room.test.ts`). The viewer is the single holder of the room
 * on screen: the getter keeps no copy, so a swap is visible to the next read
 * and there is nothing to fall out of step with it.
 */

/** What the getter needs of `@engine/viewer`'s `Viewer`. */
export interface LoadedRoomHolder {
  /** The room loaded now, or `null` while there is none. */
  readonly room: { readonly room: bigint } | null;
}

/** A getter for the room `holder` has loaded, refusing while it has none. */
export function shownRoomOf(holder: LoadedRoomHolder): () => bigint {
  return () => {
    const loaded = holder.room;
    if (loaded === null) {
      throw new NoRoomLoadedError();
    }
    return loaded.room;
  };
}
