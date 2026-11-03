import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { BOOKS_PER_SHELF, SHELVES_PER_WALL, WALLS_PER_ROOM } from '@core/address';
import {
  PANEL_THICKNESS,
  ROOM_HEIGHT,
  ROOM_INRADIUS,
  ROOM_WALL_WIDTH,
  SHELF_BOARD_THICKNESS,
  SHELF_DEPTH,
  SHELF_PITCH,
  SHELF_SIDES,
  SPINE_DEPTH,
  SPINE_HEIGHT,
  SPINE_PITCH,
  SPINE_WALL_CLEARANCE,
  SPINE_WIDTH,
} from '@engine/constants';
import {
  HEXAGON_SIDES,
  SHELF_BOARDS_PER_ROOM,
  shelfBoardMatrix,
  shelfCentreHeight,
  shelfSurfaceHeight,
  sideBearing,
  sideYaw,
  spineMatrix,
  spineMatrixForSlot,
  volumeLateralOffset,
  wallBearing,
  wallPanelMatrix,
} from '@engine/layout';
import { SPINES_PER_ROOM, slotToCoordinates } from '@engine/slots';

/**
 * The layout is arithmetic, so it is tested as arithmetic — no WebGL context
 * anywhere in this file (`docs/testing.md` §1).
 *
 * Most assertions below are relations rather than decimals: that the spine
 * stands *on* the board, that its back clears the wall by the stated gap, that
 * its local +X lies along the wall. A decimal would pass just as well with the
 * sign of the tangent flipped, and the relation says what the number is for.
 * The few literal coordinates are there to catch the one thing a relation
 * cannot: the whole room silently moving.
 */

/** Spot-check coordinates, written out rather than recomputed from the constants. */
const WALL_0_SPINE_0_0 = { x: 1.3752457638216171, y: 0.441, z: 0.8939955358329092 };
const WALL_3_SPINE_4_31 = { x: 1.3752457638216165, y: 1.881, z: -0.8939955358329106 };

const matrix = new Matrix4();
const position = new Vector3();
const localX = new Vector3();
const localY = new Vector3();
const localZ = new Vector3();

/** The outward normal of hexagon side `side`, in the floor plane. */
function outwardNormal(side: number): Vector3 {
  const bearing = sideBearing(side);
  return new Vector3(Math.cos(bearing), 0, Math.sin(bearing));
}

/** The tangent of hexagon side `side`: its normal turned a quarter turn to +Z. */
function wallTangent(side: number): Vector3 {
  const bearing = sideBearing(side);
  return new Vector3(-Math.sin(bearing), 0, Math.cos(bearing));
}

/** How far out from the centre of the room a transform sits, along its wall's normal. */
function radialDistance(transform: Matrix4, side: number): number {
  position.setFromMatrixPosition(transform);
  return position.dot(outwardNormal(side));
}

/** How far along its wall a transform sits, from the middle of that wall. */
function lateralDistance(transform: Matrix4, side: number): number {
  position.setFromMatrixPosition(transform);
  return position.dot(wallTangent(side));
}

describe('hexagon bearings', () => {
  it('spaces the six sides a sixth of a turn apart', () => {
    const bearings = Array.from({ length: HEXAGON_SIDES }, (_, side) =>
      sideBearing(side)
    );

    expect(bearings).toHaveLength(HEXAGON_SIDES);
    bearings.forEach((bearing, side) => {
      expect(bearing).toBeCloseTo((side * Math.PI) / 3, 12);
    });
  });

  it('puts the four shelved walls on the sides that are not doorways', () => {
    const bearings = Array.from({ length: WALLS_PER_ROOM }, (_, wall) =>
      wallBearing(wall)
    );

    expect(bearings).toEqual(SHELF_SIDES.map((side) => sideBearing(side)));
  });

  it('refuses a wall the address model does not have', () => {
    expect(() => wallBearing(WALLS_PER_ROOM)).toThrow(RangeError);
    expect(() => wallBearing(-1)).toThrow(/does not exist/);
  });

  it('turns a box so that its width lies along the wall and its depth into the room', () => {
    for (let side = 0; side < HEXAGON_SIDES; side += 1) {
      matrix.makeRotationY(sideYaw(side));
      matrix.extractBasis(localX, localY, localZ);

      expect(localX.x).toBeCloseTo(wallTangent(side).x, 12);
      expect(localX.z).toBeCloseTo(wallTangent(side).z, 12);
      expect(localZ.x).toBeCloseTo(-outwardNormal(side).x, 12);
      expect(localZ.z).toBeCloseTo(-outwardNormal(side).z, 12);
      expect(localY.y).toBeCloseTo(1, 12);
    }
  });
});

describe('shelf heights', () => {
  it('stacks the five shelves one pitch apart from the lowest', () => {
    const heights = Array.from({ length: SHELVES_PER_WALL }, (_, shelf) =>
      shelfCentreHeight(shelf)
    );

    const steps = heights
      .slice(1)
      .map((height, index) => height - (heights[index] ?? 0));
    expect(steps).toHaveLength(SHELVES_PER_WALL - 1);
    for (const step of steps) {
      expect(step).toBeCloseTo(SHELF_PITCH, 12);
    }
  });

  it('puts the standing surface half a board above the board centre', () => {
    for (let shelf = 0; shelf < SHELVES_PER_WALL; shelf += 1) {
      expect(shelfSurfaceHeight(shelf) - shelfCentreHeight(shelf)).toBeCloseTo(
        SHELF_BOARD_THICKNESS / 2,
        12
      );
    }
  });

  it('leaves the top shelf and its volumes under the ceiling', () => {
    const topOfTallestVolume = shelfSurfaceHeight(SHELVES_PER_WALL - 1) + SPINE_HEIGHT;

    expect(topOfTallestVolume).toBeLessThan(ROOM_HEIGHT);
  });
});

describe('volume offsets along a wall', () => {
  it('centres the thirty-two volumes on the wall', () => {
    const first = volumeLateralOffset(0);
    const last = volumeLateralOffset(BOOKS_PER_SHELF - 1);

    expect(first).toBeCloseTo(-last, 12);
  });

  it('spaces neighbouring volumes by one pitch, which exceeds a spine width', () => {
    for (let volume = 1; volume < BOOKS_PER_SHELF; volume += 1) {
      const step = volumeLateralOffset(volume) - volumeLateralOffset(volume - 1);
      expect(step).toBeCloseTo(SPINE_PITCH, 12);
    }

    expect(SPINE_PITCH).toBeGreaterThan(SPINE_WIDTH);
  });

  it('keeps the whole shelf run inside the width of its wall', () => {
    const outerEdge = Math.abs(volumeLateralOffset(0)) + SPINE_WIDTH / 2;

    expect(outerEdge).toBeLessThan(ROOM_WALL_WIDTH / 2);
  });
});

describe('wall panel transforms', () => {
  it('puts the inner face of a panel exactly on the wall plane', () => {
    for (const side of SHELF_SIDES) {
      wallPanelMatrix(side, matrix);

      expect(radialDistance(matrix, side)).toBeCloseTo(
        ROOM_INRADIUS + PANEL_THICKNESS / 2,
        12
      );
      expect(lateralDistance(matrix, side)).toBeCloseTo(0, 12);
    }
  });

  it('stands a panel on the floor and reaches the ceiling', () => {
    wallPanelMatrix(SHELF_SIDES[0], matrix);
    position.setFromMatrixPosition(matrix);

    expect(position.y).toBeCloseTo(ROOM_HEIGHT / 2, 12);
  });
});

describe('shelf board transforms', () => {
  it('hangs each board off the wall plane, reaching its depth into the room', () => {
    for (let wall = 0; wall < WALLS_PER_ROOM; wall += 1) {
      for (let shelf = 0; shelf < SHELVES_PER_WALL; shelf += 1) {
        const side = SHELF_SIDES[wall] ?? -1;
        shelfBoardMatrix(wall, shelf, matrix);

        expect(radialDistance(matrix, side)).toBeCloseTo(
          ROOM_INRADIUS - SHELF_DEPTH / 2,
          12
        );
        expect(lateralDistance(matrix, side)).toBeCloseTo(0, 12);
        position.setFromMatrixPosition(matrix);
        expect(position.y).toBeCloseTo(shelfCentreHeight(shelf), 12);
      }
    }
  });

  it('accounts for every board in the room', () => {
    expect(SHELF_BOARDS_PER_ROOM).toBe(WALLS_PER_ROOM * SHELVES_PER_WALL);
  });

  it('refuses a shelf the address model does not have', () => {
    expect(() => shelfBoardMatrix(0, SHELVES_PER_WALL, matrix)).toThrow(RangeError);
    expect(() => shelfBoardMatrix(0, -1, matrix)).toThrow(/does not exist/);
    expect(() => shelfBoardMatrix(0, 1.5, matrix)).toThrow(RangeError);
  });
});

describe('spine transforms', () => {
  it('stands every volume on its own shelf board', () => {
    for (let wall = 0; wall < WALLS_PER_ROOM; wall += 1) {
      for (let shelf = 0; shelf < SHELVES_PER_WALL; shelf += 1) {
        spineMatrix(wall, shelf, 0, matrix);
        position.setFromMatrixPosition(matrix);

        expect(position.y - SPINE_HEIGHT / 2).toBeCloseTo(
          shelfSurfaceHeight(shelf),
          12
        );
      }
    }
  });

  it('leaves the stated gap between the back of a volume and the wall', () => {
    for (const side of SHELF_SIDES) {
      const wall = SHELF_SIDES.indexOf(side);
      spineMatrix(wall, 2, 7, matrix);

      const backOfVolume = radialDistance(matrix, side) + SPINE_DEPTH / 2;
      expect(ROOM_INRADIUS - backOfVolume).toBeCloseTo(SPINE_WALL_CLEARANCE, 12);
    }
  });

  it('keeps a volume within the depth of the board it stands on', () => {
    spineMatrix(1, 3, 12, matrix);
    const side = SHELF_SIDES[1];
    const centre = radialDistance(matrix, side);

    expect(centre + SPINE_DEPTH / 2).toBeLessThanOrEqual(ROOM_INRADIUS);
    expect(centre - SPINE_DEPTH / 2).toBeGreaterThanOrEqual(
      ROOM_INRADIUS - SHELF_DEPTH
    );
  });

  it('spaces the volumes of one shelf along the wall in index order', () => {
    const side = SHELF_SIDES[2];
    const offsets = Array.from({ length: BOOKS_PER_SHELF }, (_, volume) =>
      lateralDistance(spineMatrix(2, 1, volume, matrix), side)
    );

    for (let volume = 0; volume < BOOKS_PER_SHELF; volume += 1) {
      expect(offsets[volume]).toBeCloseTo(volumeLateralOffset(volume), 12);
    }
  });

  it('places the first and last volume of the room at known coordinates', () => {
    spineMatrix(0, 0, 0, matrix);
    position.setFromMatrixPosition(matrix);
    expect(position.x).toBeCloseTo(WALL_0_SPINE_0_0.x, 12);
    expect(position.y).toBeCloseTo(WALL_0_SPINE_0_0.y, 12);
    expect(position.z).toBeCloseTo(WALL_0_SPINE_0_0.z, 12);

    spineMatrix(WALLS_PER_ROOM - 1, SHELVES_PER_WALL - 1, BOOKS_PER_SHELF - 1, matrix);
    position.setFromMatrixPosition(matrix);
    expect(position.x).toBeCloseTo(WALL_3_SPINE_4_31.x, 12);
    expect(position.y).toBeCloseTo(WALL_3_SPINE_4_31.y, 12);
    expect(position.z).toBeCloseTo(WALL_3_SPINE_4_31.z, 12);
  });

  it('refuses a volume the address model does not have', () => {
    expect(() => spineMatrix(0, 0, BOOKS_PER_SHELF, matrix)).toThrow(RangeError);
    expect(() => spineMatrix(0, 0, -1, matrix)).toThrow(/does not exist/);
    expect(() => spineMatrix(WALLS_PER_ROOM, 0, 0, matrix)).toThrow(RangeError);
  });

  it('is a pure function of its arguments, not of the target it writes into', () => {
    const fresh = new Matrix4();
    const reused = new Matrix4().makeTranslation(9, 9, 9);

    spineMatrix(2, 3, 19, fresh);
    spineMatrix(2, 3, 19, reused);

    expect(Array.from(reused.elements)).toEqual(Array.from(fresh.elements));
  });

  it('returns the same target it was given', () => {
    const target = new Matrix4();

    expect(spineMatrix(1, 1, 1, target)).toBe(target);
    expect(shelfBoardMatrix(1, 1, target)).toBe(target);
    expect(wallPanelMatrix(1, target)).toBe(target);
  });
});

describe('spine transforms addressed by instance slot', () => {
  it('agrees with the transform of the coordinates that slot stands for', () => {
    const bySlot = new Matrix4();
    const byCoordinates = new Matrix4();

    for (let slot = 0; slot < SPINES_PER_ROOM; slot += 1) {
      const { wall, shelf, volume } = slotToCoordinates(slot);

      spineMatrixForSlot(slot, bySlot);
      spineMatrix(wall, shelf, volume, byCoordinates);

      expect(Array.from(bySlot.elements)).toEqual(Array.from(byCoordinates.elements));
    }
  });

  it('gives every slot of the room a distinct place to stand', () => {
    const places = new Set<string>();

    for (let slot = 0; slot < SPINES_PER_ROOM; slot += 1) {
      position.setFromMatrixPosition(spineMatrixForSlot(slot, matrix));
      places.add(
        `${position.x.toFixed(9)}|${position.y.toFixed(9)}|${position.z.toFixed(9)}`
      );
    }

    expect(places.size).toBe(SPINES_PER_ROOM);
  });
});
