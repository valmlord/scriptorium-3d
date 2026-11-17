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

/** A room that records what was written onto its spines. */
class RecordingRoom implements RoomTitles {
  readonly written: { firstSlot: number; titles: readonly string[] }[] = [];

  constructor(readonly room: bigint) {}

  readonly titles = {
    setShelfTitles: (firstSlot: number, titles: readonly string[]): void => {
      this.written.push({ firstSlot, titles });
    },
  };
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
  const resolver = createTitleResolver({ navigation, source, destination });
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

  it('does not ask again for the shelf it is already resolving', () => {
    const { navigation, source } = harness();
    goTo(navigation, SHELF);

    // Down to a volume of the same shelf, which is a new state and the same
    // shelf of spines.
    goTo(navigation, SHELF, 3);

    expect(source.issued).toHaveLength(1);
  });

  it('does not ask again when only the page turns', () => {
    const { navigation, source } = harness();
    goTo(navigation, SHELF, 3);

    navigation.dispatch({ type: 'turn-page', page: 9 });

    expect(source.issued).toHaveLength(1);
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
    createTitleResolver({ navigation, source, destination: { room: elsewhere } });
    goTo(navigation, SHELF);

    source.forShelf(SHELF).resolve(titlesOf(SHELF));
    await Promise.resolve();

    expect(elsewhere.written).toEqual([]);
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
