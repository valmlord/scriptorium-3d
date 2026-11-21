import type { RandomSource } from '@core/index';

/**
 * A reproducible `RandomSource` for the handler's search tests.
 *
 * **Why splitmix32 and not a counter.** `core`'s `randomBelow` masks each draw
 * to the limit's bit width and redraws on overflow, so a source whose bytes
 * repeat with a short period can return the same rejected candidate forever.
 * A byte counter modulo 256 did exactly that: 121 to 137 of its 256 seeds never
 * returned from a search (correctness judge, design round 2). splitmix32 steps
 * a 32-bit state by an odd constant, so the state visits all 2^32 values before
 * repeating, and with one byte taken per output the byte stream's period is
 * 2^32 bytes, far beyond anything a search asks for.
 *
 * **Why a cap.** A defect that makes the redraw loop spin would otherwise be a
 * hung test run rather than a red test. Past `PINNED_SOURCE_BYTE_CAP` bytes the
 * source throws, the handler answers that throw as `failed`, and the assertion
 * that expected `found` fails with the error's name in its diff.
 */

/**
 * 1 MiB. A search draws its offset in a few bytes and each side of its random
 * padding in at most about 2 KB (36^3199 needs 16 539 bits), and a masked draw
 * is accepted with probability above one half, so it takes fewer than two draws
 * on average: a search that is working uses well under 1% of this.
 */
export const PINNED_SOURCE_BYTE_CAP = 1 << 20;

/** The pinned source was asked for more bytes than any working search draws. */
export class PinnedSourceExhaustedError extends Error {
  readonly bytesDrawn: number;

  constructor(bytesDrawn: number) {
    super(
      `The pinned random source was asked for ${String(bytesDrawn)} bytes, past its cap of ${String(PINNED_SOURCE_BYTE_CAP)}`
    );
    this.name = 'PinnedSourceExhaustedError';
    this.bytesDrawn = bytesDrawn;
  }
}

/** The splitmix32 increment: the 32-bit golden ratio, odd, so the state has full period. */
const GOLDEN_GAMMA = 0x9e3779b9;
const FIRST_MIX = 0x21f0aaad;
const SECOND_MIX = 0x735a2d97;
const LOW_BYTE = 0xff;

/** A fresh source for `seed`: two sources of the same seed hand out the same bytes. */
export function pinnedRandomSource(seed: number): RandomSource {
  let state = seed | 0;
  let bytesDrawn = 0;

  const nextOutput = (): number => {
    state = (state + GOLDEN_GAMMA) | 0;
    let mixed = state ^ (state >>> 16);
    mixed = Math.imul(mixed, FIRST_MIX);
    mixed ^= mixed >>> 15;
    mixed = Math.imul(mixed, SECOND_MIX);
    mixed ^= mixed >>> 15;
    return mixed >>> 0;
  };

  return (byteLength: number): Uint8Array => {
    bytesDrawn += byteLength;
    if (bytesDrawn > PINNED_SOURCE_BYTE_CAP) {
      throw new PinnedSourceExhaustedError(bytesDrawn);
    }
    const bytes = new Uint8Array(byteLength);
    for (let index = 0; index < byteLength; index += 1) {
      bytes[index] = nextOutput() & LOW_BYTE;
    }
    return bytes;
  };
}
