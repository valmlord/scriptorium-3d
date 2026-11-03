import { DataTexture, RepeatWrapping, RGBAFormat, SRGBColorSpace } from 'three';

/**
 * The floor's mottle, generated rather than loaded.
 *
 * A flat floor under two point lights reads as a flat grey disc and takes the
 * room's sense of scale with it. A faint stone grain fixes that for 16 kB and
 * no network request — and generating it keeps `docs/architecture.md` §5: the
 * pattern is a pure function of the pixel coordinates, so the floor of the
 * library is the same floor in every session.
 *
 * It also gives the disposal test a texture to count. A `DataTexture` holds a
 * device-side buffer exactly as a loaded image does, so if the room forgets to
 * release it the leak is the same leak.
 */

/** 64 x 64 is enough grain to break up the specular at this room's scale. */
const FLOOR_TEXTURE_SIZE = 64;

/** How many times the grain repeats across the floor plate. */
const FLOOR_TEXTURE_REPEAT = 4;

/** Mid-grey the mottle varies around, and how far either side it goes. */
const FLOOR_BASE_LEVEL = 148;
const FLOOR_LEVEL_SPAN = 54;

/**
 * A deterministic stone mottle for the floor. The caller owns the result and
 * is responsible for disposing it — see `./resources.ts`.
 */
export function createFloorTexture(): DataTexture {
  const size = FLOOR_TEXTURE_SIZE;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Two octaves: the coarse one gives patches the eye can follow across
      // the floor, the fine one keeps a single patch from looking painted.
      const coarse = unitNoise(x >> 2, y >> 2, 1);
      const fine = unitNoise(x, y, 2);
      const level =
        FLOOR_BASE_LEVEL + FLOOR_LEVEL_SPAN * (0.7 * coarse + 0.3 * fine - 0.5);
      const channel = Math.round(level);
      const offset = (y * size + x) * 4;
      pixels[offset] = channel;
      pixels[offset + 1] = channel;
      pixels[offset + 2] = channel;
      pixels[offset + 3] = 255;
    }
  }

  const texture = new DataTexture(pixels, size, size, RGBAFormat);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(FLOOR_TEXTURE_REPEAT, FLOOR_TEXTURE_REPEAT);
  texture.needsUpdate = true;
  return texture;
}

/**
 * An integer hash of two coordinates and a salt, as a `[0, 1)` number. The
 * constants are the usual large odd multipliers; `Math.imul` is what keeps the
 * products inside 32 bits instead of losing their low bits to a double.
 */
function unitNoise(x: number, y: number, salt: number): number {
  let hash =
    Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 2246822519);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  return ((hash ^ (hash >>> 16)) >>> 0) / 2 ** 32;
}
