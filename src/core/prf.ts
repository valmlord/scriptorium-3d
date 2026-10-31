import { PAGE_LENGTH, RADIX } from './address';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * The Feistel round function (SPEC §4.3): SHA-256 in counter mode, reduced
 * modulo the half-domain.
 *
 * Every constant in this file is part of the frozen library format (SPEC §4.5,
 * ADR-0003). Changing any one of them replaces all 36^3200 books at once and
 * turns every link ever shared into a pointer at different text, with nothing
 * failing to announce it. The golden vectors in `__fixtures__` exist to make
 * that change loud.
 *
 * SHA-256 comes from `@noble/hashes` rather than being hand-rolled: a subtly
 * wrong hash still produces convincing-looking output and would corrupt the
 * library invisibly (code-style §7).
 */

/**
 * Half the page length in digits: the width of each Feistel half (SPEC §4.1).
 * `PAGE_LENGTH` is even, so the split is exact and the balanced network is a
 * permutation of exactly `[0, N)` — see ADR-0002 and the test that pins it.
 */
export const HALF_LENGTH = PAGE_LENGTH / 2;

/**
 * The half-domain `H = 36 ** 1600` (SPEC §4.2). Each Feistel half ranges over
 * `[0, H)`, and `H * H` is exactly `LIBRARY_SIZE`.
 */
export const HALF_DOMAIN = BigInt(RADIX) ** BigInt(HALF_LENGTH);

/**
 * The domain separation tag (SPEC §4.2). This string IS the library's
 * identity: two libraries with different tags share no book at any address.
 */
export const DOMAIN_TAG = 'scriptorium.3d/v1';

/**
 * Bytes of counter-mode output consumed per round-function call (SPEC §4.2).
 *
 * `H` is 8272 bits wide, so 1034 bytes would already cover it; 1051 bytes
 * leave 136 bits of slack, which puts the bias of the final `mod H` below
 * 2^-128. The value is quoted from the SPEC verbatim and is part of the frozen
 * format — it is not recomputed from the bit width here, because arriving at a
 * different number by a different route would silently rewrite the library.
 */
export const PRF_BYTES = 1051;

/** Bytes per SHA-256 digest; the counter-mode stream is cut from whole blocks. */
const DIGEST_BYTES = 32;

/** Counter-mode blocks needed to cover `PRF_BYTES`: ceil(1051 / 32) = 33. */
const STREAM_BLOCKS = Math.ceil(PRF_BYTES / DIGEST_BYTES);

/**
 * `DOMAIN_TAG` as UTF-8 bytes, encoded once.
 *
 * Encoded by hand rather than with `TextEncoder` so that `core` depends on no
 * ambient global at all (architecture §1) — the tag is pure ASCII, where UTF-8
 * is the identity, and a test asserts that it stays so. An accidentally
 * non-ASCII tag would otherwise be encoded wrongly and silently.
 */
const DOMAIN_TAG_BYTES = asciiToBytes(DOMAIN_TAG);

/**
 * Lowercase hex digits for every byte value, concatenated: byte `b` occupies
 * `HEX_PAIRS[2b]` and `HEX_PAIRS[2b+1]`.
 *
 * One string rather than an array of 256 two-character strings so that the
 * lookup is a `slice` of known length rather than an index that the compiler
 * must treat as possibly absent — there is no missing byte value to handle, and
 * a `?? ''` fallback would turn a corrupt byte into a silently shorter number.
 */
const HEX_PAIRS: string = Array.from({ length: 256 }, (_unused, byte) =>
  byte.toString(16).padStart(2, '0')
).join('');

/**
 * Encode an ASCII string as bytes. Throws on any code unit above 0x7f, because
 * for such a string this function is not UTF-8 and the caller would get a
 * silently different encoding.
 *
 * Exported so the guard can be exercised directly: `DOMAIN_TAG` is frozen and
 * ASCII, so nothing on the public path can reach the throw, and an untested
 * guard is indistinguishable from an absent one.
 */
export function asciiToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) {
      throw new RangeError(
        `Expected an ASCII string, found code point ${String(code)} at index ${String(i)}`
      );
    }
    bytes[i] = code;
  }
  return bytes;
}

/**
 * The minimal big-endian byte encoding of a non-negative `bigint`: no leading
 * zero byte, and **zero-length for 0** (SPEC §4.3). The length is what the
 * seed's `u32be` prefix commits to, so "minimal" is part of the format rather
 * than an optimisation.
 *
 * Goes through `toString(16)`, which V8 implements natively: converting the
 * ~8272-bit halves this is called with takes microseconds, where a
 * divide-by-256 loop in JavaScript takes milliseconds — and this runs 10 times
 * per page inside a 5 ms budget (testing.md §5).
 */
export function toMinimalBytesBE(value: bigint): Uint8Array {
  if (value < 0n) {
    throw new RangeError(`Expected a non-negative value, received ${String(value)}`);
  }
  if (value === 0n) {
    return new Uint8Array(0);
  }

  const hex = value.toString(16);
  // An odd number of hex digits means the top byte is a half byte; pad it so
  // the string splits into whole bytes without shifting every later nibble.
  const padded = hex.length % 2 === 1 ? `0${hex}` : hex;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] =
      (hexNibble(padded.charCodeAt(2 * i)) << 4) |
      hexNibble(padded.charCodeAt(2 * i + 1));
  }
  return bytes;
}

/**
 * The value of one lowercase hex digit, by code unit. `toString(16)` only ever
 * emits `0-9a-f`, so the two ranges below are exhaustive for its output; the
 * function is private precisely because it trusts that.
 */
function hexNibble(codeUnit: number): number {
  // '0'..'9' are 48..57; 'a'..'f' are 97..102.
  return codeUnit <= 57 ? codeUnit - 48 : codeUnit - 87;
}

/**
 * Interpret bytes as a big-endian unsigned integer. An empty array is `0`,
 * mirroring `toMinimalBytesBE`.
 *
 * Builds a hex string and hands it to the `BigInt` parser for the same reason
 * as above: the native radix path is orders of magnitude faster than folding
 * `value * 256n + byte` over a thousand bytes.
 */
export function fromBytesBE(bytes: Uint8Array): bigint {
  if (bytes.length === 0) {
    return 0n;
  }
  let hex = '';
  for (const byte of bytes) {
    hex += HEX_PAIRS.slice(2 * byte, 2 * byte + 2);
  }
  return BigInt(`0x${hex}`);
}

/** Encode a number as four big-endian bytes, as `u32be` in SPEC §4.3. */
function u32be(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

/** Concatenate byte arrays into one buffer. */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The bytes that are hashed to make a round seed (SPEC §4.3):
 *
 *     DOMAIN_TAG ‖ u8(round) ‖ u32be(xb.length) ‖ xb
 *
 * Separate from `roundSeed` because this is the part that has to be
 * *injective*: distinct `(round, half)` pairs must never produce the same byte
 * string. If they did, two different addresses would share a round-function
 * value, and — SHA-256 being blameless here — two different books would hold
 * the same text. Keeping the encoding its own function is what lets a test
 * decode these bytes back into `(round, half)` and prove the property, rather
 * than assert it in a comment.
 *
 * The `u32be(xb.length)` prefix is what makes the encoding self-delimiting:
 * it commits to how many bytes of `xb` follow, so the reader of these bytes
 * can only cut them one way. A bare concatenation of variable-length fields
 * has no such guarantee — see ADR-0010, which records both the proof and the
 * limit of the SPEC's own one-line justification for the prefix.
 */
export function seedInput(round: number, half: bigint): Uint8Array {
  const halfBytes = toMinimalBytesBE(half);
  return concatBytes([
    DOMAIN_TAG_BYTES,
    new Uint8Array([round & 0xff]),
    u32be(halfBytes.length),
    halfBytes,
  ]);
}

/** The per-round seed (SPEC §4.3): SHA-256 of the encoding above. */
export function roundSeed(round: number, half: bigint): Uint8Array {
  return sha256(seedInput(round, half));
}

/**
 * `PRF_BYTES` bytes of counter-mode output from a seed (SPEC §4.3):
 *
 *     stream = SHA-256(seed ‖ u32be(0)) ‖ SHA-256(seed ‖ u32be(1)) ‖ …
 *
 * Whole blocks are generated and the result is truncated, so the stream does
 * not depend on how many bytes the caller asked for.
 */
export function counterModeStream(seed: Uint8Array): Uint8Array {
  const stream = new Uint8Array(STREAM_BLOCKS * DIGEST_BYTES);
  for (let block = 0; block < STREAM_BLOCKS; block++) {
    stream.set(sha256(concatBytes([seed, u32be(block)])), block * DIGEST_BYTES);
  }
  return stream.subarray(0, PRF_BYTES);
}

/**
 * The round function `F(round, half)` of SPEC §4.3, mapping a half in
 * `[0, HALF_DOMAIN)` to a value in `[0, HALF_DOMAIN)`.
 *
 * `F` need not be injective — a Feistel network is reversible whatever `F`
 * does, which is why the round function can be a hash rather than a
 * permutation (ADR-0002).
 */
export function roundFunction(round: number, half: bigint): bigint {
  return fromBytesBE(counterModeStream(roundSeed(round, half))) % HALF_DOMAIN;
}
