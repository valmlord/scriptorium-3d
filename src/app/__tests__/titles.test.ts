import { describe, expect, it } from 'vitest';
import { BOOKS_PER_SHELF, SHELVES_PER_WALL } from '@core/address';
import { createNavigation, eventsTo, atBookAddress } from '@state/navigation';
import type { Navigation } from '@state/navigation';
import { createTitleResolver } from '@app/titles';
import type { RoomTitles, ShelfTitleSource, TitleDestination } from '@app/titles';
import type { GenerationRequest, ShelfAddress } from '@worker/client';

/**
 * The title resolver asks for one shelf, writes it onto the spines of that
 * shelf, and abandons what the camera has left behind.
 *
 * Tested against a scripted source rather than a real client, for the reason
 * `docs/testing.md` §1 gives for the client's own tests: what is the
 * resolver's own is the bookkeeping — which shelf is asked for, which reply is
 * accepted, what is cancelled — and a thread cannot be made to deliver a reply
 * at an exact moment. That a shelf of titles is the 32 `getTitle` values is
 * the client's assertion and is made in `src/worker/__tests__`, where
 * generating is allowed; the end-to-end suite then asserts a title on the
 * screen against `getTitle` itself.
 *
 * No test here waits on a duration.
 */

const ROOM = 0n;
const SHELF: ShelfAddress = { room: ROOM, wall: 1, shelf: 2 };
const OTHER_SHELF: ShelfAddress = { room: ROOM, wall: 1, shelf: 3 };

/** The titles a shelf is answered with, distinguishable per shelf. */
function titlesOf(shelf: ShelfAddress): readonly string[] {
  return Array.from(
    { length: BOOKS_PER_SHELF },
    (_unused, volume) =>
      `w${String(shelf.wall)}s${String(shelf.shelf)}v${String(volume)}`
  );
}

/**
 * The instance slot of a shelf's first volume, from SPEC §3's linearisation
 * read at book granularity. Derived here rather than through
 * `@engine/slots`, so the expectation is not the implementation's own answer.
 */
function firstSlotOf(shelf: ShelfAddress): number {
  return (shelf.wall * SHELVES_PER_WALL + shelf.shelf) * BOOKS_PER_SHELF;
}

/** A request in flight, as the test can drive it. */
interface Scripted {
  readonly shelf: ShelfAddress;
  /** Answered from the cache, so no worker was asked. */
  readonly fromCache: boolean;
  cancelled: boolean;
  resolve(titles: readonly string[]): void;
  reject(error: unknown): void;
}

/** A source whose replies the test writes, and a note of what was asked. */
class ScriptedShelves implements ShelfTitleSource {
  readonly issued: Scripted[] = [];

  /** Shelves answered inside the same task, as the client's cache does. */
  private readonly cached = new Set<string>();

  cache(shelf: ShelfAddress): void {
    this.cached.add(keyOf(shelf));
  }

  shelfTitles(shelf: ShelfAddress): GenerationRequest<readonly string[]> {
    if (this.cached.has(keyOf(shelf))) {
      const scripted: Scripted = {
        shelf,
        fromCache: true,
        cancelled: false,
        resolve: () => undefined,
        reject: () => undefined,
      };
      this.issued.push(scripted);
      return {
        ids: [],
        result: Promise.resolve(titlesOf(shelf)),
        cancel: () => {
          scripted.cancelled = true;
        },
      };
    }

    let settle: (titles: readonly string[]) => void = () => undefined;
    let fail: (error: unknown) => void = () => undefined;
    const result = new Promise<readonly string[]>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const scripted: Scripted = {
      shelf,
      fromCache: false,
      cancelled: false,
      resolve: settle,
      reject: fail,
    };
    this.issued.push(scripted);
    return {
      ids: [1],
      result,
      cancel: (): void => {
        scripted.cancelled = true;
        // What the real client does (ADR-0016): a cancelled request rejects.
        fail(new Error(`the shelf at wall ${String(shelf.wall)} was cancelled`));
      },
    };
  }

  /** The request in flight for `shelf`, which the test then answers. */
  forShelf(shelf: ShelfAddress): Scripted {
    const found = this.issued.find(
      (request) => keyOf(request.shelf) === keyOf(shelf) && !request.cancelled
    );
    if (found === undefined) {
      throw new Error(`no request was issued for wall ${String(shelf.wall)}`);
    }
    return found;
  }
}

/**
 * A room that records what was written onto its spines, and holds a shelf once
 * it has been written, as the real atlas does.
 */
class RecordingRoom implements RoomTitles {
  readonly written: { firstSlot: number; titles: readonly string[] }[] = [];

  /** Shelf indices this stand-in is holding, in the atlas's own vocabulary. */
  private readonly held: number[] = [];

  constructor(readonly room: bigint) {}

  readonly titles = {
    setShelfTitles: (firstSlot: number, titles: readonly string[]): void => {
      this.written.push({ firstSlot, titles });
      this.held.push(firstSlot / BOOKS_PER_SHELF);
    },
    // The same array the class pushes into, so what it holds is visible
    // through the interface the resolver reads.
    shelvesHeld: this.held,
  };

  /** Forget a shelf, as the atlas does when it displaces a row. */
  evict(firstSlot: number): void {
    const index = this.held.indexOf(firstSlot / BOOKS_PER_SHELF);
    if (index >= 0) {
      this.held.splice(index, 1);
    }
  }
}

function keyOf(shelf: ShelfAddress): string {
  return `${shelf.room.toString(36)}/${String(shelf.wall)}/${String(shelf.shelf)}`;
}

/** Walk the machine to `to`, as a click on a spine does. */
function goTo(navigation: Navigation, to: ShelfAddress, volume?: number): void {
  const target =
    volume === undefined
      ? { level: 'shelf' as const, room: to.room, wall: to.wall, shelf: to.shelf }
      : atBookAddress({ ...to, volume });
  navigation.dispatchAll(eventsTo(navigation.state, target));
}

/**
 * The failure reporter every harness here passes unless the test is about a
 * refusal. A silent default would hide exactly the defect these tests exist
 * for, so an unexpected refusal is rethrown and fails the test that caused it.
 */
function failLoudly(shelf: ShelfAddress, error: unknown): never {
  const where = `wall ${String(shelf.wall)} shelf ${String(shelf.shelf)}`;
  throw error instanceof Error
    ? error
    : new Error(`the atlas refused ${where}: ${String(error)}`);
}

/**
 * Whether `promise` has resolved, after draining the microtask queue.
 *
 * Five turns, the same apparatus as `idle.test.ts`: a waiter that is released
 * one or two microtasks late would otherwise read as a waiter never released.
 */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
  return settled;
}

/** A resolver over a scripted source and a recording room. */
function harness(): {
  navigation: Navigation;
  source: ScriptedShelves;
  room: RecordingRoom;
  destination: TitleDestination;
  resolver: ReturnType<typeof createTitleResolver>;
} {
  const navigation = createNavigation(ROOM);
  const source = new ScriptedShelves();
  const room = new RecordingRoom(ROOM);
  const destination: TitleDestination = { room };
  const resolver = createTitleResolver({
    navigation,
    source,
    destination,
    onFailure: failLoudly,
  });
  return { navigation, source, room, destination, resolver };
}

describe('which shelf is asked for', () => {
  it('asks for nothing while the camera is at the room or a wall', () => {
    const { navigation, source } = harness();

    navigation.dispatch({ type: 'select-wall', wall: 1 });

    // A spine is 42 mm of a 1.8 m wall at that distance, so its title is not
    // readable and five shelves of them is five times the cost of one.
    expect(source.issued).toEqual([]);
  });

  it('asks for the shelf the machine is at', () => {
    const { navigation, source } = harness();

    goTo(navigation, SHELF);

    expect(source.issued).toHaveLength(1);
    expect(source.issued[0]?.shelf).toEqual(SHELF);
  });

  it('asks for the shelf a book stands on', () => {
    const { navigation, source } = harness();

    goTo(navigation, SHELF, 7);

    expect(source.issued.map((request) => request.shelf)).toEqual([SHELF]);
  });

  it('does not ask again while that shelf is still being generated', () => {
    const { navigation, source } = harness();
    goTo(navigation, SHELF);

    // Down to a volume of the same shelf, which is a new state and the same
    // shelf of spines.
    goTo(navigation, SHELF, 3);
    navigation.dispatch({ type: 'turn-page', page: 9 });

    expect(source.issued).toHaveLength(1);
  });

  it('does not ask again for a shelf the atlas is still holding', async () => {
    // The atlas is the authority on what is drawn, so it is asked rather than
    // remembered. Each ask is 32 calls through the client's cache and each one
    // renders a key from the room's linear index, which is milliseconds of
    // `bigint` work per navigation event at the depth a deep link reaches.
    // ADR-0032 holds the measurement; this file does not restate it.
    const { navigation, source } = harness();
    goTo(navigation, SHELF, 3);
    source.forShelf(SHELF).resolve(titlesOf(SHELF));
    await Promise.resolve();

    navigation.dispatch({ type: 'turn-page', page: 9 });

    expect(source.issued).toHaveLength(1);
  });

  it('abandons the shelf in flight when it lands on one the atlas holds', async () => {
    // One pointer click reaches this: a gesture is a single `dispatchAll`, so
    // the resolver sees one notification, and landing on a shelf the atlas
    // already holds while another shelf's 32 titles are in flight used to skip
    // the cancellation entirely. The worker went on computing them, the stale
    // reply then cleared nothing, and the resolver reported busy for ever, so
    // `waitForIdle()` could never return. Every other cancellation test here
    // leaves an in-flight shelf for a shelf the atlas does *not* hold, which
    // is why 974 tests and 20 scenarios stayed green.
    const { navigation, source, resolver } = harness();
    goTo(navigation, SHELF, 3);
    source.forShelf(SHELF).resolve(titlesOf(SHELF));
    await Promise.resolve();
    goTo(navigation, OTHER_SHELF);
    const inFlight = source.forShelf(OTHER_SHELF);
    const idle = resolver.whenIdle();

    goTo(navigation, SHELF, 3);

    expect(inFlight.cancelled).toBe(true);
    await idle;
    expect(resolver.isIdle()).toBe(true);
  });

  it('keeps a waiter waiting when the shelf it cancelled settles under a newer one', async () => {
    // `whenIdle()` promises the next moment nothing is being generated, and a
    // superseded reply is not that moment. Cancelling rejects (ADR-0016), so
    // the departed shelf's rejection arrives after the next shelf has already
    // been asked for: it finds itself unwanted, `forgetIfCurrent` leaves the
    // newer request's record alone, and releasing there would hand the waiter
    // an answer with 32 titles still in flight.
    //
    // It is the resolver's `release()` guard that this drives, and the guard
    // is not decoration: the reader and the worker client both have one, this
    // was the one source without, and `whenAllIdle` only papered over it by
    // re-reading the list after every settlement (`./idle.ts`).
    const { navigation, source, resolver } = harness();
    goTo(navigation, SHELF);
    // Taken before the cancellation, because `forShelf` only hands back a
    // request that is still in flight.
    const abandoned = source.forShelf(SHELF);
    const idle = resolver.whenIdle();

    goTo(navigation, OTHER_SHELF);

    expect(abandoned.cancelled).toBe(true);
    expect(await hasSettled(idle)).toBe(false);
    expect(resolver.isIdle()).toBe(false);

    // And it is the arrival of the shelf actually being waited for that ends
    // the wait, which is what makes the assertion above a guard rather than a
    // deadlock.
    source.forShelf(OTHER_SHELF).resolve(titlesOf(OTHER_SHELF));

    await idle;
    expect(resolver.isIdle()).toBe(true);
  });

  it('can ask again for the shelf it abandoned on the way to a drawn one', async () => {
    // The other half: the record of the abandoned request has to be cleared,
    // or returning to that shelf hits the in-flight guard and it is never
    // asked again, so its spines stay blank for the rest of the session.
    const { navigation, source } = harness();
    goTo(navigation, SHELF, 3);
    source.forShelf(SHELF).resolve(titlesOf(SHELF));
    await Promise.resolve();
    goTo(navigation, OTHER_SHELF);
    goTo(navigation, SHELF, 3);

    goTo(navigation, OTHER_SHELF);

    expect(
      source.issued.filter((issued) => keyOf(issued.shelf) === keyOf(OTHER_SHELF))
    ).toHaveLength(2);
  });

  it('does not let a reply for a shelf the camera returned to erase the newer request', async () => {
    // The guard on `release()` reads `isIdle()`, so anything that can falsify
    // `isIdle()` defeats it from one line away. A bare `forget()` is exactly
    // that: it nulls the record whatever is in it, and a shelf the machine
    // left and came back to inside one task is *wanted* again by the time its
    // cancellation rejects, so the stale reply takes the branch for a shelf it
    // still wants and wipes the record of the request issued on the return.
    //
    // Three things are lost at once, which is why this is worth a test for a
    // sequence the interface cannot produce today: `waitForIdle()` returns
    // with 32 titles in flight, the next event inside the shelf re-asks and
    // pays the fan-out ADR-0032 measures, and nothing can cancel the orphaned
    // request any more - the worker goes on computing a shelf the camera has
    // left, which is the whole point of ADR-0016's cancellation.
    const { navigation, source, resolver } = harness();
    goTo(navigation, SHELF, 3);
    source.forShelf(SHELF).resolve(titlesOf(SHELF));
    await Promise.resolve();

    goTo(navigation, OTHER_SHELF);
    const abandoned = source.forShelf(OTHER_SHELF);
    goTo(navigation, SHELF, 3);
    goTo(navigation, OTHER_SHELF);
    const reasked = source.forShelf(OTHER_SHELF);
    const idle = resolver.whenIdle();

    expect(abandoned.cancelled).toBe(true);
    expect(await hasSettled(idle)).toBe(false);
    expect(resolver.isIdle()).toBe(false);

    // And the request that survived is still the resolver's to cancel.
    goTo(navigation, SHELF, 3);

    expect(reasked.cancelled).toBe(true);
  });

  it('asks again for a shelf the atlas has displaced', async () => {
    // Which is why nothing here remembers having asked: the atlas holds seven
    // shelves of a room's twenty and displaces them in turn, so a shelf can
    // stop being drawn without this module being told. Asking the atlas is
    // what makes the re-draw happen by itself.
    const { navigation, source, room } = harness();
    goTo(navigation, SHELF, 3);
    source.forShelf(SHELF).resolve(titlesOf(SHELF));
    await Promise.resolve();

    room.evict(firstSlotOf(SHELF));
    navigation.dispatch({ type: 'turn-page', page: 9 });

    expect(source.issued).toHaveLength(2);
    expect(source.issued[1]?.shelf).toEqual(SHELF);
  });
});

describe('what the camera has left behind', () => {
  it('cancels the shelf in flight when the machine moves to another', () => {
    const { navigation, source } = harness();
    goTo(navigation, SHELF);

    goTo(navigation, OTHER_SHELF);

    expect(source.forShelf(OTHER_SHELF).shelf).toEqual(OTHER_SHELF);
    expect(source.issued[0]?.cancelled).toBe(true);
  });

  it('cancels the shelf in flight when the camera climbs away from it', () => {
    const { navigation, source } = harness();
    goTo(navigation, SHELF);

    navigation.dispatch({ type: 'back' });

    expect(source.issued[0]?.cancelled).toBe(true);
  });

  it('writes nothing for a shelf the machine has left, even if it answers', async () => {
    const { navigation, source, room } = harness();
    goTo(navigation, SHELF);
    const abandoned = source.forShelf(SHELF);
    goTo(navigation, OTHER_SHELF);

    // A reply that was already on its way when the cancel went out. The real
    // client drops it (ADR-0016); the resolver must not write it either.
    abandoned.resolve(titlesOf(SHELF));
    await Promise.resolve();

    expect(room.written).toEqual([]);
  });

  it('ignores a cached shelf superseded inside the same task as its turn', async () => {
    const { navigation, source, room } = harness();
    source.cache(SHELF);
    source.cache(OTHER_SHELF);

    goTo(navigation, SHELF);
    goTo(navigation, OTHER_SHELF);
    await Promise.resolve();
    await Promise.resolve();

    // Both replies resolve as microtasks, in the order they were asked for,
    // so only the guard keeps the first one off the spines.
    expect(room.written.map((write) => write.firstSlot)).toEqual([
      firstSlotOf(OTHER_SHELF),
    ]);
  });

  it('settles and asks again when a shelf fails while the camera stays on it', async () => {
    // The test below leaves the shelf first, and leaving clears the record by
    // itself (`abandon()`), so it never exercises the rejection handler's own
    // clear. This does: the camera stays where it is and the generation fails
    // under it. Without the clear the record of a request that is over sits
    // there for the rest of the session, which costs both of the things the
    // record governs - `waitForIdle()` waits on a shelf nothing is generating,
    // and a further event inside that shelf matches `sameShelf` and never asks
    // again, so its spines stay blank with no error anywhere.
    const { navigation, source, resolver } = harness();
    goTo(navigation, SHELF);
    const idle = resolver.whenIdle();

    source.forShelf(SHELF).reject(new Error('the worker gave up'));

    await idle;
    expect(resolver.isIdle()).toBe(true);

    goTo(navigation, SHELF, 3);

    expect(source.issued).toHaveLength(2);
  });

  it('asks again for a shelf whose titles never arrived', async () => {
    const { navigation, source } = harness();
    goTo(navigation, SHELF);
    source.forShelf(SHELF).reject(new Error('the worker gave up'));
    await Promise.resolve();

    navigation.dispatch({ type: 'back' });
    goTo(navigation, SHELF);

    expect(source.issued).toHaveLength(2);
  });
});

describe('where the titles are written', () => {
  it('writes the whole shelf at the slot of its first volume', async () => {
    const { navigation, source, room } = harness();
    goTo(navigation, SHELF);

    source.forShelf(SHELF).resolve(titlesOf(SHELF));
    await Promise.resolve();

    expect(room.written).toEqual([
      { firstSlot: firstSlotOf(SHELF), titles: titlesOf(SHELF) },
    ]);
  });

  it('writes nothing while no room is loaded', async () => {
    const navigation = createNavigation(ROOM);
    const source = new ScriptedShelves();
    const resolver = createTitleResolver({
      navigation,
      source,
      destination: { room: null },
      onFailure: failLoudly,
    });
    goTo(navigation, SHELF);

    source.forShelf(SHELF).resolve(titlesOf(SHELF));
    await Promise.resolve();

    expect(resolver.isIdle()).toBe(true);
  });

  it('never writes a shelf into a room that is not the one on screen', async () => {
    const navigation = createNavigation(ROOM);
    const source = new ScriptedShelves();
    const elsewhere = new RecordingRoom(ROOM + 1n);
    createTitleResolver({
      navigation,
      source,
      destination: { room: elsewhere },
      onFailure: failLoudly,
    });
    goTo(navigation, SHELF);

    source.forShelf(SHELF).resolve(titlesOf(SHELF));
    await Promise.resolve();

    expect(elsewhere.written).toEqual([]);
  });
});

describe('a room swapped onto the screen', () => {
  const NEXT_ROOM = 37n;
  const NEXT_SHELF: ShelfAddress = { ...SHELF, room: NEXT_ROOM };

  /**
   * A resolver whose destination is changed by the test, as a swap changes
   * the viewer's room. The machine has already moved to `NEXT_SHELF`, so its
   * request went out while the old room was on screen.
   */
  function movedBeforeTheSwap(): {
    source: ScriptedShelves;
    screen: { room: RoomTitles | null };
    nextRoom: RecordingRoom;
    resolver: ReturnType<typeof createTitleResolver>;
  } {
    const navigation = createNavigation(ROOM);
    const source = new ScriptedShelves();
    const screen: { room: RoomTitles | null } = { room: new RecordingRoom(ROOM) };
    const resolver = createTitleResolver({
      navigation,
      source,
      destination: screen,
      onFailure: failLoudly,
    });
    goTo(navigation, NEXT_SHELF);
    return { source, screen, nextRoom: new RecordingRoom(NEXT_ROOM), resolver };
  }

  it('refresh after a swap draws the new room’s shelf from the cache without a worker request', async () => {
    const { source, screen, nextRoom, resolver } = movedBeforeTheSwap();
    source.forShelf(NEXT_SHELF).resolve(titlesOf(NEXT_SHELF));
    await resolver.whenIdle();
    // The reply landed while the old room was loaded, so it was written
    // nowhere; the client kept it, as its cache keeps every reply.
    source.cache(NEXT_SHELF);

    screen.room = nextRoom;
    resolver.refresh();
    await Promise.resolve();

    expect(nextRoom.written).toEqual([
      { firstSlot: firstSlotOf(NEXT_SHELF), titles: titlesOf(NEXT_SHELF) },
    ]);
    expect(source.issued.map((request) => request.fromCache)).toEqual([false, true]);
  });

  it('a shelf reply that arrives after the swap is drawn without a refresh', async () => {
    const { source, screen, nextRoom, resolver } = movedBeforeTheSwap();

    screen.room = nextRoom;
    source.forShelf(NEXT_SHELF).resolve(titlesOf(NEXT_SHELF));
    await resolver.whenIdle();

    expect(nextRoom.written).toEqual([
      { firstSlot: firstSlotOf(NEXT_SHELF), titles: titlesOf(NEXT_SHELF) },
    ]);
    expect(source.issued).toHaveLength(1);
  });
});

describe('the resolver as a source of pending work', () => {
  it('is idle before the camera reaches a shelf', () => {
    const { resolver } = harness();

    expect(resolver.isIdle()).toBe(true);
  });

  it('reports idle at once while nothing is being generated', async () => {
    const { resolver } = harness();

    await resolver.whenIdle();

    expect(resolver.isIdle()).toBe(true);
  });

  it('is busy while a shelf is being generated', () => {
    const { navigation, resolver } = harness();

    goTo(navigation, SHELF);

    expect(resolver.isIdle()).toBe(false);
  });

  it('settles when the shelf arrives', async () => {
    const { navigation, source, resolver } = harness();
    goTo(navigation, SHELF);
    const idle = resolver.whenIdle();

    source.forShelf(SHELF).resolve(titlesOf(SHELF));

    await idle;
    expect(resolver.isIdle()).toBe(true);
  });

  it('settles when the camera leaves the shelf it was generating', async () => {
    const { navigation, resolver } = harness();
    goTo(navigation, SHELF);
    const idle = resolver.whenIdle();

    navigation.dispatch({ type: 'back' });

    await idle;
    expect(resolver.isIdle()).toBe(true);
  });

  it('reports a shelf the atlas refuses, and settles anyway', async () => {
    // Two things at once, because they are the two halves of one defect. The
    // refusal has to reach the owner rather than escape the reply handler,
    // where it would be an unhandled rejection: a console line nobody owns in
    // a browser, and a failed run in this suite. And the waiters have to be
    // released whatever the write did, or `waitForIdle()` hangs on a request
    // that is already over. Removing the `catch` turns this red with an
    // unhandled error; removing the `finally` makes it hang.
    const navigation = createNavigation(ROOM);
    const source = new ScriptedShelves();
    const refused = new Error('a shelf of titles the atlas would not take');
    const reported: unknown[] = [];
    const refusing: RoomTitles = {
      room: ROOM,
      titles: {
        setShelfTitles: () => {
          throw refused;
        },
        shelvesHeld: [],
      },
    };
    const resolver = createTitleResolver({
      navigation,
      source,
      destination: { room: refusing },
      onFailure: (shelf, error) => {
        reported.push({ shelf, error });
      },
    });
    goTo(navigation, SHELF);
    const idle = resolver.whenIdle();

    source.forShelf(SHELF).resolve(titlesOf(SHELF));

    await idle;
    expect(reported).toEqual([{ shelf: SHELF, error: refused }]);
    expect(resolver.isIdle()).toBe(true);
  });

  it('asks for a refused shelf again when the camera comes back', async () => {
    // Nothing is recorded for a shelf that was not drawn, so the retry is the
    // same mechanism a failed generation uses.
    const navigation = createNavigation(ROOM);
    const source = new ScriptedShelves();
    const resolver = createTitleResolver({
      navigation,
      source,
      destination: {
        room: {
          room: ROOM,
          titles: {
            setShelfTitles: () => {
              throw new Error('a shelf of titles the atlas would not take');
            },
            shelvesHeld: [],
          },
        },
      },
      onFailure: () => undefined,
    });
    goTo(navigation, SHELF);
    source.forShelf(SHELF).resolve(titlesOf(SHELF));
    await resolver.whenIdle();

    navigation.dispatch({ type: 'back' });
    goTo(navigation, SHELF);

    expect(source.issued).toHaveLength(2);
  });

  it('settles when it is disposed, and stops following the machine', async () => {
    const { navigation, source, resolver } = harness();
    goTo(navigation, SHELF);
    const idle = resolver.whenIdle();

    resolver.dispose();

    await idle;
    expect(source.issued[0]?.cancelled).toBe(true);
    goTo(navigation, OTHER_SHELF);
    expect(source.issued).toHaveLength(1);
  });
});
