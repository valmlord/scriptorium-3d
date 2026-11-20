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
  /**
   * Where a shelf the atlas will not take is reported.
   *
   * Required rather than optional, because the decision is the composition
   * root's and there is no default worth having. The atlas refuses a shelf
   * that is not `BOOKS_PER_SHELF` titles or does not begin a shelf
   * (`@engine/atlas`), and the client fans a shelf out over exactly that many
   * requests, so a refusal is a bug on this side of the boundary rather than a
   * condition of the library.
   *
   * It exists because the alternative is worse: a throw inside the reply
   * handler has no caller to reach, so it becomes an unhandled rejection,
   * which is a console line nobody owns in a browser and a failed run in the
   * suite. `ResourceRegistry.disposeAll` can be loud to its caller because it
   * has one; this cannot, so the owner is passed in.
   *
   * The shelf is passed with the error because the error alone does not say
   * which one it was. The atlas refuses on a count and a slot, so its message
   * names a number of titles and not a place on a wall, and the resolver is
   * the only party that still holds the address by the time the refusal is
   * reported.
   */
  readonly onFailure: (shelf: ShelfAddress, error: unknown) => void;
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
  const { navigation, source, destination, onFailure } = options;

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
    // Abandoned before anything else is decided, because that is the half of
    // this function's job that is owed to the shelf being left rather than to
    // the one being arrived at. An early return placed above this line skips
    // it: the 32 titles of the departed shelf go on being computed, and its
    // reply then finds itself unwanted and clears nothing, so the resolver
    // reports busy for ever and `waitForIdle()` cannot return.
    abandon();
    if (isAlreadyDrawn(wanted)) {
      // Nothing to generate and nothing to draw. Asked here rather than left
      // to the atlas because the fan-out happens first: a shelf is 32 calls
      // through the client's cache, and each one renders a cache key from the
      // room's linear index, which at the depth a deep link reaches (M8) is
      // milliseconds of `bigint` work against nanoseconds for this check.
      // ADR-0032 holds both figures. The atlas refusing to redraw saves the
      // upload; this saves the asking.
      //
      // Nothing is released here, and that is deliberate: this path is only
      // reached with a shelf in flight or with nothing in flight at all. With
      // nothing in flight there is no waiter to release, because `whenIdle()`
      // answers immediately while the resolver is idle; with a shelf in
      // flight, `abandon()` above has just cancelled it, a cancelled request
      // rejects (ADR-0016), and its own handler releases. A `release()` here
      // was tried and no mutation could make it matter, which is the same
      // ground ADR-0030 removed such a check from the flight on.
      return;
    }
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
          // The departure cancelled and forgot this request, so there is
          // normally nothing left to clear. Clearing it anyway if it is
          // somehow still the one recorded keeps this handler from resting on
          // that invariant, which is what the fast path above broke once.
          forgetIfCurrent(issued);
          release();
          return;
        }
        // Said plainly: **no test can fail if this one line goes back to a
        // bare `forget()`**. The case needs a stale reply that *resolves*
        // while a newer request for the same shelf is recorded, and the
        // client as it stands cannot produce one. Over a real worker a shelf
        // resolves inside the asking task only when all 32 titles were cache
        // hits, which leaves no ids and makes `cancel()` a no-op; the newer
        // request could then only be in flight if one of those 32 had left the
        // cache in between, and it cannot have - a hit promotes its entry to
        // most-recent and the title budget is a whole room of 640, so
        // displacing one of the 32 just read would take some 600 further
        // insertions, where a `Promise.all` over resolved promises settles in
        // a tick or two (`@worker/client`, `@worker/cache`). Over a double
        // that answers inside `postMessage` the first clause does not hold,
        // since neither ask is a hit; the conclusion does, because the same
        // double settles the newer request too.
        //
        // Guarded regardless, and not merely for symmetry: this module is
        // written against the injected `ShelfTitleSource`, not against
        // `GenerationClient`. A bare `forget()` here would make it correct
        // only by virtue of another layer's LRU budget, across a boundary,
        // with nothing on either side to notice if that client ever batched
        // its replies or split its stores. Narrowing `forget()` costs one
        // reference comparison and is the old behaviour in every state that
        // can occur. The rejection path's version of this hazard *is*
        // reachable, and is tested.
        forgetIfCurrent(issued);
        try {
          write(shelf, titles);
        } catch (error: unknown) {
          // Reported to the owner rather than left to escape the handler, and
          // nothing is recorded for this shelf, so the spines stay as they
          // were and approaching it again asks for it again. That is the same
          // outcome as a generation that failed, which is the other way a
          // shelf does not arrive.
          onFailure(shelf, error);
        } finally {
          // The request has settled whatever the write did, so the waiters are
          // released either way: a refused shelf must not leave
          // `waitForIdle()` waiting on a request that is already over. What
          // matters is that the call is on the refusal path, not the keyword
          // around it: a trailing `release()` would behave the same, and a
          // mutation of the keyword alone is equivalent.
          release();
        }
      },
      () => {
        // One path for both cases, because they want the same two calls.
        //
        // What this does *not* do is abandon the shelf's other requests. A
        // shelf is 32 of them aggregated by `Promise.all`, which rejects on
        // the first failure, so up to 31 are still being computed when this
        // runs and nothing cancels them; returning to the shelf then asks for
        // what is still out. It costs nothing today because a generation
        // failure is not reachable from the M6 interface (ADR-0032) and
        // `waitForIdle()` composes the client's own request table, so it waits
        // for them anyway. The milestone that makes a failure reachable is the
        // one that should call `cancel()` here.
        //
        // Nothing is recorded for a shelf that did not arrive, so coming back
        // to it asks again; and the record is cleared only if this reply is
        // still the one holding it, because a cancellation rejects into the
        // microtask queue and the machine may already have asked for this
        // shelf again. That covers a shelf the machine has left and a shelf it
        // has returned to alike, so an `isWanted` branch here would have
        // identical arms - it was written with one, and hard-wiring the
        // condition either way left all 982 tests passing, which is what a
        // branch that decides nothing looks like.
        forgetIfCurrent(issued);
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
   * Forget the request in flight, if `issued` is the one in flight.
   *
   * The reader's `forgetPageRequest(from)` has the same shape and the same
   * reason: a reply from a superseded request must not clear the record of the
   * one that superseded it, or the resolver would report idle with a shelf
   * still being generated.
   *
   * **Every path that clears the record goes through here**, which was not
   * true when this was written: the two branches for a reply the machine still
   * wants cleared it unconditionally, and a shelf left and returned to inside
   * one task is wanted again by the time its cancellation rejects. The cost of
   * that was all three things this record exists for - `waitForIdle()`
   * returning mid-generation, the next event re-asking and paying the fan-out
   * again, and an orphaned request that leaving the shelf could no longer
   * cancel, which is the worker time ADR-0005 and ADR-0016 buy. Only the
   * rejection path reaches it; the comment on the other one says why it is
   * guarded regardless.
   *
   * `forget()` keeps one caller, `abandon()`, where there is nothing newer by
   * construction: it is the departure itself, and it cancels before it clears.
   */
  function forgetIfCurrent(issued: GenerationRequest<readonly string[]>): void {
    if (request === issued) {
      forget();
    }
  }

  /**
   * Release the idle waiters, if the resolver is in fact idle.
   *
   * The guard is load-bearing and has been watched firing. A settlement is not
   * the same thing as the resolver being idle: cancelling rejects (ADR-0016),
   * so a shelf the camera has left settles *after* the next shelf has been
   * asked for, and that handler reaches here with 32 titles in flight. Without
   * the guard it hands every waiter an answer that is wrong, which contradicts
   * `whenIdle`'s own promise above.
   *
   * It survived unguarded only because `whenAllIdle` re-reads the list after
   * each settlement and takes another turn (`./idle.ts`); a caller awaiting
   * this promise directly got the false answer. The reader and the worker
   * client both guard their release the same way, and this was the one source
   * that did not. "keeps a waiter waiting when the shelf it cancelled settles
   * under a newer one" in the tests is the case.
   */
  function release(): void {
    if (!resolver.isIdle()) {
      return;
    }
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
