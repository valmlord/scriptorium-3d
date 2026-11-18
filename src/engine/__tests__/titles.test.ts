import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  InstancedMesh,
  MeshStandardMaterial,
  ShaderLib,
  Texture,
} from 'three';
import type { BufferAttribute, InterleavedBufferAttribute } from 'three';
import { BOOKS_PER_SHELF } from '@core/address';
import {
  ATLAS_BLANK_OFFSET,
  ATLAS_CELL_SPAN,
  ATLAS_SHELF_ROWS,
  cellOffset,
  firstSlotOfShelf,
} from '@engine/atlas';
import { ResourceRegistry } from '@engine/resources';
import { SPINES_PER_ROOM } from '@engine/slots';
import { TITLE_OFFSET_ATTRIBUTE, createSpineTitleAtlas } from '@engine/titles';

/**
 * Which title a spine shows, and what the atlas costs to keep saying it.
 *
 * The arithmetic is `__tests__/atlas.test.ts`; what is here is the *wiring* —
 * the step from "shelf 3's titles arrived" to "these 32 spines sample these 32
 * cells" — which had no assertion on either side until the judges of #44 said
 * so. It is testable without a browser because the canvas is injected
 * (`../titles.ts`): a recording stand-in answers the drawing calls, and every
 * decision this file asserts is taken around them rather than inside them.
 *
 * The shader patch is here too, and it is the part that had nothing. It is
 * four `String.replace` calls against three.js' own chunk names, and a
 * `replace` whose needle stops matching returns the string unchanged and says
 * nothing: the GLSL still compiles, the atlas still uploads, the room still
 * draws in one call, and every spine in it samples the wrong cell. So the
 * patch is driven here over `ShaderLib.physical`, which is a pair of plain
 * strings, and each of the four sites carries an assertion that goes red if
 * its needle stops matching.
 *
 * Nothing here draws a pixel or needs a GPU. What a title *looks* like is not
 * assertable without one and is not asserted anywhere.
 */

/** What was drawn on the stand-in canvas, in the order it was asked for. */
interface Drawn {
  /** One entry per `fillText`: the title, and the cell it was drawn into. */
  readonly titles: { text: string; x: number; y: number }[];
  /** How many times a cell was cleared. */
  cleared: number;
}

/** A canvas that records the drawing instead of performing it. */
function recordingCanvas(drawn: Drawn): HTMLCanvasElement {
  let translated = { x: 0, y: 0 };
  const context = {
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    save: () => undefined,
    restore: () => undefined,
    rotate: () => undefined,
    translate: (x: number, y: number) => {
      translated = { x, y };
    },
    fillRect: () => {
      drawn.cleared += 1;
    },
    fillText: (text: string) => {
      drawn.titles.push({ text, x: translated.x, y: translated.y });
    },
  };

  // A stand-in for the eleven members `drawTitle` uses, cast once and
  // deliberately: the alternative is a structural canvas type in the engine's
  // own signature, which would move the cast into the code that ships.
  return {
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
}

/** A room's spines, its material, and an atlas over a recording canvas. */
function atlasOverRecordingCanvas(): {
  atlas: ReturnType<typeof createSpineTitleAtlas>;
  drawn: Drawn;
  registry: ResourceRegistry;
  spines: InstancedMesh;
  material: MeshStandardMaterial;
} {
  const drawn: Drawn = { titles: [], cleared: 0 };
  const registry = new ResourceRegistry();
  const material = registry.track(new MeshStandardMaterial());
  const spines = registry.track(
    new InstancedMesh(registry.track(new BoxGeometry()), material, SPINES_PER_ROOM)
  );
  const atlas = createSpineTitleAtlas({
    spines,
    material,
    registry,
    createCanvas: () => recordingCanvas(drawn),
  });
  return { atlas, drawn, registry, spines, material };
}

/** The titles of one shelf, distinguishable per shelf and per volume. */
function titlesOf(shelf: number): readonly string[] {
  return Array.from(
    { length: BOOKS_PER_SHELF },
    (_unused, volume) => `s${String(shelf)}v${String(volume)}`
  );
}

/** The atlas cell instance `slot` samples, as the offset attribute holds it. */
function offsetAt(spines: InstancedMesh, slot: number): { u: number; v: number } {
  // `getAttribute` is typed as always returning one and returns `undefined`
  // for an attribute that was never set, which is the state this file asserts
  // on before the first shelf arrives (and what `disposal.test.ts` checks).
  const offsets = spines.geometry.getAttribute(TITLE_OFFSET_ATTRIBUTE) as
    BufferAttribute | InterleavedBufferAttribute | undefined;
  if (offsets === undefined) {
    throw new Error('the spines carry no title offsets');
  }
  return { u: offsets.getX(slot), v: offsets.getY(slot) };
}

describe('the titles of a shelf', () => {
  it('points every spine of the shelf at its own cell, in volume order', () => {
    const { atlas, spines } = atlasOverRecordingCanvas();

    atlas.setShelfTitles(firstSlotOfShelf(3), titlesOf(3));

    const first = firstSlotOfShelf(3);
    const row = atlas.shelvesHeld.includes(3) ? 1 : -1;
    expect(row).toBe(1);
    for (let volume = 0; volume < BOOKS_PER_SHELF; volume += 1) {
      const expected = cellOffset(row, volume);
      expect(offsetAt(spines, first + volume)).toEqual({
        u: expect.closeTo(expected.u, 10),
        v: expect.closeTo(expected.v, 10),
      });
    }
  });

  it('leaves every other spine of the room pointing at the blank cell', () => {
    const { atlas, spines } = atlasOverRecordingCanvas();

    atlas.setShelfTitles(firstSlotOfShelf(3), titlesOf(3));

    const first = firstSlotOfShelf(3);
    for (const slot of [0, first - 1, first + BOOKS_PER_SHELF, SPINES_PER_ROOM - 1]) {
      expect(offsetAt(spines, slot)).toEqual({
        u: expect.closeTo(ATLAS_BLANK_OFFSET.u, 10),
        v: expect.closeTo(ATLAS_BLANK_OFFSET.v, 10),
      });
    }
  });

  it('draws each title once, into the cell its own volume owns', () => {
    const { atlas, drawn } = atlasOverRecordingCanvas();

    atlas.setShelfTitles(firstSlotOfShelf(0), titlesOf(0));

    expect(drawn.titles.map((entry) => entry.text)).toEqual([...titlesOf(0)]);
    // The whole canvas is cleared to its ground colour once, which is what
    // makes the blank row blank, and then one cell per title.
    expect(drawn.cleared).toBe(BOOKS_PER_SHELF + 1);
    expect(
      new Set(drawn.titles.map((entry) => `${String(entry.x)},${String(entry.y)}`)).size
    ).toBe(BOOKS_PER_SHELF);
  });
});

describe('a shelf the atlas already holds', () => {
  it('is not redrawn, and does not upload the atlas again', () => {
    // The defect this test exists for: the resolver re-asks for the shelf on
    // every navigation event inside it, and an unconditional redraw turned
    // each of those into a whole-atlas upload, which is milliseconds of one
    // animation callback where a turn otherwise costs tenths. ADR-0032 holds
    // the measurement and is the only place that states it.
    const { atlas, drawn, spines } = atlasOverRecordingCanvas();
    atlas.setShelfTitles(firstSlotOfShelf(2), titlesOf(2));
    const texture = textureOf(spines);
    const afterFirst = { titles: drawn.titles.length, version: texture.version };

    atlas.setShelfTitles(firstSlotOfShelf(2), titlesOf(2));
    atlas.setShelfTitles(firstSlotOfShelf(2), titlesOf(2));

    expect(drawn.titles).toHaveLength(afterFirst.titles);
    expect(texture.version).toBe(afterFirst.version);
  });

  it('still points its spines at their cells afterwards', () => {
    const { atlas, spines } = atlasOverRecordingCanvas();
    atlas.setShelfTitles(firstSlotOfShelf(2), titlesOf(2));
    const before = offsetAt(spines, firstSlotOfShelf(2) + 7);

    atlas.setShelfTitles(firstSlotOfShelf(2), titlesOf(2));

    expect(offsetAt(spines, firstSlotOfShelf(2) + 7)).toEqual(before);
  });
});

describe('a shelf the atlas has evicted', () => {
  /** Fill every shelf row, then one more, which displaces the first. */
  function fillAndDisplace(atlas: ReturnType<typeof createSpineTitleAtlas>): void {
    for (let shelf = 0; shelf <= ATLAS_SHELF_ROWS; shelf += 1) {
      atlas.setShelfTitles(firstSlotOfShelf(shelf), titlesOf(shelf));
    }
  }

  it('points the displaced shelf back at the blank cell', () => {
    const { atlas, spines } = atlasOverRecordingCanvas();

    fillAndDisplace(atlas);

    // Rows are taken in turn, so the shelf that goes is the first claimed.
    expect(atlas.shelvesHeld).not.toContain(0);
    for (let volume = 0; volume < BOOKS_PER_SHELF; volume += 1) {
      expect(offsetAt(spines, firstSlotOfShelf(0) + volume)).toEqual({
        u: expect.closeTo(ATLAS_BLANK_OFFSET.u, 10),
        v: expect.closeTo(ATLAS_BLANK_OFFSET.v, 10),
      });
    }
  });

  it('is drawn again when it is asked for again', () => {
    // Which is why the resolver asking again on every event is not waste: it
    // is what brings an evicted shelf back.
    const { atlas, drawn, spines } = atlasOverRecordingCanvas();
    fillAndDisplace(atlas);
    const drawnBefore = drawn.titles.length;

    atlas.setShelfTitles(firstSlotOfShelf(0), titlesOf(0));

    expect(drawn.titles).toHaveLength(drawnBefore + BOOKS_PER_SHELF);
    expect(atlas.shelvesHeld).toContain(0);
    expect(offsetAt(spines, firstSlotOfShelf(0))).not.toEqual({
      u: expect.closeTo(ATLAS_BLANK_OFFSET.u, 10),
      v: expect.closeTo(ATLAS_BLANK_OFFSET.v, 10),
    });
  });
});

describe('what the atlas puts on the device', () => {
  it('allocates nothing until a shelf arrives', () => {
    const { atlas, registry, spines } = atlasOverRecordingCanvas();
    const before = registry.size;

    expect(atlas.shelvesHeld).toEqual([]);
    expect(spines.geometry.getAttribute(TITLE_OFFSET_ATTRIBUTE)).toBeUndefined();
    expect(registry.size).toBe(before);
  });

  it('registers the texture it creates, so unloading the room releases it', () => {
    // `docs/architecture.md` §3: WebGL memory is not garbage collected, and
    // the texture is the one device resource M6 adds. Asserted by three.js'
    // own `dispose` event rather than by a spy on the method.
    const { atlas, registry, spines } = atlasOverRecordingCanvas();
    atlas.setShelfTitles(firstSlotOfShelf(1), titlesOf(1));
    const texture = textureOf(spines);
    let released = false;
    texture.addEventListener('dispose', () => {
      released = true;
    });

    registry.disposeAll();

    expect(released).toBe(true);
  });
});

describe('the shader the spines are drawn with', () => {
  it('declares the per-instance offset and carries it through to the fragment', () => {
    const { vertexShader, fragmentShader } = patchedShaders();

    // One assertion per insertion site. The first two are the vertex shader's
    // `#include <common>` and `#include <uv_vertex>`; the third is the
    // fragment shader's own `#include <common>`. An unmatched needle inserts
    // nothing, so each of these is what tells us its marker still exists.
    expect(vertexShader).toContain(`attribute vec2 ${TITLE_OFFSET_ATTRIBUTE};`);
    expect(vertexShader).toContain('varying vec2 vTitleAtlasOffset;');
    expect(vertexShader).toContain(`vTitleAtlasOffset = ${TITLE_OFFSET_ATTRIBUTE};`);
    expect(fragmentShader).toContain('varying vec2 vTitleAtlasOffset;');
  });

  it('replaces the map read rather than adding a second one', () => {
    const { fragmentShader } = patchedShaders();

    // The decisive assertion of the four, and the only one a non-matching
    // needle cannot fake: the marker has to be *gone*. Everything else about
    // the patch is an insertion, and text that was never inserted leaves the
    // shader valid; a `#include <map_fragment>` left standing would sample the
    // texture at its origin and then be multiplied by the cell read as well.
    expect(fragmentShader).not.toContain('#include <map_fragment>');
    expect(fragmentShader).toContain('diffuseColor *= texture2D( map, titleUv );');
  });

  it('scales the cell by the atlas span, taken from the atlas rather than restated', () => {
    const { fragmentShader } = patchedShaders();

    // Read back out of the GLSL and compared with the constant, so that a cell
    // span changed in `./atlas.ts` and not in the patch is a failure here
    // rather than a room of spines each showing a slice of its neighbour.
    const span = /vMapUv \* vec2\((-?\d+\.\d+), (-?\d+\.\d+)\)/.exec(fragmentShader);
    if (span === null) {
      throw new Error('the patched shader does not scale the uv by a vec2 literal');
    }
    expect(Number(span[1])).toBeCloseTo(ATLAS_CELL_SPAN.u, 8);
    expect(Number(span[2])).toBeCloseTo(ATLAS_CELL_SPAN.v, 8);
  });

  it('is installed only once the atlas exists, so a titleless room compiles the stock program', () => {
    // The other half of `disposal.test.ts`'s claim that a room nobody has read
    // a spine of allocates nothing: an `onBeforeCompile` installed eagerly
    // would patch a program that has no map to sample.
    //
    // Compared against three.js' own hook rather than against `undefined`:
    // `Material` carries a no-op `onBeforeCompile` on its prototype, so the
    // property is a function either way and the question is whose.
    const stockHook = compileHookOf(new MeshStandardMaterial());
    const { atlas, material } = atlasOverRecordingCanvas();

    expect(compileHookOf(material)).toBe(stockHook);

    atlas.setShelfTitles(firstSlotOfShelf(0), titlesOf(0));

    expect(compileHookOf(material)).not.toBe(stockHook);
  });
});

/**
 * three.js' own standard-material shaders, put through the patch the atlas
 * installs.
 *
 * `ShaderLib.physical` is what `MeshStandardMaterial` compiles from, and it is
 * two plain strings, so this needs neither a renderer nor a context. The hook
 * is read off the material rather than imported, because what ships is the
 * assignment in `materialize()` and not the function's name.
 */
function patchedShaders(): PatchableShaders {
  const { atlas, material } = atlasOverRecordingCanvas();
  atlas.setShelfTitles(firstSlotOfShelf(0), titlesOf(0));
  const patch = compileHookOf(material);

  const shaders: PatchableShaders = {
    vertexShader: ShaderLib.physical.vertexShader,
    fragmentShader: ShaderLib.physical.fragmentShader,
  };
  // three.js types the hook's parameter as the whole program-parameters
  // object; the patch reads the two shader strings and nothing else, and the
  // second argument is the renderer, which it never touches. Narrowed here
  // rather than by widening the engine's own signature, which is the shape the
  // hook has to have to be assignable at all.
  (patch as (shaders: PatchableShaders) => void)(shaders);
  return shaders;
}

/** The two members of three.js' shader object that the patch rewrites. */
interface PatchableShaders {
  vertexShader: string;
  fragmentShader: string;
}

/**
 * The compile hook installed on `material`, read as a value.
 *
 * `unbound-method` objects to reading a method off an object, and reading it
 * off is the whole point here: these tests ask *which* function is installed
 * and then call the installed one on a shader object of their own. Both
 * candidates are plain functions - three.js' no-op on `Material.prototype` and
 * the atlas's own patch - and neither touches `this`, which is what makes the
 * rule's warning inapplicable rather than merely inconvenient. Returned as
 * `unknown` so the call site narrows deliberately.
 */
function compileHookOf(material: MeshStandardMaterial): unknown {
  /* eslint-disable-next-line @typescript-eslint/unbound-method --
     See the paragraph above: the detachment is the subject, not an accident. */
  return material.onBeforeCompile;
}

/** The atlas texture the material samples, once there is one. */
function textureOf(spines: InstancedMesh): Texture {
  const { material } = spines;
  if (Array.isArray(material) || !(material instanceof MeshStandardMaterial)) {
    throw new Error('the spines do not carry a single standard material');
  }
  const { map } = material;
  if (map === null) {
    throw new Error('the spines’ material carries no atlas texture');
  }
  return map;
}
