import {
  CanvasTexture,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  LinearFilter,
  SRGBColorSpace,
} from 'three';
import type { InstancedMesh, MeshStandardMaterial } from 'three';
import {
  ATLAS_BLANK_OFFSET,
  ATLAS_CELL_HEIGHT,
  ATLAS_CELL_SPAN,
  ATLAS_CELL_WIDTH,
  ATLAS_COLUMNS,
  ATLAS_HEIGHT,
  ATLAS_WIDTH,
  assertShelfTitleCount,
  cellOffset,
  createShelfRowAllocator,
  firstSlotOfShelf,
  shelfIndexOfFirstSlot,
} from './atlas';
import { Canvas2dUnavailableError } from './errors';
import type { ResourceRegistry } from './resources';
import { SPINES_PER_ROOM } from './slots';

/**
 * The spine titles: a canvas atlas, and a per-instance texture offset that
 * says which cell of it each of the 640 spines samples.
 *
 * **The 640 spines stay one `InstancedMesh` and one draw call**
 * (`docs/architecture.md` §3). That is the whole reason the titles arrive as
 * an atlas rather than as a texture per shelf: a texture per shelf is a
 * material per shelf and twenty draw calls growing as the reader walks the
 * room, and a plane per spine with a label on it is 640 of them. What varies
 * per instance is two floats in a buffer, which costs nothing per frame and
 * nothing per shelf.
 *
 * **Nothing exists until a title arrives.** The canvas, the texture, the
 * instance buffer and the shader patch are all created on the first shelf
 * resolved, so a room nobody has read a spine of is exactly the mesh M4 built,
 * and the arithmetic of the room stays testable without a browser
 * (`docs/testing.md` §1). This module is the part that needs a DOM; the
 * geometry of the atlas is `./atlas.ts`, which does not.
 *
 * **The material is patched rather than replaced.** `MeshStandardMaterial`
 * already multiplies its `map` into the per-instance colour, which is exactly
 * what a title on a coloured spine is: white ground leaves the binding's own
 * colour, dark glyphs darken it. The patch does one thing the stock shader
 * cannot, which is to read the map at a per-instance offset.
 *
 * The title appears on every face of the box, because a box's faces all carry
 * the same `uv`. Only the face towards the room is ever seen: the two next to
 * it are against neighbouring volumes, the back is against the wall, and the
 * ends are under the shelf board above and on the one below.
 */

/** The instanced attribute the patched shader reads. */
export const TITLE_OFFSET_ATTRIBUTE = 'titleAtlasOffset';

/** The ground a cell is cleared to. White, so the material's colour survives it. */
const ATLAS_GROUND = '#ffffff';

/** The ink a title is drawn in. Dark, so it reads on any binding colour. */
const TITLE_INK = '#1f1813';

/**
 * Type size in pixels, and the air at each end of the cell.
 *
 * A title is `TITLE_LENGTH` characters of a monospace face, whose advance is
 * about 0.6 em, so 25 characters at 15 px run about 225 px of the cell's
 * 256 px minus its margins. `fillText` is given the remaining width as a
 * backstop, so a face with a wider advance is condensed rather than clipped.
 */
const TITLE_FONT_SIZE = 15;
const TITLE_MARGIN = 10;

/** The same stack as the reader's, for the same reason: Cyrillic coverage. */
const TITLE_FONT = `${String(TITLE_FONT_SIZE)}px "DejaVu Sans Mono", "Liberation Mono", Menlo, Consolas, monospace`;

/** The spine titles of one room. */
export interface SpineTitleAtlas {
  /**
   * Draw the 32 titles of the shelf beginning at `firstSlot` and point its
   * spines at them. The first call builds the atlas.
   */
  setShelfTitles(firstSlot: number, titles: readonly string[]): void;
  /** The shelves whose titles the atlas currently holds. */
  readonly shelvesHeld: readonly number[];
}

/** What the atlas writes into. */
export interface SpineTitleAtlasOptions {
  /** The room's spines: the mesh whose instance buffer gains the offsets. */
  readonly spines: InstancedMesh;
  /** The spines' material, patched to read the atlas at those offsets. */
  readonly material: MeshStandardMaterial;
  /** The room's registry, which owns the texture once it exists. */
  readonly registry: ResourceRegistry;
}

/** What the atlas allocates on the device, once there is a title to draw. */
interface AtlasDevice {
  readonly context: CanvasRenderingContext2D;
  readonly texture: CanvasTexture;
  readonly offsets: InstancedBufferAttribute;
}

/** Build the atlas for one room's spines. Allocates nothing until used. */
export function createSpineTitleAtlas(
  options: SpineTitleAtlasOptions
): SpineTitleAtlas {
  const { spines, material, registry } = options;
  const allocator = createShelfRowAllocator();
  let device: AtlasDevice | null = null;

  return {
    get shelvesHeld(): readonly number[] {
      return allocator.held;
    },

    setShelfTitles(firstSlot: number, titles: readonly string[]): void {
      // Refused before anything is allocated or drawn, so a bad call leaves
      // the atlas as it was rather than part-written.
      const shelf = shelfIndexOfFirstSlot(firstSlot);
      assertShelfTitleCount(titles.length);

      const atlas = device ?? materialize();
      device = atlas;

      const claim = allocator.claim(shelf);
      if (claim.evicted !== null) {
        // Its row is about to hold another shelf's titles, so its spines go
        // back to the blank cell rather than to a book they are not.
        pointShelfAtBlank(atlas.offsets, claim.evicted);
      }
      drawShelf(atlas.context, claim.row, titles);
      pointShelfAtRow(atlas.offsets, shelf, claim.row);
      atlas.offsets.needsUpdate = true;
      atlas.texture.needsUpdate = true;
    },
  };

  /** Create the canvas, the texture and the instance buffer, and patch the material. */
  function materialize(): AtlasDevice {
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_WIDTH;
    canvas.height = ATLAS_HEIGHT;
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Canvas2dUnavailableError();
    }
    // Cleared to the ground colour in one go, which is what makes the blank
    // row blank and what an unclaimed row stays.
    context.fillStyle = ATLAS_GROUND;
    context.fillRect(0, 0, ATLAS_WIDTH, ATLAS_HEIGHT);

    const texture = registry.track(new CanvasTexture(canvas));
    texture.colorSpace = SRGBColorSpace;
    // No mipmaps: a mipmap of this atlas averages across cell boundaries, so a
    // spine at a distance would show the smear of its neighbours' titles. It
    // also keeps a non-power-of-two atlas legal without a resize.
    texture.generateMipmaps = false;
    texture.minFilter = LinearFilter;

    const offsets = new InstancedBufferAttribute(
      new Float32Array(SPINES_PER_ROOM * 2),
      2
    );
    offsets.setUsage(DynamicDrawUsage);
    for (let slot = 0; slot < SPINES_PER_ROOM; slot += 1) {
      offsets.setXY(slot, ATLAS_BLANK_OFFSET.u, ATLAS_BLANK_OFFSET.v);
    }
    spines.geometry.setAttribute(TITLE_OFFSET_ATTRIBUTE, offsets);

    material.map = texture;
    material.onBeforeCompile = patchShader;
    material.needsUpdate = true;

    return { context, texture, offsets };
  }
}

/**
 * Read the map at the instance's own offset instead of at the texture's
 * origin.
 *
 * Two insertions and one replacement, each at an `#include` three.js resolves
 * after this hook runs. The cell's span is written in as a literal because the
 * atlas has one shape for the life of the program (`./atlas.ts`); a uniform
 * would be a second place for the same two numbers to live.
 */
function patchShader(shader: { vertexShader: string; fragmentShader: string }): void {
  shader.vertexShader = shader.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
      attribute vec2 ${TITLE_OFFSET_ATTRIBUTE};
      varying vec2 vTitleAtlasOffset;`
    )
    .replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
      vTitleAtlasOffset = ${TITLE_OFFSET_ATTRIBUTE};`
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      varying vec2 vTitleAtlasOffset;`
    )
    .replace(
      '#include <map_fragment>',
      `vec2 titleUv = vTitleAtlasOffset + vMapUv * vec2(${glslFloat(ATLAS_CELL_SPAN.u)}, ${glslFloat(ATLAS_CELL_SPAN.v)});
      diffuseColor *= texture2D( map, titleUv );`
    );
}

/** A number as a GLSL float literal, which needs its decimal point. */
function glslFloat(value: number): string {
  return value.toFixed(8);
}

/** Draw a whole shelf of titles into `row`, one cell per volume. */
function drawShelf(
  context: CanvasRenderingContext2D,
  row: number,
  titles: readonly string[]
): void {
  for (const [column, title] of titles.entries()) {
    drawTitle(context, row, column, title);
  }
}

/**
 * Draw one title into the cell at `row` and `column`.
 *
 * Turned a quarter turn anticlockwise, so the title runs up the spine as it
 * does on a shelf of books. In canvas coordinates that is the direction of
 * decreasing `y`, which after three.js' `flipY` upload is the direction of
 * increasing `v`, which is up the spine in the room.
 */
function drawTitle(
  context: CanvasRenderingContext2D,
  row: number,
  column: number,
  title: string
): void {
  const left = column * ATLAS_CELL_WIDTH;
  const top = row * ATLAS_CELL_HEIGHT;

  context.fillStyle = ATLAS_GROUND;
  context.fillRect(left, top, ATLAS_CELL_WIDTH, ATLAS_CELL_HEIGHT);

  context.save();
  context.translate(
    left + ATLAS_CELL_WIDTH / 2,
    top + ATLAS_CELL_HEIGHT - TITLE_MARGIN
  );
  context.rotate(-Math.PI / 2);
  context.fillStyle = TITLE_INK;
  context.font = TITLE_FONT;
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  context.fillText(title, 0, 0, ATLAS_CELL_HEIGHT - 2 * TITLE_MARGIN);
  context.restore();
}

/**
 * Point the spines of `shelf` at the cells of `row`, volume by volume.
 *
 * Every column is written, including those of a shelf the library ends
 * part-way along (SPEC §3): the instance buffer holds all 640 slots and the
 * mesh draws the first `occupiedSlots` of them (`./room.ts`), so the buffer
 * stays a function of the shelf rather than of how much of it is shown.
 */
function pointShelfAtRow(
  offsets: InstancedBufferAttribute,
  shelf: number,
  row: number
): void {
  const firstSlot = firstSlotOfShelf(shelf);
  for (let column = 0; column < ATLAS_COLUMNS; column += 1) {
    const offset = cellOffset(row, column);
    offsets.setXY(firstSlot + column, offset.u, offset.v);
  }
}

/** Point the spines of `shelf` back at the blank cell. */
function pointShelfAtBlank(offsets: InstancedBufferAttribute, shelf: number): void {
  const firstSlot = firstSlotOfShelf(shelf);
  for (let column = 0; column < ATLAS_COLUMNS; column += 1) {
    offsets.setXY(firstSlot + column, ATLAS_BLANK_OFFSET.u, ATLAS_BLANK_OFFSET.v);
  }
}
