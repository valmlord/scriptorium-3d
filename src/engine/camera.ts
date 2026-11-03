import type { PerspectiveCamera } from 'three';
import { ROOM_HEIGHT, ROOM_INRADIUS } from './constants';
import { cameraFocus } from './scratch';

/**
 * Where the camera is this frame.
 *
 * A slow turn on the spot, looking outward at whichever wall is ahead, so that
 * the room shows all four shelved walls and both doorways without anyone
 * touching a control. It is deliberately the simplest motion that proves the
 * room is there: the `CameraRig`, the labelled timeline and the flight from
 * room to wall to shelf to book are M5's, and a hand-written animation here
 * would be the second one ADR-0004 exists to prevent.
 *
 * This function is the only writer of the camera's position and orientation
 * (`docs/architecture.md` §2), and it allocates nothing: the focus point is
 * the module scratch of `./scratch.ts` and `lookAt` is given that same object
 * every frame.
 */

/** Seconds for one full turn. Slow enough to read a shelf as it passes. */
export const ORBIT_PERIOD_SECONDS = 72;

/**
 * Where the turn begins. Hexagon side 0 is a doorway (`./constants.ts`), so a
 * turn starting at a bearing of zero opens on the dark of a corridor with no
 * neighbouring room in it yet. A sixth of a turn puts the first shelved wall
 * in front of the camera at the moment the page loads.
 */
const ORBIT_PHASE = Math.PI / 3;

/**
 * How far the camera stands from the middle of the room — *away* from the wall
 * it is looking at, not towards it. Standing on the near side puts the camera
 * 1.1 m from a 2.4 m wall and crops it to a shelf and a half; standing on the
 * far side gives it 2.0 m, which is the whole wall from floor to ceiling.
 */
const ORBIT_RADIUS = 0.45;

/** Eye height of someone standing in the gallery. */
const EYE_HEIGHT = 1.52;

/**
 * Where the camera looks, as a multiple of the inradius: past the wall rather
 * than at it, so the view is square to the shelves instead of converging.
 */
const FOCUS_REACH = 1.25;

/** Slightly below eye level, which puts the middle shelves in the frame. */
const FOCUS_DROP = 0.22;

/** The bearing of the wall the camera is looking at after `elapsedSeconds`. */
export function orbitBearing(elapsedSeconds: number): number {
  return ORBIT_PHASE + (2 * Math.PI * elapsedSeconds) / ORBIT_PERIOD_SECONDS;
}

/** Point `camera` at the room from the bearing `elapsedSeconds` has reached. */
export function updateOrbit(camera: PerspectiveCamera, elapsedSeconds: number): void {
  const bearing = orbitBearing(elapsedSeconds);
  const outwardX = Math.cos(bearing);
  const outwardZ = Math.sin(bearing);

  camera.position.set(-outwardX * ORBIT_RADIUS, EYE_HEIGHT, -outwardZ * ORBIT_RADIUS);
  cameraFocus.set(
    outwardX * ROOM_INRADIUS * FOCUS_REACH,
    EYE_HEIGHT - FOCUS_DROP,
    outwardZ * ROOM_INRADIUS * FOCUS_REACH
  );
  camera.lookAt(cameraFocus);
}

/** Near and far planes that bracket a room without clipping its far wall. */
export const CAMERA_NEAR = 0.05;
export const CAMERA_FAR = ROOM_HEIGHT * 25;

/** Vertical field of view, in degrees. Wide enough to see a whole wall. */
export const CAMERA_FOV = 58;
