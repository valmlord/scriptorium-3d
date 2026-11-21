import { gsap } from 'gsap';
import { takeOverGsapClock } from './clock';
import {
  FlightOriginMismatchError,
  InvalidLegDurationError,
  RepeatedFlightLabelError,
  UnknownFlightLabelError,
} from './errors';
import { RIG_FIELDS, createRig, posesEqual } from './rig';
import type { CameraPose, CameraRig } from './rig';

/**
 * The master timeline, and the one rule that moves it.
 *
 * **The rig is a pure function of the playhead.** The timeline is built from
 * `fromTo` tweens with both ends written out, so the rig's value at a given
 * time is decided by the route and not by when the timeline first rendered or
 * by where the rig happened to be. Seek to a time and the rig is that time's
 * values, in any order, any number of times. That is what makes an
 * interruption safe: the rig can never be left in a state that is not on the
 * timeline, because nothing but the timeline ever writes it.
 *
 * **One label per level, and a leg between each pair.** A route is an origin
 * stop and the legs below it, so a flight from the room to a book is one
 * timeline with the labels `room`, `wall`, `shelf` and `book` on it. Flying to
 * a level is taking the playhead to that label; going back is taking it to the
 * label above. Both directions are the same timeline, which is ADR-0004's
 * "going back is `.reverse()` of that same timeline, never a second
 * hand-written animation" — see the note on the mechanism below.
 *
 * **The legs are linear and the playhead carries the ease.** Every leg is
 * `ease: 'none'`, so the timeline is pure geometry: a path through rig space
 * with a pace, and no opinion about acceleration. The one ease lives on the
 * playhead tween, which means a descent across three levels eases once from
 * rest to rest rather than three times, and is therefore one continuous
 * flight rather than three hops that happen to touch.
 *
 * **`.reverse()` is not the mechanism, and the reason matters.** gsap's
 * `reverse()` has exactly one destination, the start of the timeline, and the
 * ladder has four. Going back one level has to stop at the label above, so the
 * playhead is tweened there instead — the same timeline, played backwards,
 * through the same tweens, with no second animation to keep in step. What
 * ADR-0004 rules out is a second hand-written animation for the way back, and
 * there is none: a playhead tween is gsap's own scrub of this timeline, and
 * `__tests__/flight.test.ts` asserts that returning leaves the rig at its
 * starting values to within a floating-point epsilon.
 *
 * **What happens when a flight is interrupted** is ADR-0030, and the rule is
 * one sentence: the playhead is retargeted, and the timeline is never rebuilt
 * while the playhead is inside or beyond the part being rebuilt. An
 * interruption therefore kills a playhead tween and never a leg, and when a
 * new route disagrees with the built one the flight first takes the playhead
 * back to the last stop the two still agree on. Both phases are the same
 * mechanism, so there is no special case to get wrong.
 *
 * **A cut is the same two steps with no time in them.** When the flight's
 * `cut` option says so, the playhead is sought to each destination instead of
 * tweened there, and the arrival runs in the same call. The retreat and the
 * descent still happen in that order, so the timeline is still never rebuilt
 * under the playhead; what disappears is only the movement between them. It is
 * what `prefers-reduced-motion` asks for, and the reason the option is a getter
 * is that the preference can change while the page is open.
 */

/** gsap's timeline type, without naming its ambient namespace. */
export type MotionTimeline = ReturnType<typeof gsap.timeline>;

/** gsap's tween type, likewise. */
type MotionTween = ReturnType<typeof gsap.to>;

/** A named point on the timeline, and the rig values there. */
export interface FlightStop {
  /** The gsap label, which is the navigation level's name. */
  readonly label: string;
  /** The rig values at that label. */
  readonly pose: CameraPose;
}

/** A stop, plus how long the leg that reaches it takes. */
export interface FlightLeg extends FlightStop {
  /**
   * Seconds of timeline between the stop above and this one. It is the leg's
   * share of the flight rather than its duration in real time: the playhead
   * tween's ease decides how fast the playhead crosses it.
   */
  readonly seconds: number;
}

/** Where a flight can go: the origin it hangs from, and the legs below it. */
export interface FlightRoute {
  readonly origin: FlightStop;
  readonly legs: readonly FlightLeg[];
}

/**
 * The ease every flight is flown with, applied to the playhead and therefore
 * to the whole movement however many levels it crosses. `inOut` because a
 * flight starts and ends at rest: the camera is standing still at a level
 * before and after.
 */
const FLIGHT_EASE = 'power2.inOut';

/**
 * How close to a label counts as being at it, in seconds of timeline.
 *
 * The playhead arrives by tween, so its value is the sum of floating-point
 * steps and not the label's own number. A microsecond of timeline is nothing
 * anybody can see and is many orders of magnitude below the shortest leg.
 */
const PLAYHEAD_EPSILON_SECONDS = 1e-6;

/** How a flight is flown, as opposed to where it goes. */
export interface FlightOptions {
  /**
   * Whether the next movement arrives at once rather than being flown. Asked
   * each time the playhead is sent somewhere, never remembered, so a change
   * of answer applies to the next flight and not to one already arrived.
   */
  readonly cut: () => boolean;
}

/** A flight in progress, or at rest. */
export interface Flight {
  /** The rig the timeline writes. The render loop reads this object. */
  readonly rig: CameraRig;
  /**
   * The master timeline. Exposed so that a test can advance and inspect it —
   * `docs/testing.md` §1 tests this layer by advancing timelines — and because
   * `window.__scriptorium` reports where the playhead is. The flight is its
   * only writer.
   */
  readonly timeline: MotionTimeline;
  /** The label the playhead is being taken to. */
  readonly targetLabel: string;
  /** Whether the rig has arrived at that label and nothing is moving it. */
  readonly isSettled: boolean;
  /** Take the rig to `label` on `route`, from wherever it is now. */
  flyTo(route: FlightRoute, label: string): void;
  /** Resolves the next time the flight is settled. */
  whenSettled(): Promise<void>;
  /** Release the timeline and anything moving it. */
  dispose(): void;
}

/**
 * Build a flight resting at `origin`.
 *
 * The rig starts at the origin's pose, the timeline carries the origin's label
 * at time zero, and every route handed to `flyTo` must begin at that same
 * stop: it is the one point all routes share, so it is where a retreat ends
 * and where a rebuilt route is appended from.
 */
export function createFlight(origin: FlightStop, options: FlightOptions): Flight {
  const { cut } = options;

  // Before any animation exists, so that gsap's own ticker never gets a frame
  // of this application's time (`./clock.ts`).
  takeOverGsapClock();

  const rig = createRig(origin.pose);
  const timeline = gsap.timeline({ paused: true });
  timeline.addLabel(origin.label, 0);

  /** A leg that is in the timeline, with the tween that animates it. */
  interface InstalledLeg {
    readonly leg: FlightLeg;
    readonly tween: MotionTween;
  }

  const installed: InstalledLeg[] = [];
  const settledWaiters: (() => void)[] = [];

  let wantedRoute: FlightRoute | null = null;
  let wantedLabel = origin.label;
  let playhead: MotionTween | null = null;
  let playheadDestination: number | null = null;

  const flight: Flight = {
    rig,
    timeline,

    get targetLabel(): string {
      return wantedLabel;
    },

    get isSettled(): boolean {
      return playhead === null && isAtWantedStop();
    },

    flyTo(route: FlightRoute, label: string): void {
      assertSameOrigin(route.origin);
      assertLegs(route.legs);
      assertLabelOnRoute(route, label);

      wantedRoute = route;
      wantedLabel = label;
      advance();
    },

    whenSettled(): Promise<void> {
      if (flight.isSettled) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        settledWaiters.push(resolve);
      });
    },

    dispose(): void {
      killPlayhead();
      // Kills the timeline and every leg in it. Nothing writes the rig
      // afterwards, so the waiters are released rather than left pending.
      timeline.kill();
      installed.length = 0;
      releaseWaiters();
    },
  };

  return flight;

  /**
   * Take one step towards what was last asked for, and arrange to be called
   * again if one step is not enough.
   *
   * There are exactly two steps, which is the whole of the interruption
   * design: take the playhead back to the last stop the built route and the
   * wanted route agree on, then rebuild below it and go down. A route that
   * already agrees as far as the target skips the first.
   */
  function advance(): void {
    if (wantedRoute === null) {
      settle();
      return;
    }

    const legs = wantedRoute.legs;
    const kept = keptLegCount(legs);
    const targetIndex = legIndexOf(wantedLabel, legs);

    if (targetIndex >= kept) {
      const boundary = kept === 0 ? 0 : endSecondsOf(kept - 1);
      if (timeline.time() > boundary + PLAYHEAD_EPSILON_SECONDS) {
        // Still inside or beyond the part that has to be rebuilt. Retreat
        // first; `onPlayheadArrived` runs this function again from there.
        startPlayhead(boundary);
        return;
      }
      truncateFrom(kept);
      appendLegs(legs.slice(kept));
    }

    startPlayhead(targetIndex === -1 ? 0 : endSecondsOf(targetIndex));
  }

  /**
   * Begin, or keep, a playhead tween towards `destination`, or under a cut
   * take the playhead there at once.
   */
  function startPlayhead(destination: number): void {
    // Asked before the check below, so that a cut asked for while a tween is
    // already on its way to the same place still ends that tween.
    const isCut = cut();
    if (
      !isCut &&
      playheadDestination !== null &&
      Math.abs(playheadDestination - destination) < PLAYHEAD_EPSILON_SECONDS
    ) {
      // Already on the way there. Replacing the tween would restart its ease
      // from a standstill in the middle of a flight.
      return;
    }
    killPlayhead();

    // Before the cut, because it is what ends one: a cut arrives, `advance`
    // sends the playhead where it already is, and this settles it.
    if (Math.abs(timeline.time() - destination) < PLAYHEAD_EPSILON_SECONDS) {
      settle();
      return;
    }

    if (isCut) {
      // The legs are `fromTo`, so the rig after a seek is that time's values
      // whatever lay between; the arrival runs now, which makes a retreat and
      // the descent after it two seeks in this one call.
      timeline.seek(destination);
      onPlayheadArrived();
      return;
    }

    playheadDestination = destination;
    // gsap's own scrub of this timeline: the one writer of the playhead
    // outside a cut, and the only animation a retarget ever kills.
    playhead = timeline.tweenTo(destination, {
      ease: FLIGHT_EASE,
      onComplete: onPlayheadArrived,
    });
  }

  function onPlayheadArrived(): void {
    playhead = null;
    playheadDestination = null;
    advance();
  }

  function killPlayhead(): void {
    if (playhead !== null) {
      playhead.kill();
    }
    playhead = null;
    playheadDestination = null;
  }

  function settle(): void {
    if (flight.isSettled) {
      releaseWaiters();
    }
  }

  function releaseWaiters(): void {
    for (const resolve of settledWaiters.splice(0)) {
      resolve();
    }
  }

  /**
   * Whether the playhead is at the stop that was last asked for.
   *
   * A label is a level's name, so the built route and a newly wanted one can
   * both carry a `wall` stop at the same time on the timeline and mean
   * different walls — and reporting "arrived" on the label alone would be a
   * debug hook that lies. What makes the playhead's position enough to answer
   * with is `advance()`: a retarget whose route disagrees at or above its
   * target either starts a retreat or replaces the legs below the stop it is
   * standing at, and either way it ends by aiming the playhead at a time
   * strictly away from where it is. So the flight never comes to rest at a
   * label whose route has been superseded, and `__tests__/flight.test.ts`
   * holds the case: asked for another shelf while standing at one, it reports
   * that it has not arrived.
   */
  function isAtWantedStop(): boolean {
    if (wantedRoute === null) {
      return true;
    }
    const targetIndex = legIndexOf(wantedLabel, wantedRoute.legs);
    const destination = targetIndex === -1 ? 0 : endSecondsOf(targetIndex);
    return Math.abs(timeline.time() - destination) < PLAYHEAD_EPSILON_SECONDS;
  }

  /** How many of the built legs the wanted route agrees with, from the top. */
  function keptLegCount(legs: readonly FlightLeg[]): number {
    let kept = 0;
    for (const [index, item] of installed.entries()) {
      const wanted = legs[index];
      if (wanted === undefined || !sameLeg(item.leg, wanted)) {
        break;
      }
      kept = index + 1;
    }
    return kept;
  }

  /**
   * The time the built leg at `index` ends at, summed from the durations of
   * the legs above it. Summed rather than stored so that the leg durations are
   * the one place a stop's time comes from, and total for any index: `-1` is
   * the origin at time zero. Three legs at most, and never called in a frame.
   */
  function endSecondsOf(index: number): number {
    return installed
      .slice(0, index + 1)
      .reduce((seconds, item) => seconds + item.leg.seconds, 0);
  }

  /** Remove the built legs from `index` down, with their labels. */
  function truncateFrom(index: number): void {
    for (const item of installed.splice(index)) {
      timeline.remove(item.tween);
      item.tween.kill();
      timeline.removeLabel(item.leg.label);
    }
  }

  /** Add `legs` below whatever is already built. */
  function appendLegs(legs: readonly FlightLeg[]): void {
    for (const leg of legs) {
      const last = installed.at(-1);
      const startSeconds = endSecondsOf(installed.length - 1);
      const from = last === undefined ? origin.pose : last.leg.pose;
      const endSeconds = startSeconds + leg.seconds;

      // `fromTo` with both ends written out, so the leg means the same thing
      // whenever it is rendered. `immediateRender: false` because a `fromTo`
      // otherwise writes its start values the moment it is created, which for
      // an appended leg is a jump to the level above; `lazy: false` because a
      // lazy tween defers the write to the end of gsap's own tick, and the
      // tests read the rig on the line after they advance the clock.
      const tween = gsap.fromTo(rig, varsOf(from), {
        ...varsOf(leg.pose),
        duration: leg.seconds,
        ease: 'none',
        immediateRender: false,
        lazy: false,
      });
      timeline.add(tween, startSeconds);
      timeline.addLabel(leg.label, endSeconds);
      installed.push({ leg, tween });
    }
  }

  /** The index of `label` among `legs`, or `-1` for the origin. */
  function legIndexOf(label: string, legs: readonly FlightLeg[]): number {
    return label === origin.label ? -1 : legs.findIndex((leg) => leg.label === label);
  }

  function assertSameOrigin(stop: FlightStop): void {
    if (stop.label !== origin.label) {
      throw new FlightOriginMismatchError('label', origin.label, stop.label);
    }
    for (const field of RIG_FIELDS) {
      if (stop.pose[field] !== origin.pose[field]) {
        throw new FlightOriginMismatchError(
          field,
          origin.pose[field],
          stop.pose[field]
        );
      }
    }
  }

  function assertLegs(legs: readonly FlightLeg[]): void {
    const seen = new Set<string>([origin.label]);
    for (const leg of legs) {
      if (!Number.isFinite(leg.seconds) || leg.seconds <= 0) {
        throw new InvalidLegDurationError(leg.label, leg.seconds);
      }
      if (seen.has(leg.label)) {
        throw new RepeatedFlightLabelError(leg.label);
      }
      seen.add(leg.label);
    }
  }

  function assertLabelOnRoute(route: FlightRoute, label: string): void {
    if (label === route.origin.label) {
      return;
    }
    if (!route.legs.some((leg) => leg.label === label)) {
      throw new UnknownFlightLabelError(label, [
        route.origin.label,
        ...route.legs.map((leg) => leg.label),
      ]);
    }
  }
}

function sameLeg(one: FlightLeg, other: FlightLeg): boolean {
  return (
    one.label === other.label &&
    one.seconds === other.seconds &&
    posesEqual(one.pose, other.pose)
  );
}

/** A pose as gsap tween variables, built from the field list rather than named again. */
function varsOf(pose: CameraPose): Record<string, number> {
  const vars: Record<string, number> = {};
  for (const field of RIG_FIELDS) {
    vars[field] = pose[field];
  }
  return vars;
}
