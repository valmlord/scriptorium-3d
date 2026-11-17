import type { Matrix4 } from 'three';
import { BOOKS_PER_SHELF, SHELVES_PER_WALL } from '@core/address';
import {
  PANEL_THICKNESS,
  ROOM_HEIGHT,
  ROOM_INRADIUS,
  SHELF_BASE_HEIGHT,
  SHELF_BOARD_THICKNESS,
  SHELF_DEPTH,
  SHELF_PITCH,
  SHELF_SIDES,
  SPINE_DEPTH,
  SPINE_HEIGHT,
  SPINE_PITCH,
  SPINE_WALL_CLEARANCE,
} from './constants';
import { slotToCoordinates } from './slots';

/**
 * Where everything in a room stands, as arithmetic.
 *
 * None of this needs a WebGL context, which is the point: `docs/testing.md` §1
 * puts the layout maths in unit tests and keeps the renderer thin enough to
 * review by eye. Every function here is a pure function of integers — give it
 * the same wall, shelf and volume and it writes the same matrix, on any
 * machine, in any session.
 *
 * Every function that produces a `Matrix4`, a `Vector3` or a `Quaternion`
 * writes into a target the caller owns and returns it. That is three.js'
 * out-parameter idiom, and it is what lets the room builder and the frame loop
 * reuse the module scratch of `./scratch.ts` instead of allocating
 * (`docs/architecture.md` §2).
 *
 * Frame of reference: the room is centred on the origin with +Y up. Hexagon
 * side `s` faces outward along the bearing `s * 60°` measured from +X towards
 * +Z, so its wall plane stands at `ROOM_INRADIUS` from the centre along that
 * bearing. A box placed on a wall has its local +X along the wall and its
 * local +Z pointing into the room, so one yaw serves panels, shelf boards and
 * spines alike.
 */

/** Sides of the hexagon, shelved and open together. */
export const HEXAGON_SIDES = 6;

/** Shelf boards in a room: one per shelf on each of the four shelved walls. */
export const SHELF_BOARDS_PER_ROOM = SHELF_SIDES.length * SHELVES_PER_WALL;

const SIDE_ANGLE = (2 * Math.PI) / HEXAGON_SIDES;

/** Outward bearing of hexagon side `side`, in radians. */
export function sideBearing(side: number): number {
  return side * SIDE_ANGLE;
}

/** Outward bearing of the wall carrying shelf wall `wall` of the address model. */
export function wallBearing(wall: number): number {
  return sideBearing(sideOfWall(wall));
}

/**
 * The angle equal to `bearing` that is nearest to `reference`: the same
 * direction, written so that turning to it is the shorter way round.
 *
 * A camera facing 60° and sent to a wall at 300° must turn back 120° and not
 * forward 240°, and a tween interpolates the number it is given. So the
 * destination is the number that means the right direction *and* the right
 * turn, which is the one within half a turn of where the camera already
 * points. An exact half turn resolves one way rather than wavering:
 * `Math.round` sends a tie up, so a turn of `+π` becomes `-π` and the camera
 * swings through decreasing angles.
 */
export function nearestBearing(reference: number, bearing: number): number {
  const fullTurn = 2 * Math.PI;
  const turn = bearing - reference;
  return reference + turn - fullTurn * Math.round(turn / fullTurn);
}

/**
 * Yaw, about +Y, that puts a box's local +X along hexagon side `side` and its
 * local +Z pointing into the room.
 *
 * A rotation of `a` about +Y sends local +X to `(cos a, 0, -sin a)` and local
 * +Z to `(sin a, 0, cos a)`. The wall's tangent is `(-sin φ, 0, cos φ)` and
 * its inward normal `(-cos φ, 0, -sin φ)` for a bearing φ, and both are
 * satisfied at once by `a = -π/2 - φ`.
 */
export function sideYaw(side: number): number {
  return -Math.PI / 2 - sideBearing(side);
}

/** Height of the top face of shelf board `shelf`, which is what volumes stand on. */
export function shelfSurfaceHeight(shelf: number): number {
  return shelfCentreHeight(shelf) + SHELF_BOARD_THICKNESS / 2;
}

/** Height of the middle of shelf board `shelf`. */
export function shelfCentreHeight(shelf: number): number {
  return SHELF_BASE_HEIGHT + shelf * SHELF_PITCH;
}

/**
 * Offset of volume `volume` along its wall, from the middle of the wall. The
 * 32 volumes are centred on the wall, so volume 0 sits at the negative-tangent
 * end and volume 31 at the positive one, half a pitch either side of centre.
 */
export function volumeLateralOffset(volume: number): number {
  return (volume - (BOOKS_PER_SHELF - 1) / 2) * SPINE_PITCH;
}

/** Transform of the wall panel closing hexagon side `side`. */
export function wallPanelMatrix(side: number, target: Matrix4): Matrix4 {
  // The panel's inner face is the wall plane, so its middle sits half a
  // thickness further out. Without that the shelves would be sunk into it.
  return placeOnSide(
    side,
    ROOM_INRADIUS + PANEL_THICKNESS / 2,
    ROOM_HEIGHT / 2,
    0,
    target
  );
}

/** Transform of shelf board `shelf` on shelf wall `wall`. */
export function shelfBoardMatrix(
  wall: number,
  shelf: number,
  target: Matrix4
): Matrix4 {
  assertShelf(shelf);
  // Centred half its depth in from the wall plane, so the back edge of the
  // board touches the wall and it reaches SHELF_DEPTH into the room.
  return placeOnSide(
    sideOfWall(wall),
    ROOM_INRADIUS - SHELF_DEPTH / 2,
    shelfCentreHeight(shelf),
    0,
    target
  );
}

/** Transform of the volume at `(wall, shelf, volume)` as it stands on its shelf. */
export function spineMatrix(
  wall: number,
  shelf: number,
  volume: number,
  target: Matrix4
): Matrix4 {
  assertShelf(shelf);
  assertVolume(volume);
  return placeOnSide(
    sideOfWall(wall),
    ROOM_INRADIUS - SPINE_WALL_CLEARANCE - SPINE_DEPTH / 2,
    shelfSurfaceHeight(shelf) + SPINE_HEIGHT / 2,
    volumeLateralOffset(volume),
    target
  );
}

/** Transform of the volume at instance slot `slot`, for the room builder. */
export function spineMatrixForSlot(slot: number, target: Matrix4): Matrix4 {
  const { wall, shelf, volume } = slotToCoordinates(slot);
  return spineMatrix(wall, shelf, volume, target);
}

/**
 * Place a box on hexagon side `side`: `radial` from the centre of the room
 * along the side's outward bearing, `height` above the floor, and `lateral`
 * along the wall from its middle.
 *
 * Written straight into the target as a yaw and a translation rather than
 * through `Matrix4.compose`, which would want a `Vector3`, a `Quaternion` and
 * a second `Vector3` for the unit scale to hold its arguments. Three fewer
 * objects to own, and nothing here allocates: `makeRotationY` fills the
 * rotation and clears the translation column, and `setPosition` then writes
 * that column.
 */
function placeOnSide(
  side: number,
  radial: number,
  height: number,
  lateral: number,
  target: Matrix4
): Matrix4 {
  const bearing = sideBearing(side);
  const outwardX = Math.cos(bearing);
  const outwardZ = Math.sin(bearing);
  target.makeRotationY(sideYaw(side));
  // The tangent is the outward normal turned a quarter turn towards +Z.
  return target.setPosition(
    outwardX * radial - outwardZ * lateral,
    height,
    outwardZ * radial + outwardX * lateral
  );
}

function sideOfWall(wall: number): number {
  const side = SHELF_SIDES[wall];
  if (side === undefined) {
    throw new RangeError(
      `Shelf wall ${String(wall)} does not exist: a room has ${String(SHELF_SIDES.length)} shelved walls`
    );
  }
  return side;
}

function assertShelf(shelf: number): void {
  if (!Number.isInteger(shelf) || shelf < 0 || shelf >= SHELVES_PER_WALL) {
    throw new RangeError(
      `Shelf ${String(shelf)} does not exist: a wall carries ${String(SHELVES_PER_WALL)} shelves`
    );
  }
}

function assertVolume(volume: number): void {
  if (!Number.isInteger(volume) || volume < 0 || volume >= BOOKS_PER_SHELF) {
    throw new RangeError(
      `Volume ${String(volume)} does not exist: a shelf carries ${String(BOOKS_PER_SHELF)} volumes`
    );
  }
}
