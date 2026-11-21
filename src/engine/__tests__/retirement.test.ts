import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createRetirement } from '@engine/retirement';
import type { Disposable, Retirement } from '@engine/retirement';

/**
 * The retirement policy, without WebGL: a room is anything with a `dispose`,
 * and the rooms here count their disposals.
 *
 * "Titled" always means that some `noteRender(true)` was reported while that
 * room was loaded, and "load B" means `replace(<the room before B>)`, which is
 * what the stand-in below does in the order `viewer.ts` does it. Where the
 * viewer calls `noteRender` is not this file's to see; the `renderFrame` scan
 * in `render-frame.test.ts` guards it.
 *
 * The property case counts are written out rather than routed through
 * `src/core/__tests__/property-runs.ts`, for the reason `handler.test.ts`
 * gives: that cap applies under Stryker, which collects only `src/core`.
 */

/** A room that records how many times it was released. */
class CountedRoom implements Disposable {
  disposals = 0;

  dispose(): void {
    this.disposals += 1;
  }
}

/** The viewer's side of the interface: it holds the loaded room, the policy the rest. */
interface ViewerStandIn {
  readonly retirement: Retirement;
  /** Every room loaded so far, in order. */
  readonly rooms: readonly CountedRoom[];
  /** Load a new room in place of the loaded one, and return it. */
  load(): CountedRoom;
  /** Report a render of the loaded room. */
  render(isTitled: boolean): void;
}

function createViewerStandIn(): ViewerStandIn {
  const retirement = createRetirement();
  const rooms: CountedRoom[] = [];
  let loaded: CountedRoom | null = null;
  return {
    retirement,
    rooms,
    load(): CountedRoom {
      const next = new CountedRoom();
      retirement.replace(loaded);
      loaded = next;
      rooms.push(next);
      return next;
    },
    render(isTitled: boolean): void {
      retirement.noteRender(isTitled);
    },
  };
}

/** One step of a session: a room loaded, or a render reported. */
type Step =
  { readonly kind: 'load' } | { readonly kind: 'render'; readonly isTitled: boolean };

const arbitraryStep: fc.Arbitrary<Step> = fc.oneof(
  fc.constant<Step>({ kind: 'load' }),
  fc.boolean().map((isTitled): Step => ({ kind: 'render', isTitled }))
);

const arbitrarySession: fc.Arbitrary<Step[]> = fc.array(arbitraryStep, {
  maxLength: 40,
});

function run(viewer: ViewerStandIn, step: Step): void {
  if (step.kind === 'load') {
    viewer.load();
  } else {
    viewer.render(step.isTitled);
  }
}

/** The replaced rooms nothing has released yet: the loaded room is not one. */
function retained(viewer: ViewerStandIn): readonly CountedRoom[] {
  return viewer.rooms.slice(0, -1).filter((room) => room.disposals === 0);
}

describe('the retirement policy', () => {
  it('the first replace, with null, retires nothing', () => {
    const retirement = createRetirement();

    retirement.replace(null);

    expect(retirement.isOccupied).toBe(false);
  });

  it('of two untitled rooms replaced with no render between, the older is disposed and the newer retires', () => {
    const viewer = createViewerStandIn();
    const a = viewer.load();
    const b = viewer.load();

    viewer.load();

    expect(a.disposals).toBe(1);
    expect(b.disposals).toBe(0);
    expect(viewer.retirement.isOccupied).toBe(true);
  });

  it('the slot holds at most one room', () => {
    fc.assert(
      fc.property(arbitrarySession, (session) => {
        const viewer = createViewerStandIn();

        for (const step of session) {
          run(viewer, step);

          expect(retained(viewer).length).toBeLessThanOrEqual(1);
          expect(retained(viewer).length).toBe(viewer.retirement.isOccupied ? 1 : 0);
        }
      }),
      { numRuns: 1000 }
    );
  });

  it('a room entering the slot is disposed exactly once', () => {
    fc.assert(
      fc.property(arbitrarySession, (session) => {
        const viewer = createViewerStandIn();
        for (const step of session) {
          run(viewer, step);
        }

        viewer.retirement.dispose();

        // The loaded room is the viewer's to release, so the policy never has.
        const replaced = viewer.rooms.slice(0, -1);
        expect(replaced.map((room) => room.disposals)).toEqual(replaced.map(() => 1));
        expect(viewer.rooms.at(-1)?.disposals ?? 0).toBe(0);
      }),
      { numRuns: 1000 }
    );
  });

  it('A titled, B untitled, then C: A stays, B is disposed at once', () => {
    const viewer = createViewerStandIn();
    const a = viewer.load();
    viewer.render(true);
    const b = viewer.load();
    viewer.render(false);

    viewer.load();

    expect(a.disposals).toBe(0);
    expect(b.disposals).toBe(1);
    expect(viewer.retirement.isOccupied).toBe(true);
  });

  it('A untitled, B titled, then C: A is disposed and B retires', () => {
    const viewer = createViewerStandIn();
    const a = viewer.load();
    viewer.render(false);
    const b = viewer.load();
    viewer.render(true);

    viewer.load();

    expect(a.disposals).toBe(1);
    expect(b.disposals).toBe(0);
    expect(viewer.retirement.isOccupied).toBe(true);
  });

  it('the titled flag is reset when a room is replaced', () => {
    const viewer = createViewerStandIn();
    const a = viewer.load();
    viewer.render(true);
    viewer.load();

    viewer.render(false);

    // B has not rendered with titles, so A still holds the titled program.
    expect(a.disposals).toBe(0);
    expect(viewer.retirement.isOccupied).toBe(true);
  });

  it('A titled, B titled, then C: B retires', () => {
    const viewer = createViewerStandIn();
    const a = viewer.load();
    viewer.render(true);
    const b = viewer.load();
    viewer.render(true);

    viewer.load();

    expect(a.disposals).toBe(1);
    expect(b.disposals).toBe(0);
    expect(viewer.retirement.isOccupied).toBe(true);
  });

  it('a titled retiring room survives any number of swaps to untitled rooms', () => {
    const viewer = createViewerStandIn();
    const a = viewer.load();
    viewer.render(true);
    const b = viewer.load();
    viewer.render(false);
    const c = viewer.load();

    expect(b.disposals).toBe(1);
    expect(c.disposals).toBe(0);

    viewer.render(false);
    viewer.load();

    expect(c.disposals).toBe(1);
    expect(a.disposals).toBe(0);
    expect(viewer.retirement.isOccupied).toBe(true);
  });

  it.each([
    { retiringTitled: true, renderTitled: true, released: true },
    { retiringTitled: true, renderTitled: false, released: false },
    { retiringTitled: false, renderTitled: true, released: true },
    { retiringTitled: false, renderTitled: false, released: true },
  ])(
    'after a render, the retiring room is released only when the loaded room is titled, or when the retiring room itself is not (retiring titled: $retiringTitled, render titled: $renderTitled)',
    ({ retiringTitled, renderTitled, released }) => {
      const viewer = createViewerStandIn();
      const retiring = viewer.load();
      viewer.render(retiringTitled);
      viewer.load();

      viewer.render(renderTitled);

      expect(retiring.disposals).toBe(released ? 1 : 0);
      expect(viewer.retirement.isOccupied).toBe(!released);
    }
  );

  it('dispose disposes the retiring room and empties the slot', () => {
    const viewer = createViewerStandIn();
    const a = viewer.load();
    viewer.render(true);
    viewer.load();

    viewer.retirement.dispose();

    expect(a.disposals).toBe(1);
    expect(viewer.retirement.isOccupied).toBe(false);
  });
});
