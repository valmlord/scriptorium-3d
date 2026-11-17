import { gsap } from 'gsap';
import { NonMonotonicClockError } from './errors';

/**
 * The one clock.
 *
 * `docs/architecture.md` §2 allows exactly one `setAnimationLoop` and no
 * `requestAnimationFrame` anywhere else. gsap's own ticker is a second
 * `requestAnimationFrame` loop, started on import in a browser, so this module
 * takes the clock away from it: `gsap.ticker.remove(gsap.updateRoot)` leaves
 * the ticker with no listeners at all (`gsap-core.js` registers exactly one,
 * `Timeline.updateRoot`), and `gsap.updateRoot(seconds)` then advances every
 * tween from the render loop instead.
 *
 * The ticker is also put to sleep, and put back to sleep on every advance.
 * That is not belt and braces: creating any animation calls `_ticker.wake()`
 * inside gsap, which restarts its loop, and a woken ticker with no listeners
 * is a `requestAnimationFrame` loop that reschedules itself forever and does
 * nothing. Sleeping on each advance is one `cancelAnimationFrame` per frame
 * and leaves the project with the one loop its architecture claims.
 *
 * The same two calls are what make the timeline tests deterministic: a test
 * advances this clock by an exact number of seconds and the rig is written
 * synchronously (`docs/testing.md` §1). No test waits on a wall-clock
 * duration, because no wall clock is involved.
 */

/**
 * Where the root timeline is, in seconds. gsap's root time is absolute and
 * monotonic, so this is kept here rather than read back from gsap: the render
 * loop reports a timestamp and the tests advance by a delta, and both have to
 * agree about the same number.
 */
let rootSeconds = 0;

let clockTaken = false;

/** Take the clock from gsap's ticker, and silence the ticker. Idempotent. */
export function takeOverGsapClock(): void {
  if (clockTaken) {
    return;
  }
  gsap.ticker.remove(gsap.updateRoot);
  gsap.ticker.sleep();
  clockTaken = true;
}

/** Where the clock is now, in seconds. */
export function motionClockSeconds(): number {
  return rootSeconds;
}

/**
 * Advance the clock to `seconds` and render every animation at that time.
 *
 * Refuses to go backwards. A root time that moves back makes gsap render its
 * tweens in reverse, so a timestamp that went backwards would play a flight
 * the other way rather than reporting a fault, and the one caller in the
 * application is `setAnimationLoop`, whose timestamp is monotonic by
 * specification.
 */
export function advanceMotionClockTo(seconds: number): void {
  if (seconds < rootSeconds) {
    throw new NonMonotonicClockError(rootSeconds, seconds);
  }
  takeOverGsapClock();
  rootSeconds = seconds;
  gsap.updateRoot(seconds);
  // Any animation created since the last advance has woken gsap's ticker.
  gsap.ticker.sleep();
}

/** Advance the clock by `seconds`, which is how the tests drive it. */
export function advanceMotionClockBy(seconds: number): void {
  advanceMotionClockTo(rootSeconds + seconds);
}
