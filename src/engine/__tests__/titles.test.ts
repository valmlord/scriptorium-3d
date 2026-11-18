import { describe, expect, it } from 'vitest';
import { BoxGeometry, InstancedMesh, MeshStandardMaterial, Texture } from 'three';
import type { BufferAttribute, InterleavedBufferAttribute } from 'three';
import { BOOKS_PER_SHELF } from '@core/address';
import {
  ATLAS_BLANK_OFFSET,
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
    // each of those into a whole-atlas upload, measured at 3.2 to 4.4 ms of
    // one animation callback on an Apple M4 (ADR-0032).
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
