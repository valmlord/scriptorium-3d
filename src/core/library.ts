import type { Address, BookAddress } from './address';
import {
  LIBRARY_SIZE,
  PAGE_LENGTH,
  RADIX,
  assertValidAddress,
  fromLinear,
  toLinear,
} from './address';
import type { UnknownSymbol } from './alphabet';
import { PAGE_ALPHABET, digitToSymbol, symbolToDigit } from './alphabet';
import { digitsToInt, intToDigits } from './bignum';
import {
  InvalidPageLengthError,
  InvalidSearchOffsetError,
  InvalidSearchQueryError,
  UnknownSymbolError,
} from './errors';
import { decrypt, encrypt } from './feistel';
import { fromBytesBE } from './prf';

/**
 * The public API of `core` (SPEC §5): the library seen from the outside, in
 * both directions. Everything here is a composition of three tested pieces —
 * the address linearisation (§3), the radix codec (§2) and the Feistel
 * bijection (§4) — and holds no state.
 */

/**
 * The format version, carried in every shareable URL (SPEC §4.5, §7).
 *
 * It exists so that a link made under one format is refused rather than
 * silently opened at different text. Bumping it is a deliberate act that
 * accompanies a format change, never a routine release chore.
 */
export const FORMAT_VERSION = 1;

/** A book's title is the first 25 characters of its page 0 (SPEC §5). */
export const TITLE_LENGTH = 25;

/** How the remainder of a search page is filled (SPEC §5). */
export type PadMode = 'spaces' | 'random';

/** Where a search query was placed: the address, and the offset within it. */
export interface SearchHit {
  address: Address;
  offset: number;
}

/**
 * A source of random bytes, injected rather than reached for.
 *
 * No randomness appears anywhere on the generation path — the bijection is
 * fully deterministic (architecture §5). Randomness exists only in the two
 * explicit user-facing choices the SPEC names: "open a random book" and "pad
 * this query with random filler". Both take the source as an argument so that
 * a test can pin it, and so a caller that needs reproducibility can have it.
 *
 * A source must return exactly as many bytes as it was asked for; returning
 * fewer is rejected rather than quietly producing a smaller, non-uniform
 * value.
 */
export type RandomSource = (byteLength: number) => Uint8Array;

/**
 * The default random source, used when a caller does not supply one.
 *
 * `Math.random` is deliberate: these bytes choose which book a reader is
 * shown, not a key, so being unpredictable to an attacker is not a
 * requirement — while `crypto.getRandomValues` is an ambient global that
 * `core` is not allowed to depend on (architecture §1). This is the only
 * function in `core` that calls `Math.random`, and nothing on the generation
 * path reaches it.
 */
export const defaultRandomSource: RandomSource = (byteLength: number): Uint8Array => {
  const bytes = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
};

/**
 * The text of the page at an address (SPEC §4.4):
 *
 *     getPage(address) = digitsToText(encrypt(linear(address)))
 *
 * Always exactly `PAGE_LENGTH` characters, leading index-0 symbols included —
 * a page whose value happens to be small is a page that begins with spaces,
 * not a short page.
 */
export function getPage(address: Address): string {
  assertValidAddress(address);
  return intToDigits(encrypt(toLinear(address)), PAGE_ALPHABET, PAGE_LENGTH);
}

/**
 * The address of a page of text (SPEC §4.4):
 *
 *     locate(page) = fromLinear(decrypt(textToInt(page)))
 *
 * Every 3200-character string over the alphabet is a page of the library, so
 * this never fails to find an address. The two ways it can fail are both about
 * the input not being a page at all: the wrong length, or a character that is
 * not in the alphabet.
 *
 * Length is counted in code points rather than UTF-16 units, so a string
 * containing an astral character is reported as holding an unknown symbol
 * rather than as being the wrong length.
 */
export function locate(page: string): Address {
  const codePointLength = Array.from(page).length;
  if (codePointLength !== PAGE_LENGTH) {
    throw new InvalidPageLengthError(PAGE_LENGTH, codePointLength);
  }
  return fromLinear(decrypt(digitsToInt(page, PAGE_ALPHABET)));
}

/**
 * A book's title: the first 25 characters of its page 0 (SPEC §5). Defining a
 * title this way is what makes searching for a title a special case of
 * `search` rather than a second mechanism with an index of its own.
 */
export function getTitle(book: BookAddress): string {
  return getPage({ ...book, page: 0 }).slice(0, TITLE_LENGTH);
}

/**
 * A uniformly random address in the library.
 *
 * Uniform over pages, not over the address tree: it draws a linear index in
 * `[0, N)` and decomposes it, so the unfilled tail of the last room can never
 * be returned and every page in the library is equally likely. Choosing each
 * component independently would instead keep landing in that non-existent tail
 * and need a retry loop.
 */
export function randomAddress(random: RandomSource = defaultRandomSource): Address {
  return fromLinear(randomBelow(LIBRARY_SIZE, random));
}

/**
 * Find the page that contains `query` at `offset`, and the address of that page
 * (SPEC §5).
 *
 * This is the whole of search. Because the bijection runs in both directions,
 * finding a phrase means building the page you want and asking where it lives —
 * there is no index to consult and nothing to scan. The returned offset is
 * where the query starts, so the reader can highlight it.
 *
 * The query is used exactly as given. `normalize` from `alphabet.ts` is the
 * caller's to apply (SPEC §2), because it is the caller that must decide
 * whether to reject or strip the unknown symbols it reports. Normalizing here
 * would also quietly falsify this function's contract: the page would contain
 * the normalized query rather than the string that was passed in.
 */
export function search(
  query: string,
  mode: PadMode,
  offset?: number,
  random: RandomSource = defaultRandomSource
): SearchHit {
  const characters = Array.from(query);
  const queryLength = characters.length;
  if (queryLength < 1 || queryLength > PAGE_LENGTH) {
    throw new InvalidSearchQueryError(queryLength, 1, PAGE_LENGTH);
  }
  assertInAlphabet(characters);

  const maxOffset = PAGE_LENGTH - queryLength;
  const resolvedOffset = offset ?? Number(randomBelow(BigInt(maxOffset + 1), random));
  if (
    !Number.isInteger(resolvedOffset) ||
    resolvedOffset < 0 ||
    resolvedOffset > maxOffset
  ) {
    throw new InvalidSearchOffsetError(resolvedOffset, queryLength, maxOffset);
  }

  const page =
    pad(resolvedOffset, mode, random) +
    characters.join('') +
    pad(maxOffset - resolvedOffset, mode, random);

  return { address: locate(page), offset: resolvedOffset };
}

/**
 * Reject any character outside the page alphabet, naming every one of them
 * with its position rather than stopping at the first: a caller showing the
 * user what is wrong with their query needs the whole list at once.
 */
function assertInAlphabet(characters: readonly string[]): void {
  const unknown: UnknownSymbol[] = [];
  for (const [index, character] of characters.entries()) {
    if (symbolToDigit(PAGE_ALPHABET, character) === undefined) {
      unknown.push({ symbol: character, index });
    }
  }
  if (unknown.length > 0) {
    throw new UnknownSymbolError(unknown);
  }
}

/**
 * Filler for one side of a search query.
 *
 * `'random'` draws a single uniform value below `36^length` and converts it in
 * one go rather than picking `length` digits one at a time: it reuses the
 * tested radix codec, and it is exactly uniform over the possible fillers,
 * where a byte-per-digit loop would favour the first four symbols of the
 * alphabet unless it did its own rejection sampling.
 */
function pad(length: number, mode: PadMode, random: RandomSource): string {
  if (length === 0) {
    return '';
  }
  if (mode === 'spaces') {
    return digitToSymbol(PAGE_ALPHABET, 0).repeat(length);
  }
  const limit = BigInt(RADIX) ** BigInt(length);
  return intToDigits(randomBelow(limit, random), PAGE_ALPHABET, length);
}

/**
 * A uniform random `bigint` in `[0, limit)` by rejection sampling.
 *
 * Masking the draw to the limit's exact bit width and redrawing on overflow is
 * what keeps it uniform. Reducing a wider draw modulo `limit` would favour the
 * low end of the range, which for `randomAddress` means some books being
 * measurably more likely to open than others; masking without redrawing would
 * do the same. For `limit = LIBRARY_SIZE` a draw is accepted with probability
 * `36^3200 / 2^16544`, about 0.85, so the loop runs 1.18 times on average.
 */
function randomBelow(limit: bigint, random: RandomSource): bigint {
  if (limit <= 1n) {
    return 0n;
  }
  const bits = bitLength(limit);
  const byteLength = Math.ceil(bits / 8);
  const mask = (1n << BigInt(bits)) - 1n;

  for (;;) {
    const bytes = random(byteLength);
    if (bytes.length !== byteLength) {
      throw new RangeError(
        `Random source returned ${String(bytes.length)} bytes, expected ${String(byteLength)}`
      );
    }
    const candidate = fromBytesBE(bytes) & mask;
    if (candidate < limit) {
      return candidate;
    }
  }
}

/**
 * The number of bits in a positive `bigint`.
 *
 * Derived from the hexadecimal form because that is the widest native radix:
 * the string is a quarter the length of the binary one, and for the
 * 16544-bit values here that difference is the only reason this is cheap
 * enough to call on every draw.
 */
function bitLength(value: bigint): number {
  const hex = value.toString(16);
  const topNibble = Number.parseInt(hex.slice(0, 1), 16);
  return (hex.length - 1) * 4 + (32 - Math.clz32(topNibble));
}
