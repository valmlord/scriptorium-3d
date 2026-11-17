/**
 * The camera rig: six numbers, and nothing else.
 *
 * ADR-0004 — gsap animates a plain object of numeric fields, and the object is
 * copied onto the three.js camera once per frame inside the one render loop.
 * Pointing a tween at `camera.position` works until something else also wants
 * to move the camera, and then two owners write the same property in the same
 * frame and the result depends on call order. So nothing in this layer knows
 * that three.js exists.
 *
 * **The fields are cylindrical, in the room's own frame.** `src/engine` places
 * every object in a room with `placeOnSide(side, radial, height, lateral)`, and
 * the rig uses those same three quantities with the side's bearing as a
 * continuous angle. That is what makes a flight to a wall one tween of
 * `bearing` towards `wallBearing(wall)` and a flight to a shelf one tween of
 * `height` towards `shelfCentreHeight(shelf)`. Three Cartesian components
 * would be three tweens that can disagree with each other about where the
 * camera is, and a camera half way between two walls in x, y and z
 * independently is not half way to anywhere.
 */

/** Where the camera is and what it is looking at, as numbers a tween can write. */
export interface CameraRig {
  /**
   * The outward bearing the camera faces, in radians: the angle of the wall
   * ahead of it, measured as `sideBearing` measures it. It is not reduced to
   * `[0, 2π)` — a flight takes the shortest turn, which means the value drifts
   * outside that interval and must be allowed to.
   */
  bearing: number;
  /**
   * Metres from the room's vertical axis, along `bearing`. Negative means the
   * far side of the room: at the room level the camera stands behind the axis
   * looking across it, which is how the whole wall fits in the frame.
   */
  radial: number;
  /** Metres above the floor. */
  height: number;
  /** Metres along the wall from its middle, positive towards the wall's +X end. */
  lateral: number;
  /** Radians above the horizontal. Negative looks down. */
  pitch: number;
  /** Vertical field of view, in degrees. The rig owns it, so nothing else writes it. */
  fov: number;
}

/**
 * A rig's values as a named destination: the same six numbers, read-only
 * because a pose is computed from the room's geometry and never animated in
 * place.
 */
export type CameraPose = Readonly<CameraRig>;

/** The same shape under the name `docs/testing.md` §7 gives the debug hook. */
export type CameraRigSnapshot = CameraPose;

/**
 * Every field a flight animates.
 *
 * The timeline builds its tween variables from this list rather than naming
 * the fields again, so a field added to `CameraRig` is animated by listing it
 * here and in `createRig` below, and nowhere else. `__tests__/rig.test.ts`
 * asserts the list against a real rig's own keys, so a field that reaches the
 * interface and misses the list does not quietly stop being animated.
 */
export const RIG_FIELDS: readonly (keyof CameraRig)[] = [
  'bearing',
  'radial',
  'height',
  'lateral',
  'pitch',
  'fov',
];

/** A mutable rig holding `pose`, for a timeline to write. */
export function createRig(pose: CameraPose): CameraRig {
  return {
    bearing: pose.bearing,
    radial: pose.radial,
    height: pose.height,
    lateral: pose.lateral,
    pitch: pose.pitch,
    fov: pose.fov,
  };
}

/**
 * A copy of the rig's values, for a caller that must not be able to write
 * them — the debug hook, and any test that keeps a value across a frame.
 */
export function snapshotOf(rig: CameraRig): CameraRigSnapshot {
  return createRig(rig);
}

/**
 * Whether two poses are the same pose, field for field and exactly.
 *
 * Exactly, with no tolerance, because this is what decides whether a built
 * flight still leads where the user is going: both sides come from the same
 * pure function of the same integers, so equal inputs give bit-identical
 * doubles, and a tolerance here would let a genuinely different destination
 * pass as the one already built.
 */
export function posesEqual(one: CameraPose, other: CameraPose): boolean {
  return RIG_FIELDS.every((field) => one[field] === other[field]);
}
