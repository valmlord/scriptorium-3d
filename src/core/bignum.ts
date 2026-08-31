import type { Alphabet, UnknownSymbol } from './alphabet';
import { digitToSymbol, symbolToDigit } from './alphabet';
import { UnknownSymbolError, ValueOutOfDomainError } from './errors';

/**
 * A generic radix codec parameterised by an alphabet, so the same tested code
 * serves both page text (radix 36 over the Cyrillic alphabet) and room names
 * (radix 36 over `0-9a-z`).
 *
 * Big-endian: the first character is the most significant digit.
 */

/**
 * The number of digits consumed per chunk when parsing. Parsing has no native
 * counterpart to `toString(36)`, so it accumulates in chunks rather than digit
 * by digit: `value = value * radix**k + chunk`. A chunk of 7 keeps the
 * intermediate `radix**7 = 78_364_164_096` comfortably inside `Number.MAX_SAFE_INTEGER`
 * (9_007_199_254_740_991), so each chunk is parsed with plain `Number` arithmetic
 * and only the accumulation is `bigint`. Larger chunks would overflow the safe
 * integer range; smaller ones would multiply the number of bigint operations.
 */
const PARSE_CHUNK = 7;

/**
 * Convert a string of digits in `alphabet` to its `bigint` value.
 * Throws `UnknownSymbolError` naming every offending position, not just the
 * first. An empty string is the value `0`.
 */
export function digitsToInt(text: string, alphabet: Alphabet): bigint {
  const unknown: UnknownSymbol[] = [];
  let value = 0n;

  // Parse in chunks of PARSE_CHUNK digits from the most significant end.
  // Each chunk is validated and converted with Number arithmetic, then folded
  // into the bigint accumulator. This is ~PARSE_CHUNK times fewer bigint
  // operations than a digit-by-digit loop. The multiplier is radix raised to
  // the *actual* chunk length, because the final chunk is usually partial.
  //
  // Chunks are cut on code-point boundaries, never on UTF-16 indices: a
  // surrogate pair split across two chunks would be reported as two
  // meaningless symbols at wrong offsets. Iterating with `for...of` yields one
  // code point at a time, so a chunk is exactly PARSE_CHUNK code points and
  // every reported index is a code-point position in the original string.
  let chunk: string[] = [];
  let offset = 0;
  for (const char of text) {
    chunk.push(char);
    if (chunk.length === PARSE_CHUNK) {
      value =
        value * BigInt(alphabet.radix) ** BigInt(PARSE_CHUNK) +
        BigInt(parseChunk(chunk, alphabet, unknown, offset - PARSE_CHUNK + 1));
      chunk = [];
    }
    offset++;
  }
  if (chunk.length > 0) {
    value =
      value * BigInt(alphabet.radix) ** BigInt(chunk.length) +
      BigInt(parseChunk(chunk, alphabet, unknown, offset - chunk.length));
  }

  if (unknown.length > 0) {
    throw new UnknownSymbolError(unknown);
  }
  return value;
}

/**
 * Convert one chunk of digits to its numeric value, recording any symbol
 * outside the alphabet. `startOffset` is the code-point index of the chunk's
 * first character in the original string, so each reported position is exact.
 */
function parseChunk(
  chars: readonly string[],
  alphabet: Alphabet,
  unknown: UnknownSymbol[],
  startOffset: number
): number {
  let chunk = 0;
  let j = 0;
  for (const char of chars) {
    const digit = symbolToDigit(alphabet, char);
    if (digit === undefined) {
      unknown.push({ symbol: char, index: startOffset + j });
    } else {
      chunk = chunk * alphabet.radix + digit;
    }
    j++;
  }
  return chunk;
}

/**
 * Convert a `bigint` to a fixed-width string of digits in `alphabet`, padded
 * on the left with the index-0 symbol to exactly `length`. A page of 3200
 * spaces is the value `0`, and it must round-trip — this is where fixed-length
 * radix conversion usually breaks.
 *
 * Throws `ValueOutOfDomainError` when `value` is negative or `>= radix ** length`.
 */
export function intToDigits(value: bigint, alphabet: Alphabet, length: number): string {
  if (value < 0n || value >= BigInt(alphabet.radix) ** BigInt(length)) {
    throw new ValueOutOfDomainError(value, alphabet.radix, length);
  }

  // `value.toString(36)` is native and converts a 16545-bit value in ~0.1 ms,
  // where a hand-rolled divide-by-radix loop takes tens of milliseconds. The
  // native path emits `0-9a-z`; we translate each character to its digit value
  // and then to the target alphabet's glyph. The target alphabet need not
  // contain `0-9a-z` itself (the page alphabet does not), so the digit value
  // is derived arithmetically, never by lookup.
  const native = value.toString(36);
  const padLength = length - native.length;
  const pad = digitToSymbol(alphabet, 0);
  const out = new Array<string>(length);
  for (let i = 0; i < padLength; i++) {
    out[i] = pad;
  }
  let outIndex = padLength;
  for (const char of native) {
    const code = char.charCodeAt(0);
    // '0'..'9' are digits 0..9; 'a'..'z' are digits 10..35.
    const digit = code >= 97 ? code - 87 : code - 48;
    out[outIndex] = digitToSymbol(alphabet, digit);
    outIndex++;
  }
  return out.join('');
}
