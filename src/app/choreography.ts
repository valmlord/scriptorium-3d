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
 *   place the animation clock is advanced.
 *
 * **The machine commits on the event and the camera catches up** (ADR-0030).
 * `state` is where the user is the instant they choose, and the rig is a
 * projection of it that lags by the length of a flight. Nothing here waits for
 * an animation before telling the rest of the application where the user is,
 * which is what architecture §4 means by the camera being a projection.
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
  /** Whether the camera has arrived where the machine says the user is. */
  isIdle(): boolean;
  /** Resolves the next time the camera has arrived. */
  whenIdle(): Promise<void>;
  /** Stop watching the machine and release the timeline. */
  dispose(): void;
}

/** Build the choreography for `room`, resting at that room's own vantage. */
export function createChoreography(room: bigint): Choreography {
  const navigation = createNavigation(room);
  const flight = createFlight(ROOM_STOP);

  // Every accepted event retargets the flight, and a whole gesture arrives as
  // one notification (`Navigation.dispatchAll`), so a click that descends
  // three levels is one retarget and therefore one continuous movement.
  const unsubscribe = navigation.subscribe((state) => {
    flight.flyTo(flightRouteTo(state), state.level);
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
      // The camera is the only thing that can be busy in M5. From M6 the
      // worker client's own idleness joins this, through the composition in
      // `src/main.ts` rather than through a second opinion held here.
      return flight.isSettled;
    },

    whenIdle(): Promise<void> {
      return flight.whenSettled();
    },

    dispose(): void {
      unsubscribe();
      flight.dispose();
    },
  };
}
