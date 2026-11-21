import { describe, expect, it } from 'vitest';
import { ROOM_POSE, bookPose } from '@engine/poses';
import { motionClockSeconds } from '@motion/clock';
import { createChoreography } from '@app/choreography';
import type { Choreography } from '@app/choreography';
import { installDebugHook } from '@app/debug';
import type { DebugHookTarget, MemorySnapshot } from '@app/debug';
import { FrameTimingsUnavailableError } from '@app/errors';

/**
 * The hook of `docs/testing.md` §7, asserted against the real choreography
 * rather than against stubs: what an end-to-end test will ask is "where is the
 * application", and the answer has to come from the thing that knows.
 *
 * Installed on a plain object here, which is the whole reason
 * `installDebugHook` takes a target: `window` is one of these and so is `{}`,
 * and the hook is testable without a DOM.
 */

const ROOM = 0n;
const TARGET = { room: ROOM, wall: 2, shelf: 1, volume: 30 };
const FRAME_SECONDS = 1 / 60;
const MAX_FRAMES = 2000;

function installedHook(memory: () => MemorySnapshot = idleMemory): {
  target: DebugHookTarget;
  choreography: Choreography;
} {
  // A screen that shows whatever it was last asked to, standing in for the
  // viewer; nothing here changes rooms, so it only ever shows `ROOM`.
  let shown = ROOM;
  const choreography = createChoreography(ROOM, {
    shownRoom: () => shown,
    showRoom: (room) => {
      shown = room;
    },
    prefersReducedMotion: () => false,
  });
  const target: DebugHookTarget = {};
  installDebugHook(target, {
    state: () => choreography.state,
    address: () => choreography.address,
    rig: () => choreography.rig(),
    memory,
    waitForIdle: () => choreography.whenIdle(),
  });
  return { target, choreography };
}

/** A device holding nothing, for the tests that do not ask about memory. */
function idleMemory(): MemorySnapshot {
  return { geometries: 0, textures: 0, programs: 0, isRetiring: false };
}

function flyOn(choreography: Choreography): void {
  let frames = 0;
  while (!choreography.isIdle()) {
    choreography.frame(motionClockSeconds() + FRAME_SECONDS);
    frames += 1;
    if (frames > MAX_FRAMES) {
      throw new Error('the camera did not arrive');
    }
  }
}

describe('the debug hook', () => {
  it('answers where the user is and where the camera is', () => {
    const { target, choreography } = installedHook();
    const hook = target.__scriptorium;

    expect(hook).toBeDefined();
    expect(hook?.state()).toEqual({ level: 'room', room: ROOM });
    expect(hook?.address()).toBeNull();
    expect(hook?.rig().bearing).toBeCloseTo(ROOM_POSE.bearing, 12);

    choreography.openVolume(TARGET);
    flyOn(choreography);

    expect(hook?.state()).toEqual({ level: 'book', ...TARGET, page: 0 });
    expect(hook?.address()).toEqual({ ...TARGET, page: 0 });
    expect(hook?.rig().radial).toBeCloseTo(
      bookPose(TARGET.wall, TARGET.shelf, TARGET.volume).radial,
      6
    );
    choreography.dispose();
  });

  it('reports a copy of the rig, so a reader cannot move the camera', () => {
    const { target, choreography } = installedHook();
    const hook = target.__scriptorium;

    const first = hook?.rig();
    const second = hook?.rig();

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    choreography.dispose();
  });

  it('reads memory from its probe on every call, not once at install', () => {
    // A device that releases a room between the two reads, as the retirement
    // policy does after a render: an end-to-end test reads this every frame.
    const snapshots: readonly MemorySnapshot[] = [
      { geometries: 10, textures: 4, programs: 6, isRetiring: true },
      { geometries: 5, textures: 2, programs: 6, isRetiring: false },
    ];
    let reads = 0;
    const { target, choreography } = installedHook(() => {
      const snapshot = snapshots[Math.min(reads, snapshots.length - 1)] ?? idleMemory();
      reads += 1;
      return snapshot;
    });
    const hook = target.__scriptorium;

    const first = hook?.memory();
    const second = hook?.memory();

    expect(first).toEqual(snapshots[0]);
    expect(second).toEqual(snapshots[1]);
    choreography.dispose();
  });

  it('refuses to report frame timings rather than reporting zeros', () => {
    const { target, choreography } = installedHook();
    const hook = target.__scriptorium;

    expect(() => {
      hook?.frames();
    }).toThrow(FrameTimingsUnavailableError);
    expect(() => {
      hook?.frames();
    }).toThrow(/M10/);
    choreography.dispose();
  });

  it('waits for the camera and not for a duration', async () => {
    const { target, choreography } = installedHook();
    const hook = target.__scriptorium;
    choreography.openVolume(TARGET);
    let arrived = false;
    const waiting = hook?.waitForIdle().then(() => {
      arrived = true;
    });

    choreography.frame(motionClockSeconds() + FRAME_SECONDS);
    await Promise.resolve();
    expect(arrived).toBe(false);

    flyOn(choreography);
    await waiting;

    expect(arrived).toBe(true);
    choreography.dispose();
  });

  it('is absent from a target it was not installed on', () => {
    const target: DebugHookTarget = {};

    expect(target.__scriptorium).toBeUndefined();
  });
});
