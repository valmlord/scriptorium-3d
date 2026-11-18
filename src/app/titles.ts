import { shelfIndexOfFirstSlot } from '@engine/atlas';
import { bookAddressToSlot } from '@engine/slots';
import { bookAddressOf } from '@state/navigation';
import type { Navigation, NavigationState } from '@state/navigation';
import type { GenerationRequest, ShelfAddress } from '@worker/client';

/**
 * The spine titles, resolved one shelf at a time as the camera approaches and
 * abandoned when it has gone.
 *
 * **One shelf, never a room.** ADR-0005 holds what a shelf of 32 titles costs
 * on each of the four machines it measured; a room is twenty of them, so
 * asking for a room is that figure twenty times over, most of it for spines
 * behind the camera. The request is therefore made for the shelf the machine
 * is at, and the one in flight is cancelled the moment the machine is
 * somewhere else: `GenerationRequest.cancel()` exists for exactly this
 * (ADR-0016), and a cancelled title is one the worker never computes.
 *
 * **A shelf is resolved at the shelf level and below.** The titles are
 * `architecture.md` §3's level of detail: "titles are resolved when the camera
 * is close enough to read them and cancelled when it is not". At the wall
 * level a spine is 42 mm of a 1.8 m wall (`@engine/constants`) and its
 * title is unreadable, and five shelves at once is five times the cost above
 * for text nobody can read. Because the machine commits on the event and the
 * camera lags (ADR-0030), the request for a shelf goes out as the flight
 * towards it begins, which is the "as the camera approaches" the milestone
 * asks for.
 *
 * **A reply for a shelf the machine has left changes nothing.** That is the
 * same rule the reader turns on (ADR-0032) and it is the only thing that
 * distinguishes a cancellation from a failure here, which is why no error
 * class is inspected: a cancelled shelf is one the machine has left, and a
 * shelf that genuinely failed is simply not recorded, so coming back to it
 * asks again.
 */

/** What the resolver needs of `@worker/client`'s `GenerationClient`. */
export interface ShelfTitleSource {
  shelfTitles(shelf: ShelfAddress): GenerationRequest<readonly string[]>;
}

/** What the resolver needs of a loaded room: where to write the titles. */
export interface RoomTitles {
  /** Which room this is, so titles are never written into another one. */
  readonly room: bigint;
  /** The room's spine title atlas (`@engine/titles`). */
  readonly titles: {
    setShelfTitles(firstSlot: number, titles: readonly string[]): void;
    /**
     * The shelves whose titles the atlas is holding, by shelf index.
     *
     * Asked before a shelf is requested, so the atlas stays the single
     * authority on what is drawn. It holds seven of a room's twenty and
     * displaces them in turn, so "already asked" is not the same question and
     * a record of it here would be a second copy of the answer
     * (`architecture.md` §4) that leaves blank spines after an eviction.
     */
    readonly shelvesHeld: readonly number[];
  };
}

/**
 * Where the titles go. Satisfied structurally by `Viewer`, whose `room` is the
 * room currently loaded, so the resolver holds no second opinion about which
 * room is on screen.
 */
export interface TitleDestination {
  readonly room: RoomTitles | null;
}

/** What the composition root gives the resolver. */
export interface TitleResolverOptions {
  readonly navigation: Navigation;
  readonly source: ShelfTitleSource;
  readonly destination: TitleDestination;
}

/** The title resolver, watching the machine. */
export interface TitleResolver {
  /** Whether nothing is being generated for it. */
  isIdle(): boolean;
  /** Resolves the next time nothing is. */
  whenIdle(): Promise<void>;
  /** Stop watching and abandon the shelf in flight. */
  dispose(): void;
}

/** Start resolving titles for whichever shelf the machine is at. */
export function createTitleResolver(options: TitleResolverOptions): TitleResolver {
  const { navigation, source, destination } = options;

  /** The shelf the machine is at, or `null` above the shelf level. */
  let wanted: ShelfAddress | null = null;

  /** The shelf a request is in flight for. */
  let requested: ShelfAddress | null = null;
  let request: GenerationRequest<readonly string[]> | null = null;

  const idleWaiters: (() => void)[] = [];

  const resolver: TitleResolver = {
    isIdle(): boolean {
      return request === null;
    },

    whenIdle(): Promise<void> {
      if (resolver.isIdle()) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },

    dispose(): void {
      unsubscribe();
      wanted = null;
      abandon();
      release();
    },
  };

  const unsubscribe = navigation.subscribe(follow);
  follow(navigation.state);

  return resolver;

  /** Ask for the shelf `state` is at, and abandon the one it has left. */
  function follow(state: NavigationState): void {
    wanted = shelfOf(state);
    if (wanted === null) {
      abandon();
      release();
      return;
    }
    if (requested !== null && sameShelf(wanted, requested)) {
      return;
    }
    if (isAlreadyDrawn(wanted)) {
      // Nothing to generate and nothing to draw. Skipped here rather than
      // inside the atlas because the fan-out happens first: a shelf is 32
      // calls through the client's cache, and each one renders a cache key
      // from the room's linear index. At room 0 that is tenths of a
      // microsecond; at a room of 4975 digits, which is what a deep link
      // reaches (M8), it measured 2.31 ms of `bigint` work per navigation
      // event on an Apple M4. The atlas refusing to redraw saves the upload;
      // this saves the asking.
      return;
    }
    abandon();
    ask(wanted);
  }

  /** Whether the room on screen already has that shelf's titles drawn. */
  function isAlreadyDrawn(shelf: ShelfAddress): boolean {
    const loaded = destination.room;
    if (loaded === null || loaded.room !== shelf.room) {
      return false;
    }
    return loaded.titles.shelvesHeld.includes(
      shelfIndexOfFirstSlot(bookAddressToSlot({ ...shelf, volume: 0 }))
    );
  }

  /** Issue the request for `shelf` and write its titles when they arrive. */
  function ask(shelf: ShelfAddress): void {
    const issued = source.shelfTitles(shelf);
    requested = shelf;
    request = issued;
    issued.result.then(
      (titles) => {
        if (!isWanted(shelf)) {
          return;
        }
        forget();
        try {
          write(shelf, titles);
        } finally {
          // The request has settled whatever the write does, and a shelf that
          // arrives malformed is refused inside `setShelfTitles`
          // (`@engine/atlas`). Releasing in a `finally` is what keeps that
          // refusal from leaving `waitForIdle()` waiting on a request that is
          // already over. The refusal itself is deliberately not caught: the
          // client fans a shelf out over exactly `BOOKS_PER_SHELF` requests,
          // so a shelf the atlas will not take is a bug on this side of the
          // boundary and should be loud. What must not happen is idleness
          // being wrong as well.
          release();
        }
      },
      () => {
        if (!isWanted(shelf)) {
          return;
        }
        // Nothing is recorded for a shelf that did not arrive, so coming back
        // to it asks again. A cancelled shelf never reaches here, because
        // cancelling is what leaving it consists of.
        forget();
        release();
      }
    );
  }

  /** Draw `titles` onto the spines of `shelf`, if that room is still loaded. */
  function write(shelf: ShelfAddress, titles: readonly string[]): void {
    const loaded = destination.room;
    if (loaded === null || loaded.room !== shelf.room) {
      return;
    }
    // The slot of the shelf's first volume. `@engine/slots` owns the mapping
    // between an address and an instance slot; nothing here reconstructs it.
    loaded.titles.setShelfTitles(bookAddressToSlot({ ...shelf, volume: 0 }), titles);
  }

  /** The shelf a state is at, or `null` where titles are not worth resolving. */
  function shelfOf(state: NavigationState): ShelfAddress | null {
    if (state.level === 'shelf') {
      return { room: state.room, wall: state.wall, shelf: state.shelf };
    }
    const book = bookAddressOf(state);
    return book === null
      ? null
      : { room: book.room, wall: book.wall, shelf: book.shelf };
  }

  function isWanted(shelf: ShelfAddress): boolean {
    return wanted !== null && sameShelf(shelf, wanted);
  }

  function abandon(): void {
    request?.cancel();
    forget();
  }

  function forget(): void {
    request = null;
    requested = null;
  }

  /**
   * Release the idle waiters.
   *
   * Unconditional, because every call site below is a settlement: the shelf
   * arrived, or it failed, or the machine left it and it was abandoned. A
   * guard here asking whether the resolver is idle could not fail from any of
   * them, and a check nobody has watched fail is this project's recurring
   * defect (ADR-0030's own note on the matter).
   */
  function release(): void {
    for (const resolve of idleWaiters.splice(0)) {
      resolve();
    }
  }
}

/** Whether two addresses name the same shelf. `room` is a `bigint`. */
function sameShelf(one: ShelfAddress, other: ShelfAddress): boolean {
  return (
    one.room === other.room && one.wall === other.wall && one.shelf === other.shelf
  );
}
