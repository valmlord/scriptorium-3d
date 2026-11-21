import type { Address, BookAddress } from '@core/address';
import { ROOM_STOP, flightRouteTo } from '@engine/poses';
import { advanceMotionClockTo } from '@motion/clock';
import { createFlight } from '@motion/flight';
import { snapshotOf } from '@motion/rig';
import type { CameraRig, CameraRigSnapshot } from '@motion/rig';
import {
  addressOf,
  atBookAddress,
  createNavigation,
  enterRoom,
  eventsTo,
  isLegalTransition,
} from '@state/navigation';
import type { Navigation, NavigationState } from '@state/navigation';

/**
 * Where the three layers of M5 meet: the navigation machine decides where the
 * user is, the engine says where the camera stands at each level, and the
 * flight moves it there.
 *
 * `app` is the only layer allowed to import all three (`docs/architecture.md`
 * §1), and this is the whole of the wiring:
 *
 * - the machine is subscribed to, and every change retargets the flight;
 * - the route comes from `@engine/poses`, which knows the room's geometry;
 * - the rig comes from `@motion`, which knows nothing about rooms;
 * - the render loop calls `frame` once per frame, and `frame` is the only
 *   place the animation clock is advanced, and the only place the room on
 *   screen is changed.
 *
 * **The machine commits on the event and the camera catches up** (ADR-0030).
 * `state` is where the user is the instant they choose, and the rig is a
 * projection of it that lags by the length of a flight. Nothing here waits for
 * an animation before telling the rest of the application where the user is,
 * which is what architecture §4 means by the camera being a projection.
 *
 * **A change of room is flown up, swapped at the top and flown down.** The
 * room on screen is not the machine's to decide: the viewer holds it, and
 * this file reads it through `shownRoom` and changes it through `showRoom`,
 * keeping no copy of its own. While the machine names a room the screen does
 * not show, the flight goes to the room stop of the room on screen, which is
 * the one pose both rooms share. The frame in which it has settled there swaps
 * the room and starts the descent in the new one, so the swap is never seen
 * mid-flight and the descent starts in the frame the retreat ended in.
 *
 * There is no three.js in this file and no DOM. That is not an accident of
 * scope: it is what lets the whole of M5's behaviour — a flight interrupted
 * halfway, the machine and the rig agreeing afterwards — be tested without a
 * WebGL context (`docs/testing.md` §1), and it leaves `./controls.ts` as the
 * only part that needs one.
 */

/** The camera choreography, driven by the navigation machine. */
export interface Choreography {
  /** The machine itself, for anything that needs to watch where the user is. */
  readonly navigation: Navigation;
  /** Where the user is now. */
  readonly state: NavigationState;
  /** The address of the volume the user is at, or `null` above the book level. */
  readonly address: Address | null;
  /** A copy of the rig's current numbers, for a caller that must not write them. */
  rig(): CameraRigSnapshot;
  /**
   * Advance the animation clock to the render loop's timestamp and hand back
   * the rig to put the camera at. The returned object is the live rig rather
   * than a copy: this is called once per frame and `architecture.md` §2 allows
   * no allocation there.
   */
  frame(seconds: number): CameraRig;
  /** Fly to `address`, through every level between here and it. */
  openVolume(address: BookAddress): void;
  /** Go up one level. `false` when there is nowhere to go, at the room level. */
  back(): boolean;
  /**
   * Whether the camera has arrived where the machine says the user is, in the
   * room the machine names. Always true once disposed.
   */
  isIdle(): boolean;
  /** Resolves the next time the camera has arrived, or once disposed. */
  whenIdle(): Promise<void>;
  /** Stop watching the machine and release the timeline. */
  dispose(): void;
}

/** How the choreography reaches the room on screen, which the viewer holds. */
export interface ChoreographyOptions {
  /** The room on screen now (`./shown-room.ts`). Read, never copied. */
  readonly shownRoom: () => bigint;
  /**
   * Put `room` on screen. Called only from `frame`, with the camera settled at
   * the room stop; afterwards `shownRoom` must answer `room`.
   */
  readonly showRoom: (room: bigint) => void;
}

/** A promise and the function that settles it, for the change waiters. */
interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

/** Build the choreography for `room`, resting at that room's own vantage. */
export function createChoreography(
  room: bigint,
  options: ChoreographyOptions
): Choreography {
  const { shownRoom, showRoom } = options;
  const navigation = createNavigation(room);
  const flight = createFlight(ROOM_STOP);
  let disposed = false;

  /**
   * Pending until the next change that can end a wait while the rooms
   * disagree: a swap, a machine notification, or `dispose`.
   *
   * `whenIdle` cannot wait on the flight then. A retreat can settle outside
   * any frame (a change of room asked for at the room level settles inside
   * `dispatchAll`), so `flight.whenSettled()` is already resolved while the
   * rooms disagree, and a loop over it would spin in microtasks with no frame
   * ever running the swap that would end it. Each release replaces the
   * deferred with a fresh one before resolving the old, so a waiter that
   * finds nothing changed waits on a pending promise again rather than on the
   * one that has just been resolved.
   */
  let change = deferred();

  // Every accepted event retargets the flight, and a whole gesture arrives as
  // one notification (`Navigation.dispatchAll`), so a click that descends
  // three levels is one retarget and therefore one continuous movement.
  const unsubscribe = navigation.subscribe((state) => {
    retarget(state);
    releaseChange();
  });

  return {
    navigation,

    get state(): NavigationState {
      return navigation.state;
    },

    get address(): Address | null {
      return addressOf(navigation.state);
    },

    rig(): CameraRigSnapshot {
      return snapshotOf(flight.rig);
    },

    frame(seconds: number): CameraRig {
      advanceMotionClockTo(seconds);
      // Rooms first: at rest this is one `bigint` comparison that is false,
      // and `isSettled`, which allocates on its way to an answer, is never
      // read in a frame where there is nothing to swap.
      if (!disposed && navigation.state.room !== shownRoom() && flight.isSettled) {
        swap();
      }
      return flight.rig;
    },

    openVolume(address: BookAddress): void {
      navigation.dispatchAll(eventsTo(navigation.state, atBookAddress(address)));
    },

    back(): boolean {
      // Asked rather than attempted and caught: `back` at the room level has
      // no transition (`@state`), and a caller that offers the user a way up
      // needs to know that before it offers it.
      if (!isLegalTransition(navigation.state.level, 'back')) {
        return false;
      }
      navigation.dispatch({ type: 'back' });
      return true;
    },

    isIdle(): boolean {
      // The camera is the only thing here that can be busy; the worker
      // client's own idleness joins it through the composition in
      // `src/main.ts` rather than through a second opinion held here. A
      // disposed choreography is idle because `whenIdle` resolves after
      // `dispose`: `whenAllIdle` loops while a source reports busy, and would
      // spin over that resolved promise if the two disagreed.
      return disposed || (navigation.state.room === shownRoom() && flight.isSettled);
    },

    async whenIdle(): Promise<void> {
      while (!disposed) {
        if (navigation.state.room !== shownRoom()) {
          await change.promise;
        } else if (flight.isSettled) {
          return;
        } else {
          // Pending while the rooms agree and the camera is moving; released
          // by the flight settling or being disposed.
          await flight.whenSettled();
        }
      }
    },

    dispose(): void {
      disposed = true;
      unsubscribe();
      flight.dispose();
      releaseChange();
    },
  };

  /**
   * Fly to where the machine says the user is, or, while the machine names a
   * room the screen does not show, to the room stop of the room on screen.
   */
  function retarget(state: NavigationState): void {
    const shown = shownRoom();
    if (state.room === shown) {
      flight.flyTo(flightRouteTo(state), state.level);
      return;
    }
    const retreat = enterRoom(shown);
    flight.flyTo(flightRouteTo(retreat), retreat.level);
  }

  /**
   * Put the machine's room on screen and fly the machine's route in it, in
   * the frame the retreat settled in. The built legs carry no room, so a
   * route to the same wall, shelf and volume in the new room keeps them.
   */
  function swap(): void {
    const state = navigation.state;
    showRoom(state.room);
    flight.flyTo(flightRouteTo(state), state.level);
    releaseChange();
  }

  function releaseChange(): void {
    const released = change;
    change = deferred();
    released.resolve();
  }
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
