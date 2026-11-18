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
  /**
   * Where the canvas comes from. The document, unless a caller says otherwise.
   *
   * Injected for the same reason `GenerationClient` takes a worker rather than
   * making one: everything this module *decides* — which cell a spine samples,
   * which shelf is redrawn, what is released on unload — is decided around the
   * drawing rather than inside it, and a test of those decisions should not
   * need a browser (`docs/testing.md` §1). `__tests__/titles.test.ts` passes a
   * canvas that records what was drawn on it.
   */
  readonly createCanvas?: () => HTMLCanvasElement;
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
  const createCanvas = options.createCanvas ?? fromDocument;
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

      if (allocator.rowOf(shelf) !== undefined) {
        // Already drawn, and its spines already point at it. A title is a pure
        // function of its address (SPEC §4), so redrawing it would change
        // nothing and cost a whole-atlas upload: three.js has no partial path
        // for a `CanvasTexture`, so `needsUpdate` sends all 1024 by 2048
        // pixels. That is milliseconds of one animation callback where a turn
        // otherwise costs tenths; ADR-0032 holds the measurement, and the
        // redraw itself is the cheap half of it.
        //
        // This is what makes `./atlas.ts`'s "a row is never redrawn while it
        // is held" true rather than aspirational, and it is why a caller may
        // ask for the same shelf as often as it likes: `@app`'s resolver does,
        // on every navigation event inside a shelf, and that re-ask is what
        // redraws a shelf the atlas has since evicted.
        return;
      }

      // Note on the order below: the row is claimed before it is painted,
      // where the refusals above are taken before anything is allocated. A
      // canvas call throwing between the two would leave `shelvesHeld`
      // claiming a row that was never drawn, and `@app`'s resolver asks the
      // atlas what it holds before asking for a shelf, so that shelf would
      // stay blank for as long as the room is loaded. The claim has to come
      // first, because the row number is what the drawing needs; closing it
      // properly means releasing the row if the draw throws, and the draw is
      // `fillRect`, `fillText` and `font` on a real 2D context, none of which
      // throws. Recorded rather than guarded, so the next person to add a
      // drawing call that can fail knows what it would cost.
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
    const canvas = createCanvas();
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
    // No mipmaps: a mip level whose footprint is wider than a 32 px cell
    // averages across cell boundaries, so a distant spine would show the
    // smear of its neighbours' titles rather than its own. `LinearFilter` is
    // then required, because the default minification filter wants the chain
    // that no longer exists.
    //
    // The price, which is real and accepted: minifying without a chain
    // aliases, so a title shimmers as the camera moves and 640 instances
    // sample the atlas with poorer cache locality. The level of detail this
    // project budgets is on *generation* (`architecture.md` §3) and that is
    // handled by resolving a shelf only at shelf level and below; sampling has
    // none, and a mip chain built per cell is what it would take.
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

/** The canvas the atlas draws into when nobody has said otherwise. */
function fromDocument(): HTMLCanvasElement {
  return document.createElement('canvas');
}

/**
 * Read the map at the instance's own offset instead of at the texture's
 * origin.
 *
 * Three insertions and one replacement, each at an `#include` three.js
 * resolves after this hook runs: the attribute and its varying into the vertex
 * shader, the assignment where the uvs are computed, the varying into the
 * fragment shader, and the map read itself replaced. The cell's span is
 * written in as a literal because the atlas has one shape for the life of the
 * program (`./atlas.ts`); a uniform would be a second place for the same two
 * numbers to live.
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
