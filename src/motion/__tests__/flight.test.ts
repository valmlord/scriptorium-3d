import { afterEach, describe, expect, it } from 'vitest';
import { advanceMotionClockBy } from '@motion/clock';
import {
  FlightOriginMismatchError,
  InvalidLegDurationError,
  RepeatedFlightLabelError,
  UnknownFlightLabelError,
} from '@motion/errors';
import { createFlight } from '@motion/flight';
import type { Flight, FlightRoute, FlightStop } from '@motion/flight';
import { RIG_FIELDS, snapshotOf } from '@motion/rig';
import type { CameraPose, CameraRig } from '@motion/rig';

/**
 * The master timeline, advanced by an explicit number of seconds and never by
 * waiting (`docs/testing.md` §1). Every assertion below is therefore exact
 * rather than approximate, and the only tolerance in the file is
 * floating-point epsilon.
 *
 * The poses are this file's own round numbers rather than the room's real
 * geometry: `motion` animates numbers and must be testable without the engine
 * (ADR-0004), and a leg from `height: 1` to `height: 2` makes "half way along
 * the leg" a thing the reader can check in their head.
 *
 * **The ease is on the playhead, and the legs are linear.** That is what makes
 * these numbers land where they do: `power2.inOut` is symmetric, so half the
 * flight's duration is exactly half of its timeline, and half of a linear leg
 * is exactly half way between its two poses. A flight across three legs eased
 * once therefore passes the middle label at exactly half time, which is the
 * assertion that "one continuous flight" is not just a claim about how it
 * looks.
 */

const ROOM_POSE: CameraPose = {
  bearing: 0,
  radial: -1,
  height: 2,
  lateral: 0,
  pitch: -0.5,
  fov: 60,
};
const WALL_POSE: CameraPose = {
  bearing: 1,
  radial: 0,
  height: 1,
  lateral: 0,
  pitch: 0,
  fov: 58,
};
const SHELF_POSE: CameraPose = {
  bearing: 1,
  radial: 1,
  height: 1.5,
  lateral: 0,
  pitch: 0,
  fov: 54,
};
const BOOK_POSE: CameraPose = {
  bearing: 1,
  radial: 1.4,
  height: 1.6,
  lateral: 0.3,
  pitch: 0,
  fov: 50,
};

/** A shelf on another part of the wall: the same wall leg, a different shelf. */
const OTHER_SHELF_POSE: CameraPose = { ...SHELF_POSE, height: 0.9 };

const ORIGIN: FlightStop = { label: 'room', pose: ROOM_POSE };

/** Legs of 2, 1 and 1 seconds, so the labels land on 2, 3 and 4. */
const ROUTE: FlightRoute = {
  origin: ORIGIN,
  legs: [
    { label: 'wall', pose: WALL_POSE, seconds: 2 },
    { label: 'shelf', pose: SHELF_POSE, seconds: 1 },
    { label: 'book', pose: BOOK_POSE, seconds: 1 },
  ],
};

/** The same wall, another shelf, no book below it. */
const OTHER_ROUTE: FlightRoute = {
  origin: ORIGIN,
  legs: [
    { label: 'wall', pose: WALL_POSE, seconds: 2 },
    { label: 'shelf', pose: OTHER_SHELF_POSE, seconds: 1 },
  ],
};

/** Steps of a sixtieth of a second, as a frame would arrive. */
const FRAME_SECONDS = 1 / 60;

/** Enough frames for any flight in this file, and a cap rather than a wait. */
const MAX_FRAMES = 2000;

const flights: Flight[] = [];

afterEach(() => {
  for (const flight of flights.splice(0)) {
    flight.dispose();
  }
});

function flightFromRoom(): Flight {
  const flight = createFlight(ORIGIN);
  flights.push(flight);
  return flight;
}

/** Advance the clock frame by frame until the flight is settled. */
function flyOn(flight: Flight): number {
  let frames = 0;
  while (!flight.isSettled) {
    advanceMotionClockBy(FRAME_SECONDS);
    frames += 1;
    if (frames > MAX_FRAMES) {
      throw new Error(`the flight did not settle in ${String(MAX_FRAMES)} frames`);
    }
  }
  return frames;
}

/** The legs of a timeline are the same objects, which is retention rather than rebuilding. */
function expectSameLegs(
  flight: Flight,
  legs: ReturnType<Flight['timeline']['getChildren']>
): void {
  const current = flight.timeline.getChildren(false);

  expect(current).toHaveLength(legs.length);
  for (const [index, leg] of legs.entries()) {
    expect(current[index]).toBe(leg);
  }
}

function expectRigAt(rig: CameraRig, pose: CameraPose, precision = 9): void {
  for (const field of RIG_FIELDS) {
    expect(rig[field], `rig.${field}`).toBeCloseTo(pose[field], precision);
  }
}

/** The pose a fraction of the way along a linear leg between two poses. */
function between(one: CameraPose, other: CameraPose, fraction: number): CameraPose {
  const mix = (a: number, b: number): number => a + (b - a) * fraction;
  return {
    bearing: mix(one.bearing, other.bearing),
    radial: mix(one.radial, other.radial),
    height: mix(one.height, other.height),
    lateral: mix(one.lateral, other.lateral),
    pitch: mix(one.pitch, other.pitch),
    fov: mix(one.fov, other.fov),
  };
}

describe('a flight before it is asked for anything', () => {
  it('rests at its origin, settled, with the origin labelled at time zero', () => {
    const flight = flightFromRoom();

    expect(snapshotOf(flight.rig)).toEqual(ROOM_POSE);
    expect(flight.isSettled).toBe(true);
    expect(flight.targetLabel).toBe('room');
    expect(flight.timeline.labels).toEqual({ room: 0 });
  });
});

describe('the master timeline', () => {
  it('carries one label per level, where the legs add up to', () => {
    const flight = flightFromRoom();

    flight.flyTo(ROUTE, 'book');

    expect(flight.timeline.labels).toEqual({ room: 0, wall: 2, shelf: 3, book: 4 });
    expect(flight.timeline.duration()).toBeCloseTo(4, 12);
  });

  it('holds the rig values of each level at that level’s label', () => {
    const flight = flightFromRoom();
    flight.flyTo(ROUTE, 'book');

    for (const [label, pose] of [
      ['room', ROOM_POSE],
      ['wall', WALL_POSE],
      ['shelf', SHELF_POSE],
      ['book', BOOK_POSE],
    ] as const) {
      flight.timeline.seek(label);

      expectRigAt(flight.rig, pose);
    }
  });

  it('begins each leg where the route says, not where the rig happened to be', () => {
    const flight = flightFromRoom();
    flight.flyTo(ROUTE, 'book');

    // Something writes the rig between the route being built and the timeline
    // first rendering. A `to()` leg records its start values at that first
    // render and would bake this in, which is the whole reason the legs are
    // `fromTo`: what a leg means has to be the route's business and not the
    // rig's state at an arbitrary moment (ADR-0030).
    flight.rig.height = 99;
    flight.rig.bearing = -99;

    flight.timeline.seek('wall');
    expectRigAt(flight.rig, WALL_POSE);
    flight.timeline.seek('room');

    expectRigAt(flight.rig, ROOM_POSE);
  });

  it('is a function of the playhead alone, whatever order it is read in', () => {
    const flight = flightFromRoom();
    flight.flyTo(ROUTE, 'book');

    flight.timeline.seek('book');
    flight.timeline.seek(2.5);
    const forwards = snapshotOf(flight.rig);
    flight.timeline.seek('room');
    flight.timeline.seek(2.5);

    expect(snapshotOf(flight.rig)).toEqual(forwards);
    expectRigAt(flight.rig, between(WALL_POSE, SHELF_POSE, 0.5));
  });
});

describe('a flight down the ladder', () => {
  it('arrives at the level it was sent to', () => {
    const flight = flightFromRoom();

    flight.flyTo(ROUTE, 'shelf');
    flyOn(flight);

    expectRigAt(flight.rig, SHELF_POSE);
    expect(flight.timeline.time()).toBeCloseTo(3, 9);
  });

  it('crosses three levels as one movement, passing the middle at half time', () => {
    const flight = flightFromRoom();

    flight.flyTo(ROUTE, 'book');
    // Half of the four seconds the three legs add up to. The ease is on the
    // playhead and `power2.inOut` is symmetric, so half the time is half the
    // timeline: if each leg eased on its own, the playhead would be at a leg
    // boundary here only by coincidence.
    advanceMotionClockBy(2);

    expect(flight.timeline.time()).toBeCloseTo(2, 6);
    expectRigAt(flight.rig, WALL_POSE, 6);
    expect(flight.isSettled).toBe(false);
  });

  it('moves the rig half way along a leg at half of that leg', () => {
    const flight = flightFromRoom();

    flight.flyTo(ROUTE, 'wall');
    advanceMotionClockBy(1);

    expectRigAt(flight.rig, between(ROOM_POSE, WALL_POSE, 0.5), 6);
  });
});

describe('going back up the ladder', () => {
  it('returns the rig to the values it started from, within epsilon', () => {
    const flight = flightFromRoom();
    flight.flyTo(ROUTE, 'book');
    flyOn(flight);

    flight.flyTo(ROUTE, 'room');
    flyOn(flight);

    expectRigAt(flight.rig, ROOM_POSE);
    expect(flight.timeline.time()).toBeCloseTo(0, 9);
  });

  it('plays the same timeline backwards rather than building a second one', () => {
    const flight = flightFromRoom();
    flight.flyTo(ROUTE, 'book');
    flyOn(flight);
    const legs = flight.timeline.getChildren(false);

    flight.flyTo(ROUTE, 'wall');
    flyOn(flight);

    expectSameLegs(flight, legs);
    expectRigAt(flight.rig, WALL_POSE);
  });
});

describe('a flight interrupted halfway', () => {
  it('reverses the leg it is on without rebuilding it', () => {
    const flight = flightFromRoom();
    flight.flyTo(ROUTE, 'wall');
    advanceMotionClockBy(1);
    const legs = flight.timeline.getChildren(false);
    const halfway = snapshotOf(flight.rig);

    flight.flyTo(ROUTE, 'room');

    // Same tween objects: ADR-0004's retained timeline, not a new animation
    // built from wherever the camera happened to be.
    expectSameLegs(flight, legs);
    expect(snapshotOf(flight.rig)).toEqual(halfway);

    flyOn(flight);

    expectRigAt(flight.rig, ROOM_POSE);
  });

  it('leaves the rig on the timeline at every frame of the interruption', () => {
    const flight = flightFromRoom();
    flight.flyTo(ROUTE, 'book');
    advanceMotionClockBy(1.5);
    flight.flyTo(ROUTE, 'wall');

    // The rig is whatever the timeline says at the playhead, frame by frame,
    // which is the consistency an interruption has to leave behind: there is
    // no state in which the camera is somewhere the flight cannot name.
    for (let frame = 0; frame < 120 && !flight.isSettled; frame += 1) {
      advanceMotionClockBy(FRAME_SECONDS);
      const time = flight.timeline.time();
      const expected =
        time <= 2
          ? between(ROOM_POSE, WALL_POSE, time / 2)
          : between(WALL_POSE, SHELF_POSE, time - 2);

      expectRigAt(flight.rig, expected, 5);
    }

    expect(flight.isSettled).toBe(true);
    expectRigAt(flight.rig, WALL_POSE);
  });

  it('keeps flying when it is sent further down mid-flight', () => {
    const flight = flightFromRoom();
    flight.flyTo(ROUTE, 'wall');
    advanceMotionClockBy(1);

    flight.flyTo(ROUTE, 'book');
    flyOn(flight);

    expectRigAt(flight.rig, BOOK_POSE);
    expect(flight.timeline.labels).toEqual({ room: 0, wall: 2, shelf: 3, book: 4 });
  });

  it('does not restart the ease when sent again where it is already going', () => {
    const steady = flightFromRoom();
    steady.flyTo(ROUTE, 'book');
    advanceMotionClockBy(1);
    advanceMotionClockBy(1);
    const undisturbed = snapshotOf(steady.rig);

    const asked = flightFromRoom();
    asked.flyTo(ROUTE, 'book');
    advanceMotionClockBy(1);
    asked.flyTo(ROUTE, 'book');
    advanceMotionClockBy(1);

    expect(snapshotOf(asked.rig)).toEqual(undisturbed);
  });
});

describe('a route that disagrees with the one already built', () => {
  it('retreats to the last level the two share before rebuilding below it', () => {
    const flight = flightFromRoom();
    flight.flyTo(ROUTE, 'book');
    flyOn(flight);
    const wallLeg = flight.timeline.getChildren(false)[0];

    flight.flyTo(OTHER_ROUTE, 'shelf');

    // Still at the book, and already on its way back up: the shelf below the
    // wall is the part that disagrees, so the playhead has to leave it before
    // it can be replaced.
    expect(flight.isSettled).toBe(false);
    expectRigAt(flight.rig, BOOK_POSE);

    flyOn(flight);

    expectRigAt(flight.rig, OTHER_SHELF_POSE);
    // The wall leg was never touched; only what hung below it was.
    expect(flight.timeline.getChildren(false)[0]).toBe(wallLeg);
    expect(flight.timeline.labels).toEqual({ room: 0, wall: 2, shelf: 3 });
  });

  it('passes through the shared level rather than cutting to the new one', () => {
    const flight = flightFromRoom();
    flight.flyTo(ROUTE, 'book');
    flyOn(flight);

    flight.flyTo(OTHER_ROUTE, 'shelf');
    let reachedTheWall = false;
    for (let frame = 0; frame < MAX_FRAMES && !flight.isSettled; frame += 1) {
      advanceMotionClockBy(FRAME_SECONDS);
      if (Math.abs(flight.timeline.time() - 2) < FRAME_SECONDS) {
        reachedTheWall = true;
      }
    }

    expect(reachedTheWall).toBe(true);
    expectRigAt(flight.rig, OTHER_SHELF_POSE);
  });

  it('is not settled at a label whose level is no longer the one asked for', () => {
    const flight = flightFromRoom();
    flight.flyTo(ROUTE, 'shelf');
    flyOn(flight);

    // The playhead is exactly at the `shelf` label, and the new route's shelf
    // is somewhere else. A flight that reported "arrived" on the label alone
    // would be a debug hook that lies.
    flight.flyTo(OTHER_ROUTE, 'shelf');

    expect(flight.timeline.time()).toBeCloseTo(3, 9);
    expect(flight.isSettled).toBe(false);

    flyOn(flight);

    expectRigAt(flight.rig, OTHER_SHELF_POSE);
  });

  it('replays a retained leg rather than rebuilding it when nothing changed', () => {
    const flight = flightFromRoom();
    flight.flyTo(ROUTE, 'wall');
    flyOn(flight);
    const legs = flight.timeline.getChildren(false);

    flight.flyTo(ROUTE, 'room');
    flyOn(flight);
    flight.flyTo(ROUTE, 'wall');
    flyOn(flight);

    expectSameLegs(flight, legs);
    expectRigAt(flight.rig, WALL_POSE);
  });
});

describe('waiting for a flight to settle', () => {
  it('resolves at once when nothing is moving', async () => {
    const flight = flightFromRoom();

    await expect(flight.whenSettled()).resolves.toBeUndefined();
  });

  it('resolves when the rig arrives, and not before', async () => {
    const flight = flightFromRoom();
    flight.flyTo(ROUTE, 'book');
    let settled = false;
    const waiting = flight.whenSettled().then(() => {
      settled = true;
    });

    advanceMotionClockBy(1);
    await Promise.resolve();
    expect(settled).toBe(false);

    flyOn(flight);
    await waiting;

    expect(settled).toBe(true);
    expectRigAt(flight.rig, BOOK_POSE);
  });

  it('resolves on dispose, because nothing will move the rig again', async () => {
    const flight = flightFromRoom();
    flight.flyTo(ROUTE, 'book');
    const waiting = flight.whenSettled();

    flight.dispose();

    await expect(waiting).resolves.toBeUndefined();
  });
});

describe('a disposed flight', () => {
  it('is not moved by the clock any more', () => {
    const flight = flightFromRoom();
    flight.flyTo(ROUTE, 'book');
    advanceMotionClockBy(1);
    const stopped = snapshotOf(flight.rig);

    flight.dispose();
    advanceMotionClockBy(1);

    expect(snapshotOf(flight.rig)).toEqual(stopped);
  });
});

describe('a route a flight cannot accept', () => {
  it('refuses a destination that is not on it, naming the stops that are', () => {
    const flight = flightFromRoom();

    expect(() => {
      flight.flyTo(ROUTE, 'cellar');
    }).toThrow(UnknownFlightLabelError);
    expect(() => {
      flight.flyTo(ROUTE, 'cellar');
    }).toThrow(/no stop named "cellar".*"room", "wall", "shelf", "book"/);
  });

  it('refuses an origin labelled something else', () => {
    const flight = flightFromRoom();
    const route: FlightRoute = {
      ...ROUTE,
      origin: { label: 'entrance', pose: ROOM_POSE },
    };

    expect(() => {
      flight.flyTo(route, 'wall');
    }).toThrow(FlightOriginMismatchError);
  });

  it('refuses an origin whose pose differs, naming the field', () => {
    const flight = flightFromRoom();
    const route: FlightRoute = {
      ...ROUTE,
      origin: { label: 'room', pose: { ...ROOM_POSE, height: 1.9 } },
    };

    expect(() => {
      flight.flyTo(route, 'wall');
    }).toThrow(FlightOriginMismatchError);
    expect(() => {
      flight.flyTo(route, 'wall');
    }).toThrow(/height 1.9 where the flight's has 2/);
  });

  it('refuses a leg that takes no time', () => {
    const flight = flightFromRoom();
    const route: FlightRoute = {
      origin: ORIGIN,
      legs: [{ label: 'wall', pose: WALL_POSE, seconds: 0 }],
    };

    expect(() => {
      flight.flyTo(route, 'wall');
    }).toThrow(InvalidLegDurationError);
  });

  it('refuses a leg whose duration is not a number', () => {
    const flight = flightFromRoom();
    const route: FlightRoute = {
      origin: ORIGIN,
      legs: [{ label: 'wall', pose: WALL_POSE, seconds: Number.NaN }],
    };

    expect(() => {
      flight.flyTo(route, 'wall');
    }).toThrow(InvalidLegDurationError);
  });

  it('refuses two stops that share a label', () => {
    const flight = flightFromRoom();
    const route: FlightRoute = {
      origin: ORIGIN,
      legs: [
        { label: 'wall', pose: WALL_POSE, seconds: 1 },
        { label: 'wall', pose: SHELF_POSE, seconds: 1 },
      ],
    };

    expect(() => {
      flight.flyTo(route, 'wall');
    }).toThrow(RepeatedFlightLabelError);
  });

  it('refuses a leg labelled like the origin', () => {
    const flight = flightFromRoom();
    const route: FlightRoute = {
      origin: ORIGIN,
      legs: [{ label: 'room', pose: WALL_POSE, seconds: 1 }],
    };

    expect(() => {
      flight.flyTo(route, 'room');
    }).toThrow(RepeatedFlightLabelError);
  });
});
