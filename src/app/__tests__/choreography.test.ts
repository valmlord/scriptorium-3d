import { afterEach, describe, expect, it } from 'vitest';
import type { BookAddress } from '@core/address';
import { ROOM_POSE, bookPose, flightRouteTo, shelfPose, wallPose } from '@engine/poses';
import { motionClockSeconds } from '@motion/clock';
import { RIG_FIELDS } from '@motion/rig';
import type { CameraPose, CameraRigSnapshot } from '@motion/rig';
import type { NavigationState } from '@state/navigation';
import { createChoreography } from '@app/choreography';
import type { Choreography } from '@app/choreography';
import { whenAllIdle } from '@app/idle';

/**
 * M5's behaviour end to end, with no WebGL context and no DOM: the navigation
 * machine, the poses and the flight, joined exactly as `src/main.ts` joins
 * them. The review gate of the milestone is the interruption suite at the
 * bottom, and what it asserts is the rule of ADR-0030 — when the camera has
 * stopped, it is standing at the pose of the level the machine says the user
 * is at, whatever happened on the way there.
 *
 * Frames are handed to `frame()` as explicit timestamps, a sixtieth of a
 * second apart, so nothing here waits for anything.
 *
 * The viewer is stood in for by a screen that shows whatever it was last asked
 * to show, which is the whole of what the choreography may assume of it.
 */

const ROOM = 0n;
const OTHER_ROOM = 37n;
const TARGET: BookAddress = { room: ROOM, wall: 1, shelf: 2, volume: 3 };

/** The same wall, shelf and volume in another room. */
const ELSEWHERE: BookAddress = { ...TARGET, room: OTHER_ROOM };

/** A sixtieth of a second, as a frame would arrive. */
const FRAME_SECONDS = 1 / 60;

/** Enough frames for any flight in this file, and a cap rather than a wait. */
const MAX_FRAMES = 2000;

/**
 * The frames a descent from the room level is given to settle in the waiting
 * tests: a cap, not a wait. It takes 187 from the room level.
 */
const MAX_DESCENT_FRAMES = 600;

/**
 * How many microtasks the spin tests let pass while the rooms disagree. A
 * waiter looping over a resolved promise reads the room on screen once per
 * turn, so it shows up here as about a thousand reads.
 */
const SPIN_MICROTASKS = 1000;

const built: Choreography[] = [];

afterEach(() => {
  for (const choreography of built.splice(0)) {
    choreography.dispose();
  }
});

/** A choreography, and what it asked of the screen standing in for the viewer. */
interface OnScreen {
  readonly choreography: Choreography;
  /** Every room `showRoom` was called with, in order. */
  readonly swaps: readonly bigint[];
  /** The rig at the moment of each swap. */
  readonly rigsAtSwaps: readonly CameraRigSnapshot[];
  /** How many times the room on screen has been read. */
  readonly shownRoomReads: () => number;
}

/**
 * `prefersReducedMotion` is the test's own getter, so a test can change its
 * answer between two events; by default every flight is flown.
 */
function onScreen(prefersReducedMotion: () => boolean = () => false): OnScreen {
  let shown = ROOM;
  let reads = 0;
  const swaps: bigint[] = [];
  const rigsAtSwaps: CameraRigSnapshot[] = [];
  const choreography = createChoreography(ROOM, {
    shownRoom: () => {
      reads += 1;
      return shown;
    },
    showRoom: (room) => {
      swaps.push(room);
      rigsAtSwaps.push(choreography.rig());
      shown = room;
    },
    prefersReducedMotion,
  });
  built.push(choreography);
  return { choreography, swaps, rigsAtSwaps, shownRoomReads: () => reads };
}

function choreographyInRoom(): Choreography {
  return onScreen().choreography;
}

/** One frame, at the next timestamp the render loop would report. */
function tick(choreography: Choreography): void {
  choreography.frame(motionClockSeconds() + FRAME_SECONDS);
}

/** Frames until the camera has arrived, collecting the rig of each one. */
function flyOn(choreography: Choreography): readonly CameraRigSnapshot[] {
  const samples: CameraRigSnapshot[] = [];
  while (!choreography.isIdle()) {
    tick(choreography);
    samples.push(choreography.rig());
    if (samples.length > MAX_FRAMES) {
      throw new Error(`the camera did not arrive in ${String(MAX_FRAMES)} frames`);
    }
  }
  return samples;
}

/** The pose the camera belongs at when the machine is at `state`. */
function poseOf(state: NavigationState): CameraPose {
  const route = flightRouteTo(state);
  return route.legs.at(-1)?.pose ?? route.origin.pose;
}

/** The largest difference between a rig and a pose, over all six fields. */
function distanceToPose(rig: CameraRigSnapshot, pose: CameraPose): number {
  return Math.max(...RIG_FIELDS.map((field) => Math.abs(rig[field] - pose[field])));
}

/** Whether a series only ever moves one way, which is what "through" means. */
function isNonDecreasing(values: readonly number[]): boolean {
  return values.every(
    (value, index) => index === 0 || value >= (values[index - 1] ?? value)
  );
}

function expectRigAt(rig: CameraRigSnapshot | undefined, pose: CameraPose): void {
  expect(rig).toBeDefined();
  for (const field of RIG_FIELDS) {
    expect(rig?.[field], `rig.${field}`).toBeCloseTo(pose[field], 6);
  }
}

/** Frames until the camera has arrived, capped at a descent's worth. */
function settleDescent(choreography: Choreography): void {
  for (
    let frame = 0;
    frame < MAX_DESCENT_FRAMES && !choreography.isIdle();
    frame += 1
  ) {
    tick(choreography);
  }
}

async function flushMicrotasks(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await Promise.resolve();
  }
}

/**
 * Whether `promise` has resolved, after draining the microtask queue. Five
 * turns, as in `idle.test.ts`, so a waiter released a turn or two late does not
 * read as one never released.
 */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await flushMicrotasks(5);
  return settled;
}

describe('a choreography in a room', () => {
  it('opens at the room’s vantage with nothing in flight', () => {
    const choreography = choreographyInRoom();

    expect(choreography.state).toEqual({ level: 'room', room: ROOM });
    expect(choreography.address).toBeNull();
    expect(choreography.isIdle()).toBe(true);
    expectRigAt(choreography.rig(), ROOM_POSE);
  });

  it('hands the render loop the same rig object every frame', () => {
    const choreography = choreographyInRoom();

    const first = choreography.frame(motionClockSeconds() + FRAME_SECONDS);
    const second = choreography.frame(motionClockSeconds() + FRAME_SECONDS);

    // The loop reads this object 60 times a second; a copy per frame would be
    // the allocation `docs/architecture.md` §2 forbids there.
    expect(second).toBe(first);
  });

  it('reports a copy of the rig to anything that asks for one', () => {
    const choreography = choreographyInRoom();

    const snapshot = choreography.rig();
    choreography.openVolume(TARGET);
    flyOn(choreography);

    expectRigAt(snapshot, ROOM_POSE);
    expect(choreography.rig()).not.toBe(snapshot);
  });
});

describe('choosing a volume', () => {
  it('commits where the user is before the camera has gone anywhere', () => {
    const choreography = choreographyInRoom();

    choreography.openVolume(TARGET);

    // ADR-0030: the machine is the source of truth and the camera is a
    // projection that lags. A URL written now names the book the reader chose.
    expect(choreography.state).toEqual({ level: 'book', ...TARGET, page: 0 });
    expect(choreography.address).toEqual({ ...TARGET, page: 0 });
    expect(choreography.isIdle()).toBe(false);
    expectRigAt(choreography.rig(), ROOM_POSE);
  });

  it('arrives in front of that volume', () => {
    const choreography = choreographyInRoom();

    choreography.openVolume(TARGET);
    const samples = flyOn(choreography);

    expect(samples.length).toBeGreaterThan(60);
    expectRigAt(choreography.rig(), bookPose(TARGET.wall, TARGET.shelf, TARGET.volume));
  });

  it('passes the wall and the shelf on the way, in that order', () => {
    const choreography = choreographyInRoom();

    choreography.openVolume(TARGET);
    const samples = flyOn(choreography);

    const nearestTo = (pose: CameraPose): number =>
      samples.findIndex((rig) => distanceToPose(rig, pose) < 0.03);

    const atWall = nearestTo(wallPose(TARGET.wall));
    const atShelf = nearestTo(shelfPose(TARGET.wall, TARGET.shelf));

    // One flight that goes through the levels rather than three that touch:
    // the camera is at the wall, then at the shelf, then at the book, and it
    // never stops in between.
    expect(atWall).toBeGreaterThan(0);
    expect(atShelf).toBeGreaterThan(atWall);
    // And it never backs up on the way: one flight through the levels rather
    // than three that touch.
    expect(isNonDecreasing(samples.map((rig) => rig.radial))).toBe(true);
  });
});

describe('changing rooms', () => {
  it('a cross-room flight swaps the room once, at a frame where the rig is the room pose', () => {
    const { choreography, swaps, rigsAtSwaps } = onScreen();
    choreography.openVolume(TARGET);
    flyOn(choreography);

    choreography.openVolume(ELSEWHERE);
    flyOn(choreography);

    // The room pose is the one both rooms share, so a swap there is the one
    // swap nobody sees.
    expect(swaps).toEqual([OTHER_ROOM]);
    expectRigAt(rigsAtSwaps[0], ROOM_POSE);
    expect(choreography.state).toEqual({ level: 'book', ...ELSEWHERE, page: 0 });
    expectRigAt(
      choreography.rig(),
      bookPose(ELSEWHERE.wall, ELSEWHERE.shelf, ELSEWHERE.volume)
    );
  });

  it('a search back to the shown room before the swap swaps nothing', () => {
    const { choreography, swaps } = onScreen();
    choreography.openVolume(TARGET);
    flyOn(choreography);
    choreography.openVolume(ELSEWHERE);
    for (let frame = 0; frame < 20; frame += 1) {
      tick(choreography);
    }
    expect(swaps).toEqual([]);
    const backHome: BookAddress = { ...TARGET, volume: 9 };

    choreography.openVolume(backHome);
    flyOn(choreography);

    expect(swaps).toEqual([]);
    expectRigAt(
      choreography.rig(),
      bookPose(backHome.wall, backHome.shelf, backHome.volume)
    );
  });

  it('the choreography is not idle while the machine’s room is not the room on screen', () => {
    const { choreography } = onScreen();

    // From the room level the retreat has nowhere to go, so the flight is
    // settled already and only the rooms say there is work left.
    choreography.openVolume(ELSEWHERE);

    expect(choreography.isIdle()).toBe(false);
  });

  it('the descent starts in the frame the retreat ended in', () => {
    const { choreography, swaps } = onScreen();
    choreography.openVolume(TARGET);
    flyOn(choreography);
    choreography.openVolume(ELSEWHERE);

    let frames = 0;
    while (swaps.length === 0) {
      tick(choreography);
      frames += 1;
      expect(frames).toBeLessThan(MAX_FRAMES);
    }
    const atSwap = choreography.rig();
    expectRigAt(atSwap, ROOM_POSE);
    // Already flying when the swap frame ends, rather than settled at the room
    // pose waiting for a later frame to start the descent.
    expect(choreography.isIdle()).toBe(false);

    tick(choreography);

    // The ease starts from rest, so the first frame moves the rig by about a
    // millionth: compared with the rig the swap frame left, not with the pose,
    // which the retreat reaches only to within that.
    expect(distanceToPose(choreography.rig(), atSwap)).toBeGreaterThan(0);
  });
});

describe('waiting across a change of room', () => {
  it('whenIdle does not spin while the rooms disagree', async () => {
    const { choreography, shownRoomReads } = onScreen();
    choreography.openVolume(ELSEWHERE);
    const waiting = choreography.whenIdle();

    await flushMicrotasks(SPIN_MICROTASKS);
    // Captured before the frame, which reads the room on screen itself.
    const readsWhileDisagreeing = shownRoomReads();
    // And the frame runs before anything is asserted: its swap is what stops
    // a spinning waiter, so an assertion failing first would leave the loop
    // spinning and the run hung rather than red.
    tick(choreography);

    expect(readsWhileDisagreeing).toBeLessThanOrEqual(5);
    settleDescent(choreography);
    expect(await hasSettled(waiting)).toBe(true);
  });

  it('whenIdle does not spin while the rooms disagree, and under a cut has resolved after the next frame', async () => {
    const { choreography, shownRoomReads } = onScreen(() => true);
    choreography.openVolume(ELSEWHERE);
    const waiting = choreography.whenIdle();

    await flushMicrotasks(SPIN_MICROTASKS);
    const readsWhileDisagreeing = shownRoomReads();
    // The frame first, for the reason above.
    tick(choreography);

    expect(readsWhileDisagreeing).toBeLessThanOrEqual(5);
    // The swap and the descent are both in that one frame: nothing is left to
    // fly, so no further frame is needed for the wait to end.
    expect(await hasSettled(waiting)).toBe(true);
  });

  it('whenIdle resolves when the rooms agree again without a swap', async () => {
    const { choreography, swaps } = onScreen();
    choreography.openVolume(ELSEWHERE);
    const waiting = choreography.whenIdle();
    expect(await hasSettled(waiting)).toBe(false);

    choreography.openVolume(TARGET);
    settleDescent(choreography);

    expect(await hasSettled(waiting)).toBe(true);
    expect(swaps).toEqual([]);
  });

  it('whenIdle resolves after dispose, with the rooms disagreeing', async () => {
    const { choreography } = onScreen();
    choreography.openVolume(ELSEWHERE);
    const waiting = choreography.whenIdle();
    expect(await hasSettled(waiting)).toBe(false);

    choreography.dispose();

    expect(await hasSettled(waiting)).toBe(true);
  });

  it('isIdle is true after dispose, and whenAllIdle over a disposed choreography resolves', async () => {
    const { choreography } = onScreen();
    choreography.openVolume(ELSEWHERE);
    expect(choreography.isIdle()).toBe(false);

    choreography.dispose();

    // Asked first, because `whenAllIdle` over a source that reports busy and
    // whose `whenIdle` has resolved spins rather than fails.
    expect(choreography.isIdle()).toBe(true);
    expect(await hasSettled(whenAllIdle([choreography]))).toBe(true);
  });

  it('frame swaps nothing after dispose', () => {
    const { choreography, swaps } = onScreen();
    choreography.openVolume(ELSEWHERE);

    choreography.dispose();
    for (let frame = 0; frame < 20; frame += 1) {
      tick(choreography);
    }

    expect(swaps).toEqual([]);
  });
});

describe('reduced motion', () => {
  it('prefersReducedMotion is read per flight', () => {
    let isReduced = false;
    const { choreography } = onScreen(() => isReduced);
    choreography.openVolume(TARGET);
    // Flown: the camera has not left the room yet.
    expect(choreography.isIdle()).toBe(false);
    flyOn(choreography);

    isReduced = true;
    choreography.back();

    // Cut: at the shelf in the same call, with no frame run.
    expect(choreography.isIdle()).toBe(true);
    expectRigAt(choreography.rig(), shelfPose(TARGET.wall, TARGET.shelf));
  });
});

describe('going back', () => {
  it('returns the camera to the room’s vantage, exactly', () => {
    const choreography = choreographyInRoom();
    choreography.openVolume(TARGET);
    flyOn(choreography);

    expect(choreography.back()).toBe(true);
    expect(choreography.back()).toBe(true);
    expect(choreography.back()).toBe(true);
    flyOn(choreography);

    expect(choreography.state).toEqual({ level: 'room', room: ROOM });
    expectRigAt(choreography.rig(), ROOM_POSE);
  });

  it('reports that there is nowhere to go from the room', () => {
    const choreography = choreographyInRoom();

    expect(choreography.back()).toBe(false);
    expect(choreography.state).toEqual({ level: 'room', room: ROOM });
    expect(choreography.isIdle()).toBe(true);
  });
});

describe('waiting for the camera', () => {
  it('resolves when it has arrived', async () => {
    const choreography = choreographyInRoom();
    choreography.openVolume(TARGET);
    let arrived = false;
    const waiting = choreography.whenIdle().then(() => {
      arrived = true;
    });

    tick(choreography);
    await Promise.resolve();
    expect(arrived).toBe(false);

    flyOn(choreography);
    await waiting;

    expect(arrived).toBe(true);
    expect(choreography.isIdle()).toBe(true);
  });
});

/**
 * The milestone's review gate. Each case interrupts a flight part of the way
 * through and then asserts the one invariant that matters: the machine and the
 * camera agree once the camera has stopped, and the camera stopped where the
 * machine says the user is.
 */
describe('a flight interrupted halfway', () => {
  const interruptions: readonly {
    readonly name: string;
    readonly frames: number;
    readonly interrupt: (choreography: Choreography) => void;
  }[] = [
    {
      name: 'one level back, while still descending',
      frames: 20,
      interrupt: (choreography) => {
        choreography.back();
      },
    },
    {
      name: 'two levels back, while still descending',
      frames: 40,
      interrupt: (choreography) => {
        choreography.back();
        choreography.back();
      },
    },
    {
      name: 'all the way back to the room',
      frames: 60,
      interrupt: (choreography) => {
        choreography.back();
        choreography.back();
        choreography.back();
      },
    },
    {
      name: 'another volume on the same shelf',
      frames: 30,
      interrupt: (choreography) => {
        choreography.openVolume({ ...TARGET, volume: 9 });
      },
    },
    {
      name: 'another shelf on the same wall',
      frames: 50,
      interrupt: (choreography) => {
        choreography.openVolume({ ...TARGET, shelf: 4, volume: 31 });
      },
    },
    {
      name: 'a volume on another wall entirely',
      frames: 70,
      interrupt: (choreography) => {
        choreography.openVolume({ room: ROOM, wall: 3, shelf: 0, volume: 0 });
      },
    },
    {
      name: 'the same volume again, which should change nothing',
      frames: 25,
      interrupt: (choreography) => {
        choreography.openVolume(TARGET);
      },
    },
  ];

  it.each(interruptions)(
    'leaves the machine and the camera agreeing: $name',
    ({ frames, interrupt }) => {
      const choreography = choreographyInRoom();
      choreography.openVolume(TARGET);
      for (let frame = 0; frame < frames; frame += 1) {
        tick(choreography);
      }

      interrupt(choreography);
      flyOn(choreography);

      expect(choreography.isIdle()).toBe(true);
      expectRigAt(choreography.rig(), poseOf(choreography.state));
    }
  );

  it('is not idle for a single frame of the interruption', () => {
    const choreography = choreographyInRoom();
    choreography.openVolume(TARGET);
    for (let frame = 0; frame < 20; frame += 1) {
      tick(choreography);
    }

    choreography.openVolume({ room: ROOM, wall: 3, shelf: 0, volume: 0 });

    // The camera has to cross the room, so an "arrived" at any point before it
    // has would be `waitForIdle` resolving on a camera still in motion — the
    // one way a debug hook can make every later end-to-end test lie.
    let framesFlown = 0;
    while (!choreography.isIdle()) {
      tick(choreography);
      framesFlown += 1;
      expect(framesFlown).toBeLessThan(MAX_FRAMES);
    }

    expect(framesFlown).toBeGreaterThan(60);
    expectRigAt(choreography.rig(), poseOf(choreography.state));
  });

  it('keeps the machine where the user put it, not where the camera is', () => {
    const choreography = choreographyInRoom();
    choreography.openVolume(TARGET);
    for (let frame = 0; frame < 20; frame += 1) {
      tick(choreography);
    }

    choreography.back();

    // Interrupted mid-descent and sent back: the machine is at the shelf from
    // the instant the event was accepted, while the camera is still somewhere
    // above the wall.
    expect(choreography.state.level).toBe('shelf');
    expect(
      distanceToPose(choreography.rig(), poseOf(choreography.state))
    ).toBeGreaterThan(0.01);

    flyOn(choreography);

    expect(choreography.state.level).toBe('shelf');
    expectRigAt(choreography.rig(), poseOf(choreography.state));
  });
});

describe('a disposed choreography', () => {
  it('stops listening to the machine and stops moving the camera', () => {
    const choreography = choreographyInRoom();
    choreography.openVolume(TARGET);
    for (let frame = 0; frame < 20; frame += 1) {
      tick(choreography);
    }
    const stopped = choreography.rig();

    choreography.dispose();
    choreography.navigation.dispatch({ type: 'back' });
    for (let frame = 0; frame < 20; frame += 1) {
      tick(choreography);
    }

    expectRigAt(choreography.rig(), stopped);
  });
});
