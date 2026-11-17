import { describe, expect, it } from 'vitest';
import { BOOKS_PER_SHELF, SHELVES_PER_WALL, WALLS_PER_ROOM } from '@core/address';
import { CAMERA_FOV } from '@engine/camera';
import {
  ROOM_HEIGHT,
  ROOM_INRADIUS,
  ROOM_WALL_WIDTH,
  SHELF_BASE_HEIGHT,
  SHELF_PITCH,
  SPINE_DEPTH,
  SPINE_HEIGHT,
  SPINE_WALL_CLEARANCE,
} from '@engine/constants';
import {
  nearestBearing,
  shelfSurfaceHeight,
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
};

/** The face of a volume that looks into the room: the nearest thing to the camera. */
const SPINE_FACE_RADIAL = ROOM_INRADIUS - SPINE_WALL_CLEARANCE - SPINE_DEPTH;

/** Half the vertical angle of the frame, for a framing check. */
function halfFrameAngle(fov: number): number {
  return (fov / 2) * (Math.PI / 180);
}

/**
 * What a pose can see, vertically, where the wall it faces stands. The pitch
 * moves the middle of the frame up or down the wall; only the room's own
 * vantage has any.
 */
function verticalReachAtWall(pose: {
  radial: number;
  height: number;
  pitch: number;
  fov: number;
}): { bottom: number; top: number } {
  const distance = ROOM_INRADIUS - pose.radial;
  const centre = pose.height + distance * Math.tan(pose.pitch);
  const half = distance * Math.tan(halfFrameAngle(pose.fov));
  return { bottom: centre - half, top: centre + half };
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
  it('faces the first shelved wall from the far side of the room', () => {
    expect(ROOM_POSE.bearing).toBe(wallBearing(0));
    expect(ROOM_POSE.radial).toBeLessThan(0);
    expect(ROOM_POSE.pitch).toBeLessThan(0);
    expect(ROOM_POSE.fov).toBe(CAMERA_FOV);
    expect(ROOM_STOP.pose).toBe(ROOM_POSE);
    expect(ROOM_STOP.label).toBe('room');
  });

  it('sees every shelf of that wall, and the ceiling above them', () => {
    const reach = verticalReachAtWall(ROOM_POSE);

    expect(reach.bottom).toBeLessThan(SHELF_BASE_HEIGHT);
    expect(reach.top).toBeGreaterThan(ROOM_HEIGHT);
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

  it('carries the pose of each level it passes', () => {
    const state: NavigationState = {
      level: 'book',
      room: ROOM,
      wall: 2,
      shelf: 3,
      volume: 9,
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
