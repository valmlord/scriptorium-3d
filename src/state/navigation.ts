import { assertValidAddress } from '@core/address';
import type { Address, BookAddress } from '@core/address';
import {
  IllegalTransitionError,
  NonIntegerComponentError,
  RoomChangeUnsupportedError,
} from './errors';

/**
 * The navigation finite state machine: the single source of truth for where
 * the user is (`docs/architecture.md` §4). The camera, the URL and the
 * overlays are projections of this, never independent copies of it.
 *
 * Four levels, one ladder:
 *
 *     room  --select-wall-->  wall  --select-shelf-->  shelf  --select-volume-->  book
 *           <----back-------        <----back--------         <----back---------   |
 *                                                                   turn-page  <---+
 *
 * **The ladder is the whole of it, deliberately.** There is no sideways move —
 * no choosing another wall while standing at a wall — because a level is a
 * camera distance and a sideways move is `back` followed by a descent. Writing
 * it as its own transition would mean a timeline between every pair of
 * siblings, which is the combinatorial growth ADR-0004 exists to prevent;
 * `eventsTo` below composes the two-step route instead, and the flight plays
 * it as one continuous movement.
 *
 * **The page is an axis of the `book` level, not a fifth level.** Turning a
 * page moves no camera and changes no level (SPEC §6), so `turn-page` is a
 * transition from `book` to `book` and the page is a component of that state
 * rather than a rung of the ladder. The reader (M6) is the projection that
 * lags behind it, exactly as the camera lags behind a descent (ADR-0030,
 * ADR-0032).
 *
 * **Transitions are explicit and total.** Every one of the twenty
 * `(level, event)` pairs is either in the table below or raises
 * `IllegalTransitionError` — never silently ignored, because an event that
 * changes nothing and reports nothing is indistinguishable from one the user
 * never made. `__tests__/navigation.test.ts` asserts all twenty.
 *
 * **`core` is reached here at runtime**, for `assertValidAddress`. That is the
 * address model — integer range arithmetic over components, with no hashing in
 * it — and not the generation surface: a `getPage` on this thread is the
 * dropped frame ADR-0005 exists to avoid, and page text reaches `state`
 * through the worker client or not at all.
 *
 * **The room is fixed for the lifetime of a `Navigation`.** Changing rooms is
 * a cut rather than a flight — through a corridor (M9) or a deep link (M8) —
 * and it gets its own transition in the milestone that can show it. Until
 * then, asking for a route into another room is refused by name rather than
 * silently resolved in the room you are in.
 */

/**
 * The page a book is entered at. A volume is opened at its first page
 * (SPEC §6), and reaching any other page is a turn the reader asks for.
 */
const ENTRY_PAGE = 0;

/** The levels, from the widest view to the narrowest. The order is the ladder. */
export const NAVIGATION_LEVELS = ['room', 'wall', 'shelf', 'book'] as const;

/** One of the four navigation levels. */
export type NavigationLevel = (typeof NAVIGATION_LEVELS)[number];

/** Every event the machine accepts, legal or not at a given level. */
export const NAVIGATION_EVENT_TYPES = [
  'select-wall',
  'select-shelf',
  'select-volume',
  'turn-page',
  'back',
] as const;

/** The type tag of a navigation event. */
export type NavigationEventType = (typeof NAVIGATION_EVENT_TYPES)[number];

/**
 * Where the user is. A discriminated union rather than one record with
 * nullable components: at the `shelf` level there *is* a wall and a shelf and
 * there is no volume, and a type that says so turns every "which components
 * are meaningful here" question into a compile-time one.
 */
export type NavigationState =
  | { readonly level: 'room'; readonly room: bigint }
  | { readonly level: 'wall'; readonly room: bigint; readonly wall: number }
  | {
      readonly level: 'shelf';
      readonly room: bigint;
      readonly wall: number;
      readonly shelf: number;
    }
  | {
      readonly level: 'book';
      readonly room: bigint;
      readonly wall: number;
      readonly shelf: number;
      readonly volume: number;
      /** Which page of the volume is open: 0 to `PAGES_PER_BOOK - 1`. */
      readonly page: number;
    };

/** What the user asked for: one step of the ladder, or a turn inside a book. */
export type NavigationEvent =
  | { readonly type: 'select-wall'; readonly wall: number }
  | { readonly type: 'select-shelf'; readonly shelf: number }
  | { readonly type: 'select-volume'; readonly volume: number }
  /**
   * The page to open, not a direction. A caller asking for "the next page"
   * computes it from `addressOf`, so two turns arriving in one task name two
   * pages rather than compounding into one the user never asked for — which is
   * what makes an interrupted turn answerable at all (ADR-0032).
   */
  | { readonly type: 'turn-page'; readonly page: number }
  | { readonly type: 'back' };

/**
 * The transition table, as data.
 *
 * It is what `isLegalTransition` answers and what an `IllegalTransitionError`
 * names, while `transition` below does the construction. The two halves are
 * held together by the exhaustive test rather than by care: for all twenty
 * pairs, this table and whether `transition` throws must agree. Deleting an
 * entry here therefore turns a named test red, and so does deleting the branch
 * that builds the state.
 */
const LEGAL_EVENT_TYPES: Readonly<
  Record<NavigationLevel, readonly NavigationEventType[]>
> = {
  room: ['select-wall'],
  wall: ['select-shelf', 'back'],
  shelf: ['select-volume', 'back'],
  book: ['turn-page', 'back'],
};

/** The events that have a transition at `level`, in no particular order. */
export function legalEventTypesAt(
  level: NavigationLevel
): readonly NavigationEventType[] {
  return LEGAL_EVENT_TYPES[level];
}

/** Whether `eventType` has a transition at `level`. */
export function isLegalTransition(
  level: NavigationLevel,
  eventType: NavigationEventType
): boolean {
  return LEGAL_EVENT_TYPES[level].includes(eventType);
}

/** How far down the ladder a level is: `room` is 0 and `book` is 3. */
export function depthOf(level: NavigationLevel): number {
  return NAVIGATION_LEVELS.indexOf(level);
}

/** The state the library opens at: room `room`, nothing chosen inside it. */
export function enterRoom(room: bigint): NavigationState {
  // Validated through the layer that owns the range. Walls, shelves and
  // volumes are at their first legal value, so this reports on the room alone.
  assertValidAddress({ room, wall: 0, shelf: 0, volume: 0, page: 0 });
  return { level: 'room', room };
}

/**
 * The state `event` leads to from `state`.
 *
 * Throws `IllegalTransitionError` for a pair with no transition, and refuses a
 * component that does not exist through `core` before building anything —
 * a wall of 7 is an `InvalidAddressError`, and a volume in the unfilled tail
 * of the last room an `AddressBeyondLibraryError` (SPEC §3).
 */
export function transition(
  state: NavigationState,
  event: NavigationEvent
): NavigationState {
  switch (state.level) {
    case 'room':
      if (event.type === 'select-wall') {
        return atWall(state.room, event.wall);
      }
      break;
    case 'wall':
      if (event.type === 'select-shelf') {
        return atShelf(state.room, state.wall, event.shelf);
      }
      if (event.type === 'back') {
        return enterRoom(state.room);
      }
      break;
    case 'shelf':
      if (event.type === 'select-volume') {
        return atBook(state.room, state.wall, state.shelf, event.volume, ENTRY_PAGE);
      }
      if (event.type === 'back') {
        return atWall(state.room, state.wall);
      }
      break;
    case 'book':
      if (event.type === 'turn-page') {
        return atBook(state.room, state.wall, state.shelf, state.volume, event.page);
      }
      if (event.type === 'back') {
        return atShelf(state.room, state.wall, state.shelf);
      }
      break;
  }
  throw new IllegalTransitionError(
    state.level,
    event.type,
    legalEventTypesAt(state.level)
  );
}

/**
 * The events that walk the machine from `from` to `to`: `back` until the two
 * share an ancestor, then one descent per level.
 *
 * This is what makes a single click on a spine one gesture — and, because the
 * flight plays a whole retarget as one movement, one continuous flight — while
 * leaving the machine a strict ladder. Folding the result through `transition`
 * from `from` yields exactly `to`, which is a property test rather than a
 * claim.
 */
export function eventsTo(
  from: NavigationState,
  to: NavigationState
): readonly NavigationEvent[] {
  if (from.room !== to.room) {
    throw new RoomChangeUnsupportedError(from.room, to.room);
  }

  const events: NavigationEvent[] = [];
  let cursor = from;
  // Up to the deepest level the two still agree on. `isAncestorOf` is false
  // for a disagreement at any level above the cursor's, so this ends at the
  // room level in the worst case rather than looping.
  while (!isAncestorOf(cursor, to)) {
    events.push({ type: 'back' });
    cursor = transition(cursor, { type: 'back' });
  }
  for (const event of descentFrom(cursor, to)) {
    events.push(event);
    cursor = transition(cursor, event);
  }
  return events;
}

/** The full address of the page the user is at, or `null` above the book level. */
export function addressOf(state: NavigationState): Address | null {
  return state.level === 'book'
    ? {
        room: state.room,
        wall: state.wall,
        shelf: state.shelf,
        volume: state.volume,
        page: state.page,
      }
    : null;
}

/** The volume the user is at, or `null` above the book level. */
export function bookAddressOf(state: NavigationState): BookAddress | null {
  return state.level === 'book'
    ? { room: state.room, wall: state.wall, shelf: state.shelf, volume: state.volume }
    : null;
}

/** The state of the book at `address`, open at its first page (SPEC §6). */
export function atBookAddress(address: BookAddress): NavigationState {
  return atBook(address.room, address.wall, address.shelf, address.volume, ENTRY_PAGE);
}

/** A listener notified after the state has changed. */
export type NavigationListener = (state: NavigationState) => void;

/** The machine, holding its current state and who is watching it. */
export interface Navigation {
  /** Where the user is now. */
  readonly state: NavigationState;
  /** Apply one event, notify the listeners, and return the new state. */
  dispatch(event: NavigationEvent): NavigationState;
  /**
   * Apply a whole gesture: every event or none, and one notification at the
   * end. An event with no transition throws and leaves the state untouched,
   * so a half-applied gesture is not a state anyone can observe.
   */
  dispatchAll(events: readonly NavigationEvent[]): NavigationState;
  /** Watch the state. Returns the function that stops watching. */
  subscribe(listener: NavigationListener): () => void;
}

/** Build the machine, opening at room `room`. */
export function createNavigation(room: bigint): Navigation {
  let current = enterRoom(room);
  const listeners = new Set<NavigationListener>();

  const navigation: Navigation = {
    get state(): NavigationState {
      return current;
    },

    dispatch(event: NavigationEvent): NavigationState {
      return navigation.dispatchAll([event]);
    },

    dispatchAll(events: readonly NavigationEvent[]): NavigationState {
      // Folded into a local first, so a rejected event leaves `current` as it
      // was rather than part-way down the ladder.
      let next = current;
      for (const event of events) {
        next = transition(next, event);
      }
      if (next === current) {
        return current;
      }
      current = next;
      for (const listener of listeners) {
        listener(current);
      }
      return current;
    },

    subscribe(listener: NavigationListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return navigation;
}

/**
 * The components a state names below the room, in ladder order: one number per
 * level it has descended. The room itself is not in the list — the rooms are
 * known to agree before this is used — so the list is empty at the room level
 * and three long at a book.
 */
function componentsOf(state: NavigationState): readonly number[] {
  const components: number[] = [];
  if ('wall' in state) {
    components.push(state.wall);
  }
  if ('shelf' in state) {
    components.push(state.shelf);
  }
  if ('volume' in state) {
    components.push(state.volume);
  }
  return components;
}

/**
 * Whether `candidate` is `target` or one of its ancestors, which is exactly:
 * its component list is a prefix of the target's. The room level has an empty
 * list, so it is an ancestor of everything — which is what makes the `back`
 * loop in `eventsTo` terminate rather than ask for a `back` from the room.
 */
function isAncestorOf(candidate: NavigationState, target: NavigationState): boolean {
  const ours = componentsOf(candidate);
  const theirs = componentsOf(target);
  return (
    ours.length <= theirs.length &&
    ours.every((component, index) => component === theirs[index])
  );
}

/**
 * The events from an ancestor `cursor` down to `to`: one descent per level
 * between them, and a page turn if the book they end at is not open at the
 * page `to` names.
 *
 * The turn comes last and is not a rung: a descent arrives at `ENTRY_PAGE`, so
 * the page the cursor is already at only decides this when there is no descent
 * left to make — which is the case of turning a page in the book one is
 * standing in.
 */
function descentFrom(
  cursor: NavigationState,
  to: NavigationState
): readonly NavigationEvent[] {
  const descents: NavigationEvent[] = [];
  if ('wall' in to) {
    descents.push({ type: 'select-wall', wall: to.wall });
  }
  if ('shelf' in to) {
    descents.push({ type: 'select-shelf', shelf: to.shelf });
  }
  if ('volume' in to) {
    descents.push({ type: 'select-volume', volume: to.volume });
  }
  // One descent per level of `to`, so dropping as many as the cursor has
  // already descended leaves exactly the steps between them.
  const ladder = descents.slice(depthOf(cursor.level));
  if (to.level !== 'book') {
    return ladder;
  }
  const openPage = cursor.level === 'book' ? cursor.page : ENTRY_PAGE;
  return to.page === openPage
    ? ladder
    : [...ladder, { type: 'turn-page', page: to.page }];
}

function atWall(room: bigint, wall: number): NavigationState {
  assertComponent('wall', wall);
  // The first volume of that wall. If the library ends before it, the wall
  // holds nothing and does not exist — the same probe `occupiedSlotCount`
  // makes for a slot.
  assertValidAddress({ room, wall, shelf: 0, volume: 0, page: 0 });
  return { level: 'wall', room, wall };
}

function atShelf(room: bigint, wall: number, shelf: number): NavigationState {
  assertComponent('shelf', shelf);
  assertValidAddress({ room, wall, shelf, volume: 0, page: 0 });
  return { level: 'shelf', room, wall, shelf };
}

function atBook(
  room: bigint,
  wall: number,
  shelf: number,
  volume: number,
  page: number
): NavigationState {
  assertComponent('volume', volume);
  assertComponent('page', page);
  assertValidAddress({ room, wall, shelf, volume, page });
  return { level: 'book', room, wall, shelf, volume, page };
}

/**
 * Integrality, which is the one thing `core`'s validator does not check: it is
 * written for addresses produced by `fromLinear`. See `./errors.ts`.
 */
function assertComponent(component: string, value: number): void {
  if (!Number.isInteger(value)) {
    throw new NonIntegerComponentError(component, value);
  }
}
