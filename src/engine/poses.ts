import { SHELVES_PER_WALL } from '@core/address';
import type { FlightLeg, FlightRoute, FlightStop } from '@motion/flight';
import type { CameraPose } from '@motion/rig';
import type { NavigationLevel, NavigationState } from '@state/navigation';
import { CAMERA_FOV } from './camera';
import { SHELF_BOARD_THICKNESS, ROOM_INRADIUS, SPINE_HEIGHT } from './constants';
import {
  HEXAGON_SIDES,
  nearestBearing,
  shelfCentreHeight,
  shelfSurfaceHeight,
  volumeLateralOffset,
  wallBearing,
} from './layout';

/**
 * Where the camera stands at each navigation level, as arithmetic.
 *
 * This is the one place that knows both the room's dimensions and the rig's
 * fields, and it is pure: give it a navigation state and it writes the route a
 * flight follows, on any machine, with no WebGL context anywhere near it
 * (`docs/testing.md` §1). `motion` animates the numbers it produces and never
 * computes them, which is what keeps gsap away from the room's geometry and
 * the geometry away from gsap.
 *
 * **Every stop is derived from the room rather than chosen.** A standoff is
 * the distance at which what the level is about fits in a `CAMERA_FOV` frame,
 * computed from the heights `./constants.ts` fixes, so a room built to
 * different dimensions moves the camera with it instead of leaving it looking
 * at the wrong part of a wall.
 *
 * **The origin stop is a constant.** Every route begins at the same `room`
 * stop, which is what lets a flight always retreat to a point both the route
 * it is on and the route it is asked for agree about (ADR-0030). The visible
 * consequence is that backing out of a wall returns to the room's own vantage,
 * bearing included: the view of the room is a place, not wherever the reader
 * happened to be facing when they left it.
 */

/** Half of `CAMERA_FOV`, in radians: the angle a framing calculation uses. */
const HALF_FOV = (CAMERA_FOV / 2) * (Math.PI / 180);

/**
 * How far back something of half-height `halfHeight` has to be seen from to
 * fit inside the frame, with `margin` times its own height of air around it.
 */
function standoffFraming(halfHeight: number, margin: number): number {
  return (halfHeight * margin) / Math.tan(HALF_FOV);
}

/** A side's bearing to either corner beside it: half the angle between sides. */
const HALF_SIDE_ANGLE = Math.PI / HEXAGON_SIDES;

/**
 * Where the room level looks: the corner the first two shelved walls share.
 *
 * Not at the middle of a wall, which is where this used to point. A wall
 * subtends 60 degrees of the room and a `CAMERA_FOV` frame is 89 degrees wide
 * at 16:9, so a camera square on to one wall sees past its edge and out
 * through the doorway beside it, and what is through a doorway is the
 * background colour: no corridor is built yet, and a quarter of the opening
 * frame was that hole rather than a room (issue #46). Looking at the corner
 * instead puts a shelved wall under each half of the frame and both doorways
 * outside it, which is also the only view that shows the room turning rather
 * than one flat wall of books.
 *
 * Outside it, not behind the camera: the nearer corner of each doorway is
 * 49.1 degrees off the view axis against a frame that reaches 44.6 degrees at
 * 16:9, so the margin is 4.5 degrees and a window wider than about 2.08:1
 * brings the hole back. `__tests__/poses.test.ts` asserts the 16:9 case.
 *
 * It is the right place to turn from, too: every wall is then within 150
 * degrees of where a flight starts, where facing wall 0 left the wall
 * opposite a half turn away.
 */
const ROOM_BEARING = wallBearing(0) + HALF_SIDE_ANGLE;

/**
 * How far the room level stands from the middle of the room, *away* from the
 * corner it looks at rather than towards it. That puts the camera 2.25 m from
 * the corner, where a `CAMERA_FOV` frame reaches from -0.01 m to 2.51 m: the
 * corner's whole height, shelf run and ceiling together, and the floor line
 * at its foot.
 *
 * Only at its foot, though. The bottom edge of the frame crosses the floor at
 * 2.23 m of horizontal travel, so what is in view is the last two centimetres
 * of floor before the corner and nothing nearer: the reader is looking at the
 * room from above its floor, not across it. The walls also stand nearer than
 * the corner does, so towards the edges of the frame the lowest shelf and the
 * ceiling both fall outside it. Standing on the near side would crop every
 * wall that way.
 *
 * It is also what keeps the doorways out of the frame, and the direction is
 * the one nobody guesses: backing *further* off swings them back into view,
 * because the camera retreats towards them while the corner stays put. The
 * figure is M4's, and this is the vantage M4's opening shot turned on the
 * spot through.
 */
const ROOM_RADIAL = -0.45;

/** Eye height of someone standing in the gallery. M4's figure. */
const ROOM_HEIGHT_OF_EYE = 1.52;

/** Where the room level looks, as a multiple of the inradius: past the corner, not at it. */
const ROOM_FOCUS_REACH = 1.25;

/** Slightly below eye level, which puts the middle shelves in the frame. M4's figure. */
const ROOM_FOCUS_DROP = 0.22;

/**
 * The room level's pitch, derived from the two figures above rather than
 * written down: the drop over the horizontal distance to the point M4 looked
 * at, so the opening view is the view the orbit had at a standstill.
 */
const ROOM_PITCH = Math.atan2(
  -ROOM_FOCUS_DROP,
  ROOM_INRADIUS * ROOM_FOCUS_REACH - ROOM_RADIAL
);

/** The underside of the lowest shelf board: the bottom of what a wall shows. */
const SHELF_RUN_BOTTOM = shelfCentreHeight(0) - SHELF_BOARD_THICKNESS / 2;

/** The top of the volumes on the highest shelf: the top of what a wall shows. */
const SHELF_RUN_TOP = shelfSurfaceHeight(SHELVES_PER_WALL - 1) + SPINE_HEIGHT;

/** Eight per cent of air around the shelf run, so the wall is not flush to the frame. */
const WALL_FRAMING_MARGIN = 1.08;

/**
 * The wall level: square on to the wall, at the middle of its shelf run, far
 * enough back that all five shelves and the volumes on them are in the frame.
 */
const WALL_HEIGHT = (SHELF_RUN_BOTTOM + SHELF_RUN_TOP) / 2;
const WALL_RADIAL =
  ROOM_INRADIUS -
  standoffFraming((SHELF_RUN_TOP - SHELF_RUN_BOTTOM) / 2, WALL_FRAMING_MARGIN);

/**
 * A shelf of volumes is 0.26 m tall, and framing it alone would show a row of
 * spines with no indication of where on the wall it is. Two and a half times
 * its height brings the neighbouring shelves into the edges of the frame,
 * which is what tells the reader they are part of the way up a wall.
 */
const SHELF_FRAMING_MARGIN = 2.5;
const SHELF_RADIAL =
  ROOM_INRADIUS - standoffFraming(SPINE_HEIGHT / 2, SHELF_FRAMING_MARGIN);

/**
 * At the book level the camera leans in to one volume: 1.8 spine heights of
 * frame, which is close enough to read a spine and still a third of a metre
 * clear of the shelf it stands on. A spine is 42 mm wide, so it fills a tenth
 * of the frame rather than all of it — a volume on a shelf is a small thing,
 * and the reader of M6 opens it rather than squinting at it.
 */
const BOOK_FRAMING_MARGIN = 1.8;

/** The field of view narrows for the last step, which is what leaning in looks like. */
const BOOK_FOV = 50;

const BOOK_HALF_FOV = (BOOK_FOV / 2) * (Math.PI / 180);
const BOOK_RADIAL =
  ROOM_INRADIUS - ((SPINE_HEIGHT / 2) * BOOK_FRAMING_MARGIN) / Math.tan(BOOK_HALF_FOV);

/**
 * Seconds of timeline per leg, shortening as the flight descends: the room to
 * a wall is a turn of up to half a circle and the length of the room, while a
 * shelf to a book is half a metre and no turn at all. One duration for all
 * three would make the last step feel like wading.
 */
const WALL_LEG_SECONDS = 1.4;
const SHELF_LEG_SECONDS = 1;
const BOOK_LEG_SECONDS = 0.7;

/** The labels are the navigation levels, so a renamed level is a type error here. */
const ROOM_LABEL: NavigationLevel = 'room';
const WALL_LABEL: NavigationLevel = 'wall';
const SHELF_LABEL: NavigationLevel = 'shelf';
const BOOK_LABEL: NavigationLevel = 'book';

/** The vantage the library opens at, and the start of every route. */
export const ROOM_POSE: CameraPose = {
  bearing: ROOM_BEARING,
  radial: ROOM_RADIAL,
  height: ROOM_HEIGHT_OF_EYE,
  lateral: 0,
  pitch: ROOM_PITCH,
  fov: CAMERA_FOV,
};

/** The stop at time zero of every flight. */
export const ROOM_STOP: FlightStop = { label: ROOM_LABEL, pose: ROOM_POSE };

/** Square on to `wall`, with its whole shelf run in the frame. */
export function wallPose(wall: number): CameraPose {
  return {
    // The shorter way round from the room's own bearing, which is where every
    // route starts and therefore where every turn starts.
    bearing: nearestBearing(ROOM_BEARING, wallBearing(wall)),
    radial: WALL_RADIAL,
    height: WALL_HEIGHT,
    lateral: 0,
    pitch: 0,
    fov: CAMERA_FOV,
  };
}

/** Level with the volumes on `shelf` of `wall`, close enough to read the row. */
export function shelfPose(wall: number, shelf: number): CameraPose {
  return {
    ...wallPose(wall),
    radial: SHELF_RADIAL,
    height: volumeCentreHeight(shelf),
  };
}

/** In front of one volume, centred on it. */
export function bookPose(wall: number, shelf: number, volume: number): CameraPose {
  return {
    ...wallPose(wall),
    radial: BOOK_RADIAL,
    height: volumeCentreHeight(shelf),
    lateral: volumeLateralOffset(volume),
    fov: BOOK_FOV,
  };
}

/**
 * The route from the room down to wherever `state` is: one leg per level below
 * the room, each labelled with the level it arrives at.
 *
 * A `room` state has no legs at all, which is a route that goes nowhere and is
 * exactly right: the flight is already there.
 */
export function flightRouteTo(state: NavigationState): FlightRoute {
  return { origin: ROOM_STOP, legs: legsTo(state) };
}

function legsTo(state: NavigationState): readonly FlightLeg[] {
  switch (state.level) {
    case 'room':
      return [];
    case 'wall':
      return [wallLeg(state.wall)];
    case 'shelf':
      return [wallLeg(state.wall), shelfLeg(state.wall, state.shelf)];
    case 'book':
      return [
        wallLeg(state.wall),
        shelfLeg(state.wall, state.shelf),
        bookLeg(state.wall, state.shelf, state.volume),
      ];
  }
}

function wallLeg(wall: number): FlightLeg {
  return { label: WALL_LABEL, pose: wallPose(wall), seconds: WALL_LEG_SECONDS };
}

function shelfLeg(wall: number, shelf: number): FlightLeg {
  return {
    label: SHELF_LABEL,
    pose: shelfPose(wall, shelf),
    seconds: SHELF_LEG_SECONDS,
  };
}

function bookLeg(wall: number, shelf: number, volume: number): FlightLeg {
  return {
    label: BOOK_LABEL,
    pose: bookPose(wall, shelf, volume),
    seconds: BOOK_LEG_SECONDS,
  };
}

/** The height of the middle of a volume standing on `shelf`. */
function volumeCentreHeight(shelf: number): number {
  return shelfSurfaceHeight(shelf) + SPINE_HEIGHT / 2;
}
