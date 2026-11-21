import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookAddress } from '@core/address';
import { motionClockSeconds } from '@motion/clock';
import type * as FlightModule from '@motion/flight';
import type { Flight, FlightOptions, FlightRoute, FlightStop } from '@motion/flight';
import { createChoreography } from '@app/choreography';
import type { Choreography } from '@app/choreography';

/**
 * What the choreography asks of its flight, counted.
 *
 * The real flight, wrapped: every member is the real one, and the two that
 * matter here count their callers on the way through. `isSettled` allocates on
 * its way to an answer, so a frame at rest must not read it; `whenSettled` is
 * already resolved while a retreat waits for its swap, so a waiter must not
 * loop on it. Neither is visible from outside the choreography any other way.
 *
 * A file of its own because `vi.mock` is hoisted over the whole file, and the
 * rest of the choreography's tests run against the flight unwrapped.
 */

const probes = vi.hoisted(() => ({ isSettledReads: 0, whenSettledCalls: 0 }));

vi.mock('@motion/flight', async (importOriginal) => {
  const actual = await importOriginal<typeof FlightModule>();
  return {
    ...actual,
    createFlight: (origin: FlightStop, options: FlightOptions): Flight => {
      const real = actual.createFlight(origin, options);
      return {
        rig: real.rig,
        timeline: real.timeline,
        get targetLabel(): string {
          return real.targetLabel;
        },
        get isSettled(): boolean {
          probes.isSettledReads += 1;
          return real.isSettled;
        },
        flyTo: (route: FlightRoute, label: string): void => {
          real.flyTo(route, label);
        },
        whenSettled: (): Promise<void> => {
          probes.whenSettledCalls += 1;
          return real.whenSettled();
        },
        dispose: (): void => {
          real.dispose();
        },
      };
    },
  };
});

const ROOM = 0n;
const ELSEWHERE: BookAddress = { room: 37n, wall: 1, shelf: 2, volume: 3 };
const FRAME_SECONDS = 1 / 60;

/** Two seconds of frames, at rest. */
const RESTING_FRAMES = 120;

/** How many microtasks the spin test lets pass while the rooms disagree. */
const SPIN_MICROTASKS = 1000;

const built: Choreography[] = [];

beforeEach(() => {
  probes.isSettledReads = 0;
  probes.whenSettledCalls = 0;
});

afterEach(() => {
  for (const choreography of built.splice(0)) {
    choreography.dispose();
  }
});

/** A choreography over a screen that shows whatever it was last asked to. */
function onScreen(): Choreography {
  let shown = ROOM;
  const choreography = createChoreography(ROOM, {
    shownRoom: () => shown,
    showRoom: (room) => {
      shown = room;
    },
    prefersReducedMotion: () => false,
  });
  built.push(choreography);
  return choreography;
}

function tick(choreography: Choreography): void {
  choreography.frame(motionClockSeconds() + FRAME_SECONDS);
}

describe('the choreography’s use of its flight', () => {
  it('the frame check does not ask the flight whether it is settled while the rooms agree', () => {
    const choreography = onScreen();

    for (let frame = 0; frame < RESTING_FRAMES; frame += 1) {
      tick(choreography);
    }

    expect(probes.isSettledReads).toBe(0);
  });

  it('whenIdle does not wait on the flight while the rooms disagree', async () => {
    const choreography = onScreen();
    choreography.openVolume(ELSEWHERE);
    const waiting = choreography.whenIdle();

    for (let turn = 0; turn < SPIN_MICROTASKS; turn += 1) {
      await Promise.resolve();
    }
    const callsWhileDisagreeing = probes.whenSettledCalls;
    // The frame's swap is what stops a waiter spinning on the settled flight,
    // so it runs before the assertion: failing first would hang the run.
    tick(choreography);

    expect(callsWhileDisagreeing).toBe(0);
    choreography.dispose();
    await waiting;
  });
});
