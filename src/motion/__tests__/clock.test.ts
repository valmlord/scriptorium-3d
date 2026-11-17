import { afterEach, describe, expect, it, vi } from 'vitest';
import { gsap } from 'gsap';
import {
  advanceMotionClockBy,
  advanceMotionClockTo,
  motionClockSeconds,
  takeOverGsapClock,
} from '@motion/clock';
import { NonMonotonicClockError } from '@motion/errors';

/**
 * `docs/architecture.md` §2 allows one animation loop. gsap's ticker is a
 * second one, so the clock module takes gsap's root timeline off it — and that
 * claim is asserted by ticking gsap's own ticker and watching nothing move,
 * rather than by reading the line that removes the listener.
 *
 * Everything here advances an explicit number of seconds. No test in this
 * layer waits on a wall-clock duration (`docs/testing.md` §1), which is also
 * why these assertions can be exact instead of approximate.
 */

/** A tween target with one field, so a tick either moved it or did not. */
function linearTween(): {
  target: { value: number };
  tween: ReturnType<typeof gsap.to>;
} {
  const target = { value: 0 };
  const tween = gsap.to(target, {
    value: 1,
    duration: 1,
    ease: 'none',
    lazy: false,
  });
  return { target, tween };
}

const created: ReturnType<typeof gsap.to>[] = [];

afterEach(() => {
  for (const tween of created.splice(0)) {
    tween.kill();
  }
  vi.restoreAllMocks();
});

describe('the clock gsap animates on', () => {
  it('is not gsap’s own ticker: a tick of it moves nothing', () => {
    takeOverGsapClock();
    const { target, tween } = linearTween();
    created.push(tween);

    // gsap's ticker is what would normally render every animation. It has no
    // listeners left, so its own tick is now a no-op.
    gsap.ticker.tick();

    expect(target.value).toBe(0);
  });

  it('is this module: advancing it renders the animation', () => {
    const { target, tween } = linearTween();
    created.push(tween);
    const start = motionClockSeconds();

    advanceMotionClockBy(0.25);

    expect(motionClockSeconds()).toBeCloseTo(start + 0.25, 12);
    expect(target.value).toBeCloseTo(0.25, 10);
  });

  it('cancels the frame gsap schedules for itself when an animation is created', () => {
    // In Node gsap falls back to setTimeout, so the frame it schedules for
    // itself is a timer and cancelling it is a clearTimeout. In a browser the
    // same two lines of gsap are requestAnimationFrame and
    // cancelAnimationFrame. Creating an animation wakes its ticker, which is
    // why the cancellation belongs on every advance and not only at startup.
    const scheduled = vi.spyOn(globalThis, 'setTimeout');
    const cancelled = vi.spyOn(globalThis, 'clearTimeout');

    const { tween } = linearTween();
    created.push(tween);

    expect(scheduled).toHaveBeenCalled();
    const handle = scheduled.mock.results.at(-1)?.value;

    advanceMotionClockBy(0);

    expect(cancelled).toHaveBeenCalledWith(handle);
  });
});

describe('the clock’s direction', () => {
  it('refuses to go backwards, naming both times', () => {
    const now = motionClockSeconds();

    expect(() => {
      advanceMotionClockTo(now - 1);
    }).toThrow(NonMonotonicClockError);
    expect(() => {
      advanceMotionClockTo(now - 1);
    }).toThrow(/cannot go backwards/);
  });

  it('allows the same instant twice, which two frames in one millisecond are', () => {
    const now = motionClockSeconds();

    advanceMotionClockTo(now);

    expect(motionClockSeconds()).toBe(now);
  });
});
