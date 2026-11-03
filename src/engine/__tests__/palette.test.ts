import { describe, expect, it } from 'vitest';
import { Color, SRGBColorSpace } from 'three';
import {
  BOOKS_PER_SHELF,
  PAGES_PER_BOOK,
  PAGES_PER_ROOM,
  ROOM_COUNT,
  SHELVES_PER_WALL,
  WALLS_PER_ROOM,
} from '@core/address';
import { roomSeed, spineColor, spineColorFromSeed, spineSeed } from '@engine/palette';
import { SPINES_PER_ROOM, slotToBookAddress } from '@engine/slots';

/**
 * A binding's colour is a function of its address (`docs/architecture.md` §3
 * and §5). Two things have to hold: the same volume is the same colour
 * forever, and a shelf of 32 volumes does not read as a gradient.
 *
 * The second is the one that needs measuring. Hue taken straight from the
 * linear index gives neighbouring volumes a *constant* hue step — the index
 * differs by `PAGES_PER_BOOK` and nothing else — so a shelf paints as a smooth
 * ramp. `baselineRampHue` below is that function, and it is asserted to have
 * exactly one distinct step between neighbours, so this file holds the
 * counterexample it is defending against rather than describing it.
 */

/** Rooms the figures below were measured over. */
const ROOMS: readonly bigint[] = [
  0n,
  1n,
  2n,
  7n,
  42n,
  1_000_003n,
  0x5f3759dfn,
  ROOM_COUNT - 2n,
  ROOM_COUNT - 1n,
];

/** Hue buckets the 640 bindings of a room are counted into. */
const HUE_BUCKETS = 16;

/**
 * Measured bounds, from the sweep over `ROOMS` recorded in this milestone's
 * pull request. Expected occupancy is 40 per bucket with a standard deviation
 * of 6.1, and the sweep spanned 28 to 56; the bounds here are that with room
 * for one more standard deviation either side. A change to the mixing function
 * is expected to come with a fresh measurement, not with these loosened.
 */
const BUCKET_MIN = 20;
const BUCKET_MAX = 64;

/** Pearson's chi-square over the buckets. 15 degrees of freedom, p = 0.01 at 30.6. */
const CHI_SQUARE_MAX = 30;

/** Mean circular hue distance between neighbouring volumes. 0.25 for uniform hues. */
const MEAN_NEIGHBOUR_GAP_MIN = 0.22;

/** Declared bands from `palette.ts`, which the bindings must stay inside. */
const SATURATION_BAND = { min: 0.18, max: 0.46 };
const LIGHTNESS_BAND = { min: 0.22, max: 0.4 };

const color = new Color();
const hsl = { h: 0, s: 0, l: 0 };

/** The HSL of the binding at `slot`, read back in the space it was written in. */
function bindingHsl(fold: bigint, slot: number): { h: number; s: number; l: number } {
  spineColorFromSeed(fold, slot, color);
  color.getHSL(hsl, SRGBColorSpace);
  return { h: hsl.h, s: hsl.s, l: hsl.l };
}

/** The hue of every binding of a room, in slot order. */
function roomHues(room: bigint): number[] {
  const fold = roomSeed(room);
  return Array.from({ length: SPINES_PER_ROOM }, (_, slot) => bindingHsl(fold, slot).h);
}

/**
 * The function this palette exists not to be: hue straight off the linear
 * index. Neighbours on a shelf differ by `PAGES_PER_BOOK`, so the hue step
 * between them is the same number for every pair in the library.
 */
function baselineRampHue(room: bigint, slot: number): number {
  const linear = room * BigInt(PAGES_PER_ROOM) + BigInt(slot) * BigInt(PAGES_PER_BOOK);
  return Number(linear % 360n) / 360;
}

/** Distance between two hues around the colour circle, in `[0, 0.5]`. */
function circularGap(first: number, second: number): number {
  const direct = Math.abs(first - second) % 1;
  return Math.min(direct, 1 - direct);
}

/** The hue step between each pair of volumes that share a shelf. */
function neighbourGaps(hues: readonly number[]): number[] {
  const gaps: number[] = [];
  for (let wall = 0; wall < WALLS_PER_ROOM; wall += 1) {
    for (let shelf = 0; shelf < SHELVES_PER_WALL; shelf += 1) {
      const base = (wall * SHELVES_PER_WALL + shelf) * BOOKS_PER_SHELF;
      for (let volume = 1; volume < BOOKS_PER_SHELF; volume += 1) {
        gaps.push(circularGap(hues[base + volume] ?? 0, hues[base + volume - 1] ?? 0));
      }
    }
  }
  return gaps;
}

describe('the same volume, twice', () => {
  it('is the same colour, read through a slot or through an address', () => {
    const fold = roomSeed(1_000_003n);

    for (const slot of [0, 1, 17, 319, SPINES_PER_ROOM - 1]) {
      const bySlot = spineColorFromSeed(fold, slot, new Color());
      const byAddress = spineColor(slotToBookAddress(1_000_003n, slot), new Color());

      expect(byAddress.r).toBe(bySlot.r);
      expect(byAddress.g).toBe(bySlot.g);
      expect(byAddress.b).toBe(bySlot.b);
    }
  });

  it('writes into the target it was given and returns it', () => {
    const target = new Color(0x123456);

    expect(spineColorFromSeed(roomSeed(0n), 5, target)).toBe(target);
    expect(target.getHex()).not.toBe(0x123456);
  });

  it('uses every bit of the room number, so rooms differing high up differ', () => {
    const low = roomSeed(1n);
    const high = roomSeed(1n << 4096n);
    const alsoHigh = roomSeed((1n << 4096n) + 1n);

    expect(high).not.toBe(low);
    expect(alsoHigh).not.toBe(high);
  });

  it('gives the first volume of the first room a seed that is not the fixed point', () => {
    // Regression. The mixer fixes zero, and an earlier version combined the
    // room fold and the slot by `xor` after mixing each — which for room 0,
    // slot 0 cancelled to zero exactly, putting the most-looked-at spine in
    // the library at the minimum of hue, saturation and lightness at once.
    expect(spineSeed(roomSeed(0n), 0)).not.toBe(0n);

    const first = bindingHsl(roomSeed(0n), 0);
    expect(first.s).toBeGreaterThan(SATURATION_BAND.min);
    expect(first.l).toBeGreaterThan(LIGHTNESS_BAND.min);
  });
});

describe('bindings stay inside the bands the palette declares', () => {
  it('keeps saturation and lightness within their stated range in every room', () => {
    for (const room of ROOMS) {
      const fold = roomSeed(room);

      for (let slot = 0; slot < SPINES_PER_ROOM; slot += 1) {
        const { s, l } = bindingHsl(fold, slot);

        expect(s).toBeGreaterThanOrEqual(SATURATION_BAND.min);
        expect(s).toBeLessThanOrEqual(SATURATION_BAND.max);
        expect(l).toBeGreaterThanOrEqual(LIGHTNESS_BAND.min);
        expect(l).toBeLessThanOrEqual(LIGHTNESS_BAND.max);
      }
    }
  });
});

describe('hue distribution across a room', () => {
  it('spreads the 640 bindings over the colour circle without a gap or a pile', () => {
    for (const room of ROOMS) {
      const counts = new Array<number>(HUE_BUCKETS).fill(0);
      for (const hue of roomHues(room)) {
        const bucket = Math.min(HUE_BUCKETS - 1, Math.floor(hue * HUE_BUCKETS));
        counts[bucket] = (counts[bucket] ?? 0) + 1;
      }

      const expected = SPINES_PER_ROOM / HUE_BUCKETS;
      const chiSquare = counts.reduce(
        (total, count) => total + (count - expected) ** 2 / expected,
        0
      );

      expect(Math.min(...counts)).toBeGreaterThanOrEqual(BUCKET_MIN);
      expect(Math.max(...counts)).toBeLessThanOrEqual(BUCKET_MAX);
      expect(chiSquare).toBeLessThan(CHI_SQUARE_MAX);
    }
  });
});

describe('hue across one shelf', () => {
  it('steps by a different amount between every pair of neighbours', () => {
    for (const room of ROOMS) {
      const gaps = neighbourGaps(roomHues(room));
      const distinct = new Set(gaps.map((gap) => gap.toFixed(5)));
      const mean = gaps.reduce((total, gap) => total + gap, 0) / gaps.length;

      expect(gaps).toHaveLength(
        WALLS_PER_ROOM * SHELVES_PER_WALL * (BOOKS_PER_SHELF - 1)
      );
      expect(mean).toBeGreaterThan(MEAN_NEIGHBOUR_GAP_MIN);
      // A ramp has one. Anything near 620 is not a ramp.
      expect(distinct.size).toBeGreaterThan(600);
    }
  });

  it('turns direction repeatedly along a shelf, where a ramp never turns', () => {
    const fold = roomSeed(0n);

    for (let board = 0; board < WALLS_PER_ROOM * SHELVES_PER_WALL; board += 1) {
      const base = board * BOOKS_PER_SHELF;
      const hues = Array.from(
        { length: BOOKS_PER_SHELF },
        (_, volume) => bindingHsl(fold, base + volume).h
      );

      let turns = 0;
      for (let volume = 2; volume < BOOKS_PER_SHELF; volume += 1) {
        const rising = Math.sign((hues[volume] ?? 0) - (hues[volume - 1] ?? 0));
        const wasRising = Math.sign((hues[volume - 1] ?? 0) - (hues[volume - 2] ?? 0));
        if (rising !== wasRising) {
          turns += 1;
        }
      }

      // 20 turns is what an unordered sequence of 32 gives on average; the
      // sweep in the pull request found no shelf below 14.
      expect(turns).toBeGreaterThanOrEqual(10);
    }
  });

  it('is measured against a ramp that really does band', () => {
    const gaps: number[] = [];
    for (let volume = 1; volume < BOOKS_PER_SHELF; volume += 1) {
      gaps.push(
        circularGap(baselineRampHue(0n, volume), baselineRampHue(0n, volume - 1))
      );
    }

    // Every step identical: that is what banding is, and it is why the hue is
    // not read off the index.
    expect(new Set(gaps.map((gap) => gap.toFixed(5))).size).toBe(1);
    expect(gaps[0]).toBeCloseTo((PAGES_PER_BOOK % 360) / 360, 12);
  });
});
