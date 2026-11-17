import { describe, expect, it, vi } from 'vitest';
import {
  BOOKS_PER_SHELF,
  ROOM_COUNT,
  SHELVES_PER_WALL,
  WALLS_PER_ROOM,
} from '@core/address';
import { AddressBeyondLibraryError, InvalidAddressError } from '@core/errors';
import {
  IllegalTransitionError,
  NonIntegerComponentError,
  RoomChangeUnsupportedError,
} from '@state/errors';
import {
  NAVIGATION_EVENT_TYPES,
  NAVIGATION_LEVELS,
  addressOf,
  atBookAddress,
  bookAddressOf,
  createNavigation,
  depthOf,
  enterRoom,
  eventsTo,
  isLegalTransition,
  legalEventTypesAt,
  transition,
} from '@state/navigation';
import type {
  NavigationEvent,
  NavigationEventType,
  NavigationLevel,
  NavigationState,
} from '@state/navigation';

/**
 * An FSM is a finite object, so "we tested the paths we thought of" is a
 * choice rather than a limitation (`docs/testing.md` §1). The first suite below
 * asserts all sixteen `(level, event)` pairs: four levels times four events,
 * each one legal or refused, with nothing left to assumption.
 *
 * The transition table in `navigation.ts` is data, and `transition` is code
 * that builds states. Either could drift from the other and still look right
 * in review, so the exhaustive pass asserts them *against each other*: for
 * every pair, whether the table calls it legal and whether `transition`
 * throws must agree. Deleting a table entry or a construction branch therefore
 * turns a test red, which is what the roadmap's "removing a transition turns a
 * named test red" asks for.
 */

const ROOM = 0n;
const WALL = 1;
const SHELF = 2;
const VOLUME = 3;

/** The state at one named level, narrowed out of the union. */
type StateAt<Level extends NavigationLevel> = Extract<
  NavigationState,
  { level: Level }
>;

const STATES: { readonly [Level in NavigationLevel]: StateAt<Level> } = {
  room: { level: 'room', room: ROOM },
  wall: { level: 'wall', room: ROOM, wall: WALL },
  shelf: { level: 'shelf', room: ROOM, wall: WALL, shelf: SHELF },
  book: { level: 'book', room: ROOM, wall: WALL, shelf: SHELF, volume: VOLUME },
};

const EVENTS: Readonly<Record<NavigationEventType, NavigationEvent>> = {
  'select-wall': { type: 'select-wall', wall: WALL },
  'select-shelf': { type: 'select-shelf', shelf: SHELF },
  'select-volume': { type: 'select-volume', volume: VOLUME },
  back: { type: 'back' },
};

/** Every pair of the table, as the test's own cartesian product. */
const ALL_PAIRS: readonly { level: NavigationLevel; eventType: NavigationEventType }[] =
  NAVIGATION_LEVELS.flatMap((level) =>
    NAVIGATION_EVENT_TYPES.map((eventType) => ({ level, eventType }))
  );

/**
 * States spanning the ladder, for the route tests. Volumes 0, 1 and 31 rather
 * than all 32: a route depends on whether two components differ, not on which
 * numbers they are, and the full product of 665 states against itself is
 * 442 000 routes for the same four cases.
 */
const WALLS = [0, WALLS_PER_ROOM - 1];
const SHELVES = [0, SHELVES_PER_WALL - 1];
const VOLUMES = [0, 1, BOOKS_PER_SHELF - 1];

const LADDER: readonly NavigationState[] = [
  { level: 'room', room: ROOM },
  ...WALLS.map((wall): NavigationState => ({ level: 'wall', room: ROOM, wall })),
  ...WALLS.flatMap((wall) =>
    SHELVES.map((shelf): NavigationState => ({
      level: 'shelf',
      room: ROOM,
      wall,
      shelf,
    }))
  ),
  ...WALLS.flatMap((wall) =>
    SHELVES.flatMap((shelf) =>
      VOLUMES.map((volume): NavigationState => ({
        level: 'book',
        room: ROOM,
        wall,
        shelf,
        volume,
      }))
    )
  ),
];

/** The `IllegalTransitionError` a pair raises, narrowed rather than asserted. */
function refusalOf(
  state: NavigationState,
  event: NavigationEvent
): IllegalTransitionError {
  try {
    transition(state, event);
  } catch (error: unknown) {
    if (error instanceof IllegalTransitionError) {
      return error;
    }
    throw error;
  }
  throw new Error(
    `Expected ${event.type} to be refused at the ${state.level} level, and it was not`
  );
}

describe('the transition table', () => {
  it.each(ALL_PAIRS)(
    'agrees with the machine about $eventType at the $level level',
    ({ level, eventType }) => {
      const state = STATES[level];
      const event = EVENTS[eventType];

      const legal = isLegalTransition(level, eventType);

      if (legal) {
        expect(NAVIGATION_LEVELS).toContain(transition(state, event).level);
      } else {
        expect(() => transition(state, event)).toThrow(IllegalTransitionError);
      }
    }
  );

  it('declares six of its sixteen pairs legal, and not one more', () => {
    const legal = ALL_PAIRS.filter((pair) =>
      isLegalTransition(pair.level, pair.eventType)
    );

    expect(ALL_PAIRS).toHaveLength(16);
    expect(legal.map((pair) => `${pair.level}:${pair.eventType}`)).toEqual([
      'room:select-wall',
      'wall:select-shelf',
      'wall:back',
      'shelf:select-volume',
      'shelf:back',
      'book:back',
    ]);
  });

  it('names the levels in ladder order, widest first', () => {
    expect([...NAVIGATION_LEVELS]).toEqual(['room', 'wall', 'shelf', 'book']);
    expect(NAVIGATION_LEVELS.map(depthOf)).toEqual([0, 1, 2, 3]);
  });
});

describe('descending the ladder', () => {
  it('enters a wall from the room', () => {
    expect(transition(STATES.room, { type: 'select-wall', wall: 2 })).toEqual({
      level: 'wall',
      room: ROOM,
      wall: 2,
    });
  });

  it('enters a shelf from a wall, keeping the wall', () => {
    expect(transition(STATES.wall, { type: 'select-shelf', shelf: 4 })).toEqual({
      level: 'shelf',
      room: ROOM,
      wall: WALL,
      shelf: 4,
    });
  });

  it('opens a volume from a shelf, keeping the wall and the shelf', () => {
    expect(transition(STATES.shelf, { type: 'select-volume', volume: 31 })).toEqual({
      level: 'book',
      room: ROOM,
      wall: WALL,
      shelf: SHELF,
      volume: 31,
    });
  });
});

describe('climbing back up the ladder', () => {
  it('returns from a book to the shelf it stood on', () => {
    expect(transition(STATES.book, { type: 'back' })).toEqual(STATES.shelf);
  });

  it('returns from a shelf to its wall', () => {
    expect(transition(STATES.shelf, { type: 'back' })).toEqual(STATES.wall);
  });

  it('returns from a wall to the room', () => {
    expect(transition(STATES.wall, { type: 'back' })).toEqual(STATES.room);
  });

  it('refuses to go back from the room, naming what is legal there', () => {
    expect(() => transition(STATES.room, { type: 'back' })).toThrow(
      IllegalTransitionError
    );
    expect(() => transition(STATES.room, { type: 'back' })).toThrow(
      /"back" has no transition at the "room" level: legal here is "select-wall"/
    );
  });
});

describe('a refused transition', () => {
  it('carries the level, the event and the events that would have been legal', () => {
    const error = refusalOf(STATES.book, { type: 'select-volume', volume: 0 });

    expect(error.level).toBe('book');
    expect(error.eventType).toBe('select-volume');
    expect(error.legalEventTypes).toEqual(legalEventTypesAt('book'));
  });

  it('never names an event as legal unless it really is', () => {
    // The refusal's own message is the only part of this module that claims
    // anything about a level other than the one it refuses, so every event it
    // offers is tried: a message that lies is worse than one that says nothing.
    for (const { level, eventType } of ALL_PAIRS) {
      if (isLegalTransition(level, eventType)) {
        continue;
      }
      const error = refusalOf(STATES[level], EVENTS[eventType]);

      expect(error.legalEventTypes).not.toContain(eventType);
      for (const offered of error.legalEventTypes) {
        expect(error.message).toContain(`"${offered}"`);
        expect(NAVIGATION_LEVELS).toContain(
          transition(STATES[level], EVENTS[offered]).level
        );
      }
    }
  });
});

describe('a navigation request for something that does not exist', () => {
  it('refuses a wall outside the four of a room, through core', () => {
    expect(() =>
      transition(STATES.room, { type: 'select-wall', wall: WALLS_PER_ROOM })
    ).toThrow(InvalidAddressError);
  });

  it('refuses a shelf outside the five of a wall, through core', () => {
    expect(() =>
      transition(STATES.wall, { type: 'select-shelf', shelf: SHELVES_PER_WALL })
    ).toThrow(InvalidAddressError);
  });

  it('refuses a volume outside the thirty-two of a shelf, through core', () => {
    expect(() =>
      transition(STATES.shelf, { type: 'select-volume', volume: BOOKS_PER_SHELF })
    ).toThrow(InvalidAddressError);
  });

  it('refuses a room outside the library, through core', () => {
    expect(() => enterRoom(ROOM_COUNT)).toThrow(InvalidAddressError);
    expect(() => enterRoom(-1n)).toThrow(InvalidAddressError);
  });

  it('refuses the first volume of the unfilled tail of the last room', () => {
    // SPEC §3: the last room holds 261 376 pages, so 638 of its 640 volumes
    // exist and slot 638 is the first that does not. Slot 638 is
    // ((3 * 5 + 4) * 32) + 30, which is wall 3, shelf 4, volume 30.
    const tailShelf: NavigationState = {
      level: 'shelf',
      room: ROOM_COUNT - 1n,
      wall: 3,
      shelf: 4,
    };

    expect(transition(tailShelf, { type: 'select-volume', volume: 29 }).level).toBe(
      'book'
    );
    expect(() => transition(tailShelf, { type: 'select-volume', volume: 30 })).toThrow(
      AddressBeyondLibraryError
    );
  });

  it('refuses a component that is not an integer, naming it', () => {
    expect(() => transition(STATES.room, { type: 'select-wall', wall: 1.5 })).toThrow(
      NonIntegerComponentError
    );
    expect(() => transition(STATES.room, { type: 'select-wall', wall: 1.5 })).toThrow(
      /"wall" must be an integer, received 1.5/
    );
    expect(() =>
      transition(STATES.wall, { type: 'select-shelf', shelf: Number.NaN })
    ).toThrow(NonIntegerComponentError);
    expect(() =>
      transition(STATES.shelf, {
        type: 'select-volume',
        volume: Number.POSITIVE_INFINITY,
      })
    ).toThrow(NonIntegerComponentError);
  });
});

describe('the route between two states', () => {
  it('leads from every state in the ladder to every other', () => {
    for (const from of LADDER) {
      for (const to of LADDER) {
        const route = eventsTo(from, to);

        const reached = route.reduce((state, event) => transition(state, event), from);

        expect(reached).toEqual(to);
      }
    }
  });

  it('is empty between a state and itself', () => {
    for (const state of LADDER) {
      expect(eventsTo(state, state)).toEqual([]);
    }
  });

  it('descends three levels from the room to a book', () => {
    expect(eventsTo(STATES.room, STATES.book)).toEqual([
      { type: 'select-wall', wall: WALL },
      { type: 'select-shelf', shelf: SHELF },
      { type: 'select-volume', volume: VOLUME },
    ]);
  });

  it('climbs three levels from a book to the room', () => {
    expect(eventsTo(STATES.book, STATES.room)).toEqual([
      { type: 'back' },
      { type: 'back' },
      { type: 'back' },
    ]);
  });

  it('reaches a neighbouring volume by going back and down again', () => {
    const neighbour: NavigationState = { ...STATES.book, volume: VOLUME + 1 };

    expect(eventsTo(STATES.book, neighbour)).toEqual([
      { type: 'back' },
      { type: 'select-volume', volume: VOLUME + 1 },
    ]);
  });

  it('climbs to the room before descending another wall', () => {
    const elsewhere: NavigationState = {
      level: 'book',
      room: ROOM,
      wall: WALL + 1,
      shelf: 0,
      volume: 0,
    };

    expect(eventsTo(STATES.book, elsewhere)).toEqual([
      { type: 'back' },
      { type: 'back' },
      { type: 'back' },
      { type: 'select-wall', wall: WALL + 1 },
      { type: 'select-shelf', shelf: 0 },
      { type: 'select-volume', volume: 0 },
    ]);
  });

  it('refuses a route into another room, naming both', () => {
    const elsewhere = enterRoom(37n);

    expect(() => eventsTo(STATES.room, elsewhere)).toThrow(RoomChangeUnsupportedError);
    expect(() => eventsTo(STATES.room, elsewhere)).toThrow(/room 0 to room 11/);
  });
});

describe('the address a state names', () => {
  it('is the volume at page 0 once a book is open', () => {
    expect(addressOf(STATES.book)).toEqual({
      room: ROOM,
      wall: WALL,
      shelf: SHELF,
      volume: VOLUME,
      page: 0,
    });
    expect(bookAddressOf(STATES.book)).toEqual({
      room: ROOM,
      wall: WALL,
      shelf: SHELF,
      volume: VOLUME,
    });
  });

  it('is nothing at all above the book level', () => {
    for (const level of ['room', 'wall', 'shelf'] as const) {
      expect(addressOf(STATES[level])).toBeNull();
      expect(bookAddressOf(STATES[level])).toBeNull();
    }
  });

  it('round-trips a book address through the state that holds it', () => {
    const address = { room: ROOM, wall: 3, shelf: 4, volume: 31 };

    expect(bookAddressOf(atBookAddress(address))).toEqual(address);
  });
});

describe('the machine as the single source of truth', () => {
  it('opens at the room it was given, with nothing chosen inside it', () => {
    const navigation = createNavigation(7n);

    expect(navigation.state).toEqual({ level: 'room', room: 7n });
  });

  it('tells its listeners where the user now is', () => {
    const navigation = createNavigation(ROOM);
    const listener = vi.fn();
    navigation.subscribe(listener);

    navigation.dispatch({ type: 'select-wall', wall: 2 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({ level: 'wall', room: ROOM, wall: 2 });
    expect(navigation.state).toEqual({ level: 'wall', room: ROOM, wall: 2 });
  });

  it('stops telling a listener that has unsubscribed', () => {
    const navigation = createNavigation(ROOM);
    const listener = vi.fn();
    const unsubscribe = navigation.subscribe(listener);

    unsubscribe();
    navigation.dispatch({ type: 'select-wall', wall: 2 });

    expect(listener).not.toHaveBeenCalled();
  });

  it('applies a whole gesture and reports it once', () => {
    const navigation = createNavigation(ROOM);
    const listener = vi.fn();
    navigation.subscribe(listener);

    const reached = navigation.dispatchAll(eventsTo(navigation.state, STATES.book));

    expect(reached).toEqual(STATES.book);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(STATES.book);
  });

  it('leaves the state untouched when a gesture is refused part-way', () => {
    const navigation = createNavigation(ROOM);
    const listener = vi.fn();
    navigation.subscribe(listener);

    expect(() =>
      navigation.dispatchAll([
        { type: 'select-wall', wall: 1 },
        { type: 'select-wall', wall: 2 },
      ])
    ).toThrow(IllegalTransitionError);

    expect(navigation.state).toEqual(STATES.room);
    expect(listener).not.toHaveBeenCalled();
  });

  it('says nothing when the gesture is empty', () => {
    const navigation = createNavigation(ROOM);
    const listener = vi.fn();
    navigation.subscribe(listener);

    expect(navigation.dispatchAll([])).toEqual(STATES.room);
    expect(listener).not.toHaveBeenCalled();
  });
});
