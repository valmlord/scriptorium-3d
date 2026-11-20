import { describe, expect, it } from 'vitest';
import { BOOKS_PER_SHELF, SHELVES_PER_WALL, WALLS_PER_ROOM } from '@core/address';
import { CAMERA_FOV } from '@engine/camera';
import {
  DOORWAY_SIDES,
  ROOM_CIRCUMRADIUS,
  ROOM_HEIGHT,
  ROOM_INRADIUS,
  ROOM_WALL_WIDTH,
  SHELF_BASE_HEIGHT,
  SHELF_PITCH,
  SHELF_SIDES,
  SPINE_DEPTH,
  SPINE_HEIGHT,
  SPINE_WALL_CLEARANCE,
} from '@engine/constants';
import {
  HEXAGON_SIDES,
  nearestBearing,
  shelfSurfaceHeight,
  sideBearing,
  volumeLateralOffset,
  wallBearing,
} from '@engine/layout';
import {
  ROOM_POSE,
  ROOM_STOP,
  bookPose,
  flightRouteTo,
  shelfPose,
  wallPose,
} from '@engine/poses';
import type { NavigationState } from '@state/navigation';

/**
 * The poses are the only place that knows both the room's dimensions and the
 * rig's fields, and they are pure arithmetic, so they are tested directly
 * (`docs/testing.md` §1). What is asserted here is what the comments in
 * `poses.ts` claim: that the camera frames what the level is about, that it
 * never ends up inside a book, and that a route is one leg per level with the
 * origin every route has to share.
 */

const ROOM = 0n;

/**
 * Navigation states as literals rather than through `@state`'s own
 * constructors: `engine` may import another layer's types and not its code
 * (`docs/architecture.md` §1), and what is being tested here is the pose a
 * state maps to, not how the state came about.
 */
const AT_ROOM: NavigationState = { level: 'room', room: ROOM };
const AT_WALL: NavigationState = { level: 'wall', room: ROOM, wall: 1 };
const AT_SHELF: NavigationState = { level: 'shelf', room: ROOM, wall: 1, shelf: 2 };
const AT_BOOK: NavigationState = {
  level: 'book',
  room: ROOM,
  wall: 1,
  shelf: 2,
  volume: 3,
  page: 0,
};

/** The face of a volume that looks into the room: the nearest thing to the camera. */
const SPINE_FACE_RADIAL = ROOM_INRADIUS - SPINE_WALL_CLEARANCE - SPINE_DEPTH;

/**
 * The widest frame the opening vantage is claimed to hold the doorways out
 * of. A `CAMERA_FOV` frame reaches sideways in proportion to the aspect
 * ratio, so the claim is only as good as the shape of the window it is made
 * about: 16:9 is the shape the screenshot in the README is taken at and the
 * widest a monitor is usually sold in.
 */
const WIDEST_FRAMED_ASPECT = 16 / 9;

/** Half the vertical angle of the frame, for a framing check. */
function halfFrameAngle(fov: number): number {
  return (fov / 2) * (Math.PI / 180);
}

/** A pose, as much of one as the framing helpers below need. */
type Framing = { radial: number; height: number; pitch: number; fov: number };

/**
 * What a pose can see, vertically, `distance` ahead of it. The pitch moves the
 * middle of the frame up or down; only the room's own vantage has any.
 */
function verticalReachAt(
  pose: Framing,
  distance: number
): { bottom: number; top: number } {
  const centre = pose.height + distance * Math.tan(pose.pitch);
  const half = distance * Math.tan(halfFrameAngle(pose.fov));
  return { bottom: centre - half, top: centre + half };
}

/** What a pose can see where the wall it faces square on stands. */
function verticalReachAtWall(pose: Framing): { bottom: number; top: number } {
  return verticalReachAt(pose, ROOM_INRADIUS - pose.radial);
}

/**
 * Half the horizontal angle of a frame: the vertical field widened by the
 * aspect ratio, which is how much of the room is either side of the axis.
 */
function halfHorizontalAngle(fov: number, aspect: number): number {
  return Math.atan(Math.tan(halfFrameAngle(fov)) * aspect);
}

/** Where the camera of `pose` stands, in the plan, as `[x, z]`. */
function groundPosition(pose: {
  bearing: number;
  radial: number;
}): readonly [number, number] {
  return [Math.cos(pose.bearing) * pose.radial, Math.sin(pose.bearing) * pose.radial];
}

/**
 * How far off the view axis a point on the floor lies, in radians, however far
 * away it is. A point behind the camera comes back past a right angle, which
 * is what makes this a usable test of "out of frame".
 */
function offAxisAngle(
  pose: { bearing: number; radial: number },
  point: readonly [number, number]
): number {
  const [cameraX, cameraZ] = groundPosition(pose);
  const x = point[0] - cameraX;
  const z = point[1] - cameraZ;
  const along = x * Math.cos(pose.bearing) + z * Math.sin(pose.bearing);
  const across = -x * Math.sin(pose.bearing) + z * Math.cos(pose.bearing);
  return Math.abs(Math.atan2(across, along));
}

/** The two corners of hexagon side `side`, in the plan. */
function sideCorners(side: number): readonly (readonly [number, number])[] {
  return [-1, 1].map((end) => {
    const bearing = sideBearing(side) + (end * Math.PI) / HEXAGON_SIDES;
    return [
      Math.cos(bearing) * ROOM_CIRCUMRADIUS,
      Math.sin(bearing) * ROOM_CIRCUMRADIUS,
    ] as const;
  });
}

const EVERY_VOLUME: readonly { wall: number; shelf: number; volume: number }[] =
  Array.from({ length: WALLS_PER_ROOM }, (_unused, wall) => wall).flatMap((wall) =>
    Array.from({ length: SHELVES_PER_WALL }, (_unused, shelf) => shelf).flatMap(
      (shelf) =>
        Array.from({ length: BOOKS_PER_SHELF }, (_unused, volume) => ({
          wall,
          shelf,
          volume,
        }))
    )
  );

describe('the room’s vantage', () => {
  it('faces the corner the first two shelved walls share, from the far side', () => {
    // Halfway between the two wall bearings, derived here rather than copied
    // from the module: a corner is the midpoint of the sides that meet at it.
    expect(ROOM_POSE.bearing).toBeCloseTo((wallBearing(0) + wallBearing(1)) / 2, 12);
    expect(ROOM_POSE.radial).toBeLessThan(0);
    expect(ROOM_POSE.pitch).toBeLessThan(0);
    expect(ROOM_POSE.fov).toBe(CAMERA_FOV);
    expect(ROOM_STOP.pose).toBe(ROOM_POSE);
    expect(ROOM_STOP.label).toBe('room');
  });

  it('sees that corner from the floor to the ceiling', () => {
    const reach = verticalReachAt(ROOM_POSE, ROOM_CIRCUMRADIUS - ROOM_POSE.radial);

    expect(reach.bottom).toBeLessThan(SHELF_BASE_HEIGHT);
    expect(reach.top).toBeGreaterThan(ROOM_HEIGHT);
  });

  it('holds both doorways out of the frame, which is what stops it opening on a hole', () => {
    // The whole of issue #46: through a doorway is the background colour and
    // not a corridor, so a doorway in the opening frame is a quarter of the
    // first impression spent on nothing. A doorway is out of frame when both
    // of its corners are further off the view axis than the frame reaches.
    const reach = halfHorizontalAngle(ROOM_POSE.fov, WIDEST_FRAMED_ASPECT);

    for (const side of DOORWAY_SIDES) {
      for (const corner of sideCorners(side)) {
        expect(offAxisAngle(ROOM_POSE, corner)).toBeGreaterThan(reach);
      }
    }
  });

  it('puts a shelved wall under each half of the frame', () => {
    // The other half of the claim: not merely no doorway, but books on both
    // sides. The corner itself is dead ahead, so each wall beside it covers
    // its own half out to an edge of the frame.
    const reach = halfHorizontalAngle(ROOM_POSE.fov, WIDEST_FRAMED_ASPECT);

    for (const side of SHELF_SIDES.slice(0, 2)) {
      const far = sideCorners(side).map((corner) => offAxisAngle(ROOM_POSE, corner));

      expect(Math.min(...far)).toBeLessThan(reach);
      expect(Math.max(...far)).toBeGreaterThan(reach);
    }
  });
});

describe('a wall pose', () => {
  it('turns to the wall the shorter way round', () => {
    for (let wall = 0; wall < WALLS_PER_ROOM; wall += 1) {
      const turn = wallPose(wall).bearing - ROOM_POSE.bearing;

      expect(Math.abs(turn)).toBeLessThanOrEqual(Math.PI);
      expect(wallPose(wall).bearing).toBe(
        nearestBearing(ROOM_POSE.bearing, wallBearing(wall))
      );
    }
  });

  it('faces the wall it names, whichever way it got there', () => {
    for (let wall = 0; wall < WALLS_PER_ROOM; wall += 1) {
      const facing = wallPose(wall).bearing;
      const turns = (facing - wallBearing(wall)) / (2 * Math.PI);

      expect(turns).toBeCloseTo(Math.round(turns), 12);
    }
  });

  it('frames every shelf of the wall and the volumes on them', () => {
    const reach = verticalReachAtWall(wallPose(0));
    const lowestBoard = SHELF_BASE_HEIGHT;
    const topOfTopVolumes = shelfSurfaceHeight(SHELVES_PER_WALL - 1) + SPINE_HEIGHT;

    expect(reach.bottom).toBeLessThan(lowestBoard);
    expect(reach.top).toBeGreaterThan(topOfTopVolumes);
  });

  it('is square on to the wall, centred on it, at the room’s field of view', () => {
    const pose = wallPose(2);

    expect(pose.pitch).toBe(0);
    expect(pose.lateral).toBe(0);
    expect(pose.fov).toBe(CAMERA_FOV);
  });
});

describe('a shelf pose', () => {
  it('stands level with the volumes on that shelf', () => {
    for (let shelf = 0; shelf < SHELVES_PER_WALL; shelf += 1) {
      expect(shelfPose(1, shelf).height).toBeCloseTo(
        shelfSurfaceHeight(shelf) + SPINE_HEIGHT / 2,
        12
      );
    }
  });

  it('closes in on the shelf but keeps its neighbours in view', () => {
    const reach = verticalReachAtWall(shelfPose(1, 2));
    const shelfBottom = shelfSurfaceHeight(2);
    const shelfTop = shelfBottom + SPINE_HEIGHT;

    expect(reach.bottom).toBeLessThan(shelfBottom);
    expect(reach.top).toBeGreaterThan(shelfTop);
    // And not so far back that the shelf above and the one below are both out
    // of the frame: the reader has to be able to see where on the wall it is.
    expect(reach.top - reach.bottom).toBeLessThan(2 * SHELF_PITCH + SPINE_HEIGHT);
    expect(shelfPose(1, 2).radial).toBeGreaterThan(wallPose(1).radial);
  });

  it('keeps the wall’s bearing: only the first leg of a flight turns', () => {
    expect(shelfPose(3, 4).bearing).toBe(wallPose(3).bearing);
    expect(bookPose(3, 4, 7).bearing).toBe(wallPose(3).bearing);
  });
});

describe('a book pose', () => {
  it('is centred on the volume it names', () => {
    for (let volume = 0; volume < BOOKS_PER_SHELF; volume += 1) {
      expect(bookPose(0, 0, volume).lateral).toBe(volumeLateralOffset(volume));
    }
  });

  it('leans in: closer than the shelf, with a narrower field of view', () => {
    expect(bookPose(0, 0, 0).radial).toBeGreaterThan(shelfPose(0, 0).radial);
    expect(bookPose(0, 0, 0).fov).toBeLessThan(CAMERA_FOV);
  });

  it('fills most of the frame with the volume, and not all of it', () => {
    const reach = verticalReachAtWall(bookPose(0, 2, 16));
    const spineHeightInFrame = SPINE_HEIGHT / (reach.top - reach.bottom);

    expect(spineHeightInFrame).toBeGreaterThan(0.4);
    expect(spineHeightInFrame).toBeLessThan(0.8);
  });
});

describe('every pose in a room', () => {
  it('stands clear of the volumes, inside the room', () => {
    for (const { wall, shelf, volume } of EVERY_VOLUME) {
      for (const pose of [
        wallPose(wall),
        shelfPose(wall, shelf),
        bookPose(wall, shelf, volume),
      ]) {
        // Never inside a book, and never inside the shelf boards either.
        expect(pose.radial).toBeLessThan(SPINE_FACE_RADIAL);
        // Within the room's own walls, floor and ceiling.
        expect(Math.abs(pose.lateral)).toBeLessThan(ROOM_WALL_WIDTH / 2);
        expect(pose.height).toBeGreaterThan(0);
        expect(pose.height).toBeLessThan(ROOM_HEIGHT);
      }
    }
  });
});

describe('the route to a navigation state', () => {
  it('begins at the one stop every route shares', () => {
    for (const state of [AT_ROOM, AT_WALL, AT_SHELF, AT_BOOK]) {
      expect(flightRouteTo(state).origin).toBe(ROOM_STOP);
    }
  });

  it('has one leg per level below the room, labelled with the level it reaches', () => {
    const labels = (state: NavigationState): readonly string[] =>
      flightRouteTo(state).legs.map((leg) => leg.label);

    expect(labels(AT_ROOM)).toEqual([]);
    expect(labels(AT_WALL)).toEqual(['wall']);
    expect(labels(AT_SHELF)).toEqual(['wall', 'shelf']);
    expect(labels(AT_BOOK)).toEqual(['wall', 'shelf', 'book']);
  });

  it('is the same route whichever page of the volume is open', () => {
    // A page is a turn inside the reader and moves no camera (SPEC §6), so a
    // turn retargets the flight at the route it is already on. If the page
    // reached the route at all, every turn would be a flight to nowhere.
    expect(flightRouteTo({ ...AT_BOOK, page: 409 })).toEqual(flightRouteTo(AT_BOOK));
  });

  it('carries the pose of each level it passes', () => {
    const state: NavigationState = {
      level: 'book',
      room: ROOM,
      wall: 2,
      shelf: 3,
      volume: 9,
      page: 0,
    };

    expect(flightRouteTo(state).legs.map((leg) => leg.pose)).toEqual([
      wallPose(2),
      shelfPose(2, 3),
      bookPose(2, 3, 9),
    ]);
  });

  it('gives each leg less time than the one above it', () => {
    const seconds = flightRouteTo(AT_BOOK).legs.map((leg) => leg.seconds);

    expect(seconds).toHaveLength(3);
    expect(seconds[0]).toBeGreaterThan(seconds[1] ?? 0);
    expect(seconds[1]).toBeGreaterThan(seconds[2] ?? 0);
    for (const leg of seconds) {
      expect(leg).toBeGreaterThan(0);
    }
  });
});
