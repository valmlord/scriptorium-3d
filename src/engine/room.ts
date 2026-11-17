import {
  BoxGeometry,
  CircleGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
} from 'three';
import { SHELVES_PER_WALL } from '@core/address';
import {
  PANEL_THICKNESS,
  ROOM_CIRCUMRADIUS,
  ROOM_HEIGHT,
  ROOM_WALL_WIDTH,
  SHELF_BOARD_THICKNESS,
  SHELF_DEPTH,
  SHELF_SIDES,
  SPINE_DEPTH,
  SPINE_HEIGHT,
  SPINE_WIDTH,
} from './constants';
import {
  SHELF_BOARDS_PER_ROOM,
  shelfBoardMatrix,
  spineMatrixForSlot,
  wallPanelMatrix,
} from './layout';
import { createLighting } from './lighting';
import { roomSeed, spineColorFromSeed } from './palette';
import { ResourceRegistry } from './resources';
import { roomInstanceColor, roomInstanceMatrix } from './scratch';
import { SPINES_PER_ROOM, occupiedSlotCount } from './slots';
import { createFloorTexture } from './textures';
import { createSpineTitleAtlas } from './titles';
import type { SpineTitleAtlas } from './titles';

/**
 * One room of the library, built from its address and nothing else.
 *
 * The hexagon of SPEC §3: four walls of five shelves of thirty-two volumes,
 * and two open sides. The 640 volumes are **one** `InstancedMesh` and one draw
 * call, as `docs/architecture.md` §3 requires — 640 meshes would be 640 draw
 * calls and 640 matrix uploads for objects that differ only in where they
 * stand and what colour they are.
 *
 * Nothing in here is random. Where a spine stands comes from `./layout.ts` and
 * what colour it is from `./palette.ts`, both pure functions of the address,
 * so entering a room twice shows the same room (`docs/architecture.md` §5, and
 * `__tests__/determinism.test.ts`).
 *
 * Everything allocated on the device is registered as it is created, and
 * `dispose()` releases all of it. That is not tidiness: WebGL memory is not
 * garbage collected, and the cost of forgetting is paid once per room the
 * reader walks through.
 */

/** Colours of the room's fabric. Bindings get theirs from the address. */
const WALL_COLOR = 0x5a4f3e;
const FLOOR_COLOR = 0x6b6050;
const CEILING_COLOR = 0x2b2620;
const SHELF_COLOR = 0x4a3524;

/** The two open sides of the hexagon, as four panels on the other four. */
const WALL_PANEL_COUNT = SHELF_SIDES.length;

/** A loaded room: its scene graph, its spines, and the means to let it go. */
export interface RoomHandle {
  /** Which room this is. */
  readonly room: bigint;
  /** The room's scene graph, for the caller to add to its scene. */
  readonly group: Group;
  /** The 640 volumes, as one instanced mesh. */
  readonly spines: InstancedMesh;
  /**
   * The titles on those spines, written a shelf at a time. Empty until the
   * first shelf is resolved, and allocating nothing until then (`./titles.ts`).
   */
  readonly titles: SpineTitleAtlas;
  /** How many of the 640 slots hold a volume that exists (SPEC §3). */
  readonly occupiedSlots: number;
  /** What this room allocated on the device. */
  readonly resources: ResourceRegistry;
  /** Release every geometry, material, texture and instance buffer created here. */
  dispose(): void;
}

/**
 * Build room `room`. Throws through `core` if there is no such room, before
 * anything is allocated.
 */
export function createRoom(room: bigint): RoomHandle {
  const occupiedSlots = occupiedSlotCount(room);
  const registry = new ResourceRegistry();

  const group = new Group();
  group.name = `room-${room.toString(36)}`;

  group.add(createShell(registry));
  group.add(createShelfBoards(registry));
  const { spines, material } = createSpines(room, occupiedSlots, registry);
  group.add(spines);
  group.add(createLighting(registry));
  const titles = createSpineTitleAtlas({ spines, material, registry });

  return {
    room,
    group,
    spines,
    titles,
    occupiedSlots,
    resources: registry,
    dispose: () => {
      registry.disposeAll();
      group.clear();
    },
  };
}

/** Floor, ceiling and the four closed walls. */
function createShell(registry: ResourceRegistry): Group {
  const shell = new Group();
  shell.name = 'shell';

  // One hexagonal plate serves both the floor and the ceiling: the same six
  // vertices, the ceiling's turned over. `Math.PI / 6` puts the plate's
  // vertices at the hexagon's corners, which is what makes its edges line up
  // with the wall panels instead of cutting across them.
  const plateGeometry = registry.track(
    new CircleGeometry(ROOM_CIRCUMRADIUS, 6, Math.PI / 6)
  );
  plateGeometry.rotateX(-Math.PI / 2);

  const floorTexture = registry.track(createFloorTexture());
  const floor = new Mesh(
    plateGeometry,
    registry.track(
      new MeshStandardMaterial({
        color: FLOOR_COLOR,
        map: floorTexture,
        roughness: 0.92,
        metalness: 0,
      })
    )
  );
  floor.name = 'floor';
  shell.add(floor);

  const ceiling = new Mesh(
    plateGeometry,
    registry.track(
      new MeshStandardMaterial({ color: CEILING_COLOR, roughness: 1, metalness: 0 })
    )
  );
  ceiling.name = 'ceiling';
  ceiling.position.y = ROOM_HEIGHT;
  // Turned over so its one face looks down into the room.
  ceiling.rotation.x = Math.PI;
  shell.add(ceiling);

  const panels = registry.track(
    new InstancedMesh(
      registry.track(new BoxGeometry(ROOM_WALL_WIDTH, ROOM_HEIGHT, PANEL_THICKNESS)),
      registry.track(
        new MeshStandardMaterial({ color: WALL_COLOR, roughness: 0.95, metalness: 0 })
      ),
      WALL_PANEL_COUNT
    )
  );
  panels.name = 'wall-panels';
  // Iterated over the sides themselves rather than by index, so the panel
  // count and the list of shelved sides cannot drift apart.
  for (const [index, side] of SHELF_SIDES.entries()) {
    panels.setMatrixAt(index, wallPanelMatrix(side, roomInstanceMatrix));
  }
  panels.instanceMatrix.needsUpdate = true;
  panels.computeBoundingSphere();
  shell.add(panels);

  return shell;
}

/** The twenty shelf boards: five on each of the four shelved walls. */
function createShelfBoards(registry: ResourceRegistry): InstancedMesh {
  const boards = registry.track(
    new InstancedMesh(
      registry.track(
        new BoxGeometry(ROOM_WALL_WIDTH, SHELF_BOARD_THICKNESS, SHELF_DEPTH)
      ),
      registry.track(
        new MeshStandardMaterial({ color: SHELF_COLOR, roughness: 0.72, metalness: 0 })
      ),
      SHELF_BOARDS_PER_ROOM
    )
  );
  boards.name = 'shelf-boards';

  for (let index = 0; index < SHELF_BOARDS_PER_ROOM; index += 1) {
    const wall = Math.floor(index / SHELVES_PER_WALL);
    const shelf = index % SHELVES_PER_WALL;
    boards.setMatrixAt(index, shelfBoardMatrix(wall, shelf, roomInstanceMatrix));
  }
  boards.instanceMatrix.needsUpdate = true;
  boards.computeBoundingSphere();

  return boards;
}

/**
 * The 640 volumes as one instanced mesh.
 *
 * The mesh is built at full capacity and drawn at `occupiedSlots`: in the
 * partially-filled last room (SPEC §3) the final slots stand for volumes with
 * no pages, and three.js draws the first `count` instances of the buffer. The
 * matrices and colours for the undrawn slots are written anyway, so that the
 * buffer is a function of the room alone and not of how much of it is shown.
 *
 * The material's own colour is white because three multiplies it into the
 * per-instance colour; anything else would tint all 640 bindings together.
 * It is handed back beside the mesh because the title atlas patches it, and
 * reading it off `InstancedMesh.material` would mean narrowing a union that
 * this function already knows the answer to.
 */
function createSpines(
  room: bigint,
  occupiedSlots: number,
  registry: ResourceRegistry
): { spines: InstancedMesh; material: MeshStandardMaterial } {
  const material = registry.track(
    new MeshStandardMaterial({ color: 0xffffff, roughness: 0.58, metalness: 0.02 })
  );
  const spines = registry.track(
    new InstancedMesh(
      registry.track(new BoxGeometry(SPINE_WIDTH, SPINE_HEIGHT, SPINE_DEPTH)),
      material,
      SPINES_PER_ROOM
    )
  );
  spines.name = 'spines';

  // Folded once, not once per spine: the room index runs to 16545 bits and
  // every one of them takes part (see `./palette.ts`).
  const fold = roomSeed(room);
  for (let slot = 0; slot < SPINES_PER_ROOM; slot += 1) {
    spines.setMatrixAt(slot, spineMatrixForSlot(slot, roomInstanceMatrix));
    spines.setColorAt(slot, spineColorFromSeed(fold, slot, roomInstanceColor));
  }
  spines.count = occupiedSlots;
  spines.instanceMatrix.needsUpdate = true;
  if (spines.instanceColor !== null) {
    spines.instanceColor.needsUpdate = true;
  }
  spines.computeBoundingSphere();

  return { spines, material };
}
