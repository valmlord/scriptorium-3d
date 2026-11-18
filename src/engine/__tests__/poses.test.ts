import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { BOOKS_PER_SHELF, SHELVES_PER_WALL, WALLS_PER_ROOM } from '@core/address';
import { CAMERA_FAR, CAMERA_FOV, CAMERA_NEAR, applyRig } from '@engine/camera';
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
import type { CameraPose } from '@motion/rig';
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
 * The frame shape the opening vantage is claimed to hold the doorways out of.
 *
 * A `CAMERA_FOV` frame reaches sideways in proportion to the aspect ratio, so
 * the claim is only ever about a shape of window, and this names the shape
 * rather than pretending the property is unconditional. 16:9 is what the
 * README screenshot is taken at and what most windows are near.
 *
 * It is not much of a ceiling. The clearance runs out at about 1.90:1 and the
 * doorway is on screen by about 1.97:1, so a 2:1 display, which is a shape
 * that is sold, shows the hole. The earlier figure of 2.08:1 here came from a
 * floor-plan angle and was wrong for the reason `sidePlaneClearance` sets
 * out. A wider guarantee would have to be bought with a different radial
 * rather than asserted.
 */
const WIDEST_FRAMED_ASPECT = 16 / 9;

/**
 * How far ahead the corner the room level faces stands: the circumradius out
 * to the corner, plus the camera's own retreat from the middle of the room.
 */
const CORNER_DISTANCE = ROOM_CIRCUMRADIUS - ROOM_POSE.radial;

/** Half the vertical angle of the frame, for a framing check. */
function halfFrameAngle(fov: number): number {
  return (fov / 2) * (Math.PI / 180);
}

/** A pose, as much of one as the framing helpers below need. */
type Framing = { radial: number; height: number; pitch: number; fov: number };

/**
 * What a pose can see, vertically, `distance` of horizontal travel ahead.
 *
 * The frame's edges are the two rays leaving the camera at `pitch - fov/2`
 * and `pitch + fov/2` from the horizontal, so the angles are composed before
 * the tangent is taken. Adding `distance * tan(pitch)` to a half-extent of
 * `distance * tan(fov/2)` is a different number.
 *
 * Which way it is wrong is worth stating exactly, because the two edges are
 * not equally forgiving. Looking down, the sum puts **both** edges higher
 * than they are: at the room vantage it reported a bottom of 0.0664 m where
 * the frame reaches -0.0114 m, and a top of 2.5608 m where it reaches
 * 2.5105 m. Most assertions on the bottom edge here are "lower than", and a
 * bottom reported too high only makes those stricter. The one that matters
 * is at the top: `reach.top > ROOM_HEIGHT` was passing on 2.56 m against a
 * frame that reaches 2.51 m, an inflated margin of 0.16 m where the truth is
 * 0.11 m. Naming the drop as the dangerous side, as the first write-up of
 * this did, points an auditor at the edge that was never in doubt.
 *
 * "Most", not "every", and the exception is in this file: the cropping guard
 * below asserts the bottom edge stays *above* `SHELF_BASE_HEIGHT`, where an
 * inflated bottom flatters as well. It reported 0.6246 m there against a
 * true 0.5766 m, both far clear of the 0.3 m it is checked against, so no
 * verdict moved. A rule of thumb about which way an error cuts is worth
 * only as much as the sweep that backs it, and the first version of this
 * paragraph claimed "every" without doing the sweep.
 *
 * Nor is the direction a property of the formula. It holds for a downward
 * pitch, which is every pose here; pitched up, the sum overstates the drop
 * instead.
 *
 * The two forms agree exactly at zero pitch, which is every wall, shelf and
 * book pose, and that is why the error survived M5 and #51 unnoticed until a
 * pitched pose was measured with it (issue #52).
 */
function verticalReachAt(
  pose: Framing,
  distance: number
): { bottom: number; top: number } {
  const half = halfFrameAngle(pose.fov);
  return {
    bottom: pose.height + distance * Math.tan(pose.pitch - half),
    top: pose.height + distance * Math.tan(pose.pitch + half),
  };
}

/** What a pose can see where the wall it faces square on stands. */
function verticalReachAtWall(pose: Framing): { bottom: number; top: number } {
  return verticalReachAt(pose, ROOM_INRADIUS - pose.radial);
}

/**
 * How far outside the frame's side plane a point falls, in metres, measured
 * in the camera's own space. Positive is outside.
 *
 * **Not a floor-plan angle.** A frustum's side planes bound `|x| / depth`
 * where depth runs along the *pitched* view axis, so the angle they allow a
 * point is a function of that point's height: the nearer corner of a doorway
 * sits 46.4 degrees off the axis at the floor and 51.0 at the ceiling, while
 * its plan angle is 49.1 at every height. The plan angle is the value the
 * whole edge would have if the pitch were zero, which is the same mistake
 * `verticalReachAt` above exists to correct, and quoting it as a margin
 * claimed 2.08:1 of headroom where the real figure is nearer 1.9 (issue #52
 * review). So this asks the camera `applyRig` builds, and takes depth from
 * the view transform rather than from the plan.
 *
 * Not `point.project(camera)` and `|ndc.x| <= 1`, which would look like the
 * more direct question. A point behind the camera projects through a
 * negative `w`, which flips the sign and makes its NDC x meaningless, and
 * two of the doorway corners asked about here are behind the camera. A
 * clearance reports those as outside for the right reason.
 */
function sidePlaneClearance(pose: CameraPose, aspect: number, point: Vector3): number {
  const camera = new PerspectiveCamera(pose.fov, aspect, CAMERA_NEAR, CAMERA_FAR);
  applyRig(camera, pose);
  camera.updateMatrixWorld(true);

  const local = camera.worldToLocal(point.clone());
  // three.js cameras look down their own -z, so depth is -z.
  return Math.abs(local.x) - -local.z * Math.tan(halfFrameAngle(pose.fov)) * aspect;
}

/**
 * The clearance of the vertical edge standing at plan point `corner`, at the
 * floor and at the ceiling.
 *
 * Two heights are enough to bound the whole edge. `x` in camera space does
 * not depend on height at all, because `applyRig` leaves no roll and the
 * camera's right vector stays horizontal, and depth is linear in height, so
 * the clearance is linear in height and its minimum over the room is at one
 * end or the other.
 */
function edgeClearances(
  pose: CameraPose,
  aspect: number,
  corner: readonly [number, number]
): readonly number[] {
  return [0, ROOM_HEIGHT].map((y) =>
    sidePlaneClearance(pose, aspect, new Vector3(corner[0], y, corner[1]))
  );
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
 * away it is, and **signed**: negative to one side of the axis and positive to
 * the other. A point behind the camera comes back past a right angle, which is
 * what makes this a usable test of "out of frame" rather than only of "far to
 * one side".
 *
 * Signed rather than absolute so that a claim about the two halves of the
 * frame can be asserted as written. With magnitudes alone, "a wall under each
 * half" is indistinguishable from both walls piled into the same half, and a
 * test that cannot tell those apart is not testing its own sentence.
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
  return Math.atan2(across, along);
}

/**
 * Where the frame's bottom and top edges really are, `distance` of horizontal
 * travel ahead, taken from the camera the renderer uses rather than from a
 * formula.
 *
 * `applyRig` writes the camera and the projection matrix builds the frustum,
 * so unprojecting the middle of the bottom and top edges of the near plane
 * gives a point on each edge, and the ray from the camera through it is that
 * edge. Following the ray out is then a ratio of its own components. No
 * tangent is taken anywhere here, which is the whole point: this has to be
 * something `verticalReachAt` can be checked *against*, not a second copy of
 * it written in the same idiom. The x of each NDC point is 0, so the aspect
 * ratio cannot reach these two edges and any value serves.
 */
function frameEdgesFromCamera(
  pose: CameraPose,
  distance: number
): { bottom: number; top: number } {
  const camera = new PerspectiveCamera(
    pose.fov,
    WIDEST_FRAMED_ASPECT,
    CAMERA_NEAR,
    CAMERA_FAR
  );
  applyRig(camera, pose);
  camera.updateMatrixWorld(true);

  const alongEdge = (ndcY: number): number => {
    const onEdge = new Vector3(0, ndcY, -1).unproject(camera).sub(camera.position);
    // Rise over horizontal run, carried out to `distance` of run.
    return camera.position.y + (distance * onEdge.y) / Math.hypot(onEdge.x, onEdge.z);
  };

  return { bottom: alongEdge(-1), top: alongEdge(1) };
}

/**
 * A point on the floor at the foot of hexagon side `side`, `lateral` along
 * the wall from its middle.
 *
 * The same frame `placeOnSide` in `./layout.ts` puts every object in a room
 * at, restated here rather than imported: a test that reaches for the
 * module's own arithmetic to say where the room is compares that module
 * against itself, and a wrong answer in it would be invisible from here.
 */
function wallPoint(side: number, lateral: number): Vector3 {
  const bearing = sideBearing(side);
  return new Vector3(
    Math.cos(bearing) * ROOM_INRADIUS - Math.sin(bearing) * lateral,
    0,
    Math.sin(bearing) * ROOM_INRADIUS + Math.cos(bearing) * lateral
  );
}

/**
 * How far along the view axis `point` lies, horizontally. The frame's top and
 * bottom planes contain the camera's right vector, so this is the only part
 * of a point's position they care about.
 */
function axialRun(pose: CameraPose, point: Vector3): number {
  const [cameraX, cameraZ] = groundPosition(pose);
  return (
    (point.x - cameraX) * Math.cos(pose.bearing) +
    (point.z - cameraZ) * Math.sin(pose.bearing)
  );
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

describe('the framing helper the other tests are measured with', () => {
  /**
   * The arithmetic is only ever as good as the instrument. Pointing a camera
   * down tilts the frustum, and the edges of a tilted frustum do not sit at
   * `tan(pitch) +/- tan(fov/2)`: they sit at `tan(pitch +/- fov/2)`, which is
   * a different number for every pitch but zero (issue #52). At zero pitch
   * the two agree exactly, which is why this went unnoticed through M5 and
   * #51 and why the case below is pinned at the room level's own pitch
   * instead of a convenient one.
   */
  it('agrees with the renderer’s own camera where the pitch is not zero', () => {
    expect(ROOM_POSE.pitch).not.toBe(0);
    const edges = frameEdgesFromCamera(ROOM_POSE, CORNER_DISTANCE);

    const reach = verticalReachAt(ROOM_POSE, CORNER_DISTANCE);

    expect(reach.bottom).toBeCloseTo(edges.bottom, 9);
    expect(reach.top).toBeCloseTo(edges.top, 9);
  });

  it('agrees with it at zero pitch too, which is every other pose', () => {
    const square = wallPose(0);
    expect(square.pitch).toBe(0);
    const distance = ROOM_INRADIUS - square.radial;
    const edges = frameEdgesFromCamera(square, distance);

    const reach = verticalReachAtWall(square);

    expect(reach.bottom).toBeCloseTo(edges.bottom, 9);
    expect(reach.top).toBeCloseTo(edges.top, 9);
  });
});

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

  it('sees that corner from past the floor line to above the ceiling', () => {
    const reach = verticalReachAt(ROOM_POSE, CORNER_DISTANCE);

    // Past the floor, not merely past the lowest shelf. `poses.ts` quotes
    // -0.01 m here to the centimetre, and before the helper was corrected
    // this could not have been written: the old arithmetic reported +0.07.
    // A guard at `SHELF_BASE_HEIGHT` would leave a third of a metre of slack
    // under a figure quoted to a hundredth.
    expect(reach.bottom).toBeLessThan(0);
    expect(reach.top).toBeGreaterThan(ROOM_HEIGHT);
  });

  it('shows the floor only as a sliver at the foot of that corner', () => {
    // The other figure `ROOM_RADIAL` quotes, and the one most specific to
    // issue #46: what the reader sees at the bottom of the opening frame.
    // The bottom edge is a ray, so where it meets the floor is the height of
    // the eye over its own gradient.
    const crossing =
      ROOM_POSE.height / Math.tan(halfFrameAngle(ROOM_POSE.fov) - ROOM_POSE.pitch);

    expect(crossing).toBeLessThan(CORNER_DISTANCE);
    // A sliver, not a floor: under two centimetres deep at the corner.
    expect(CORNER_DISTANCE - crossing).toBeLessThan(0.02);
  });

  it('crops the lowest shelf and the ceiling towards the edges of the frame', () => {
    // The last claim in `ROOM_RADIAL`: the walls stand nearer than the corner
    // does, so the frame holds less of them the further from the middle it
    // looks. Walked out along the wall until the clearance changes sign,
    // rather than solved for: lateral runs from the shared corner, which is
    // dead ahead and inside the frame, towards the far one, which is outside
    // it, so the crossing is the point under the frame's own edge.
    const atLateral = (offset: number): Vector3 => wallPoint(SHELF_SIDES[0], offset);
    const half = ROOM_WALL_WIDTH / 2;
    const steps = 400;

    let underEdge = atLateral(half);
    for (let step = 0; step <= steps; step += 1) {
      const point = atLateral(half - (step / steps) * ROOM_WALL_WIDTH);
      if (sidePlaneClearance(ROOM_POSE, WIDEST_FRAMED_ASPECT, point) > 0) {
        break;
      }
      underEdge = point;
    }

    // The frame's top and bottom planes both contain the camera's right
    // vector, which is horizontal, so their height depends only on how far
    // along the bearing a point is and not on how far to the side.
    const reach = verticalReachAt(ROOM_POSE, axialRun(ROOM_POSE, underEdge));

    expect(reach.bottom).toBeGreaterThan(SHELF_BASE_HEIGHT);
    expect(reach.top).toBeLessThan(ROOM_HEIGHT);
  });

  it('holds both doorways out of the frame, which is what stops it opening on a hole', () => {
    // The whole of issue #46: through a doorway is the background colour and
    // not a corridor, so a doorway in the opening frame is a quarter of the
    // first impression spent on nothing.
    //
    // Asserted against the camera's own side plane and over the full height
    // of the room, which is stronger than "no visible point of it is in
    // frame" and needs no reasoning about where the edge crosses the bottom.
    for (const side of DOORWAY_SIDES) {
      for (const corner of sideCorners(side)) {
        for (const clearance of edgeClearances(
          ROOM_POSE,
          WIDEST_FRAMED_ASPECT,
          corner
        )) {
          expect(clearance).toBeGreaterThan(0);
        }
      }
    }
  });

  it('puts a shelved wall under each half of the frame, one either side', () => {
    // The other half of the claim: not merely no doorway, but books on both
    // sides. Each wall runs from the corner, which is dead ahead, out past an
    // edge of the frame, and the two run opposite ways. In and out are the
    // camera's side plane again, for the reason given on `sidePlaneClearance`;
    // only the handedness is a question the floor plan can answer, because
    // which side of the axis a point lies on does not depend on its height.
    const spans = SHELF_SIDES.slice(0, 2).map((side) => {
      const corners = sideCorners(side);
      // At the floor, where the frame is tightest against these corners.
      const clearances = corners.map((corner) =>
        sidePlaneClearance(
          ROOM_POSE,
          WIDEST_FRAMED_ASPECT,
          new Vector3(corner[0], 0, corner[1])
        )
      );
      const angles = corners.map((corner) => offAxisAngle(ROOM_POSE, corner));

      return {
        inner: Math.min(...clearances),
        outer: Math.max(...clearances),
        // Which way the wall runs: the corner it does not share with the
        // other wall sits to one side of the axis, and the sign of the
        // widest plan angle names which.
        hand: Math.sign(
          angles.reduce((widest, angle) =>
            Math.abs(widest) > Math.abs(angle) ? widest : angle
          )
        ),
      };
    });

    for (const span of spans) {
      // Inside the frame at the shared corner, outside it at the far one.
      expect(span.inner).toBeLessThan(0);
      expect(span.outer).toBeGreaterThan(0);
    }
    // Each hand is -1 or +1, so a product of -1 says they are opposite, and
    // it says it without indexing a pair the type system cannot size.
    expect(spans.reduce((product, span) => product * span.hand, 1)).toBe(-1);
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
