/**
 * The physical dimensions of one room, in metres.
 *
 * The hexagon of SPEC §3 is Borges' gallery: six walls, four of which carry
 * five shelves of thirty-two volumes, and two of which are doorways. Those
 * counts are the address model's and live in `@core/address`; nothing here
 * restates them. What lives here is the only thing `core` cannot know — how
 * large the room is in metres — and every figure is derived from the one
 * measurement that fixes the rest: thirty-two volumes have to fit on a shelf.
 *
 * A volume is 42 mm across its spine on a 48 mm pitch, so a shelf runs
 * 32 * 48 mm = 1.536 m of books. A wall of 1.8 m leaves 132 mm of margin at
 * each end, which is why the wall is that width and not a rounder number.
 */

/** Width of one wall of the hexagon: the shelf run plus its end margins. */
export const ROOM_WALL_WIDTH = 1.8;

/**
 * Circumradius of the hexagon. For a regular hexagon the edge length and the
 * circumradius are the same number — this alias exists so the floor and
 * ceiling plates can be built from a radius without the reader having to
 * remember that identity.
 */
export const ROOM_CIRCUMRADIUS = ROOM_WALL_WIDTH;

/**
 * Inradius: centre of the room to the middle of a wall, `R * sqrt(3) / 2`.
 * This is the distance every shelf and spine transform is measured from.
 */
export const ROOM_INRADIUS = (ROOM_CIRCUMRADIUS * Math.sqrt(3)) / 2;

/** Floor to ceiling. Tall enough to stand in, as the gallery is described. */
export const ROOM_HEIGHT = 2.4;

/** Thickness of a wall panel, floor plate and ceiling plate. */
export const PANEL_THICKNESS = 0.06;

/** Height of the lowest shelf board above the floor. */
export const SHELF_BASE_HEIGHT = 0.3;

/** Vertical distance between two shelf boards. */
export const SHELF_PITCH = 0.36;

/** Thickness of a shelf board. */
export const SHELF_BOARD_THICKNESS = 0.022;

/** How far a shelf board reaches out from the wall face into the room. */
export const SHELF_DEPTH = 0.2;

/** Width of one spine, across the shelf. */
export const SPINE_WIDTH = 0.042;

/** Distance between the centres of two neighbouring spines. */
export const SPINE_PITCH = 0.048;

/** Height of a spine as it stands on its shelf. */
export const SPINE_HEIGHT = 0.26;

/** Depth of a volume, from its spine back into the shelf. */
export const SPINE_DEPTH = 0.17;

/** Air gap between the back of a volume and the wall face. */
export const SPINE_WALL_CLEARANCE = 0.012;

/**
 * The two hexagon sides that carry no shelves. Opposite sides, so the pair
 * forms a through-passage rather than a corner nook: the corridors of M9 join
 * rooms through these, and Borges' galleries connect by hallway.
 */
export const DOORWAY_SIDES = [0, 3] as const;

/** Side indices of the hexagon that carry shelves, in wall-index order. */
export const SHELF_SIDES = [1, 2, 4, 5] as const;
