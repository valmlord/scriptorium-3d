import type { UnknownSymbol } from './alphabet';

/**
 * Dedicated error types for the domain situations the library can hit.
 * A bare `Error("something went wrong")` carries no context; each of these
 * carries exactly the fields a caller needs to act on the failure.
 */

/**
 * A character that is not in the alphabet was found where a digit was
 * expected. Carries every offending symbol and its position, not just the
 * first, so a caller can report the whole problem at once.
 */
export class UnknownSymbolError extends Error {
  readonly symbols: readonly UnknownSymbol[];

  constructor(symbols: readonly UnknownSymbol[]) {
    const detail = symbols
      .map((s) => `'${s.symbol}' at index ${String(s.index)}`)
      .join(', ');
    super(`Unknown symbol(s): ${detail}`);
    this.name = 'UnknownSymbolError';
    this.symbols = symbols;
  }
}

/**
 * A page of text did not have the fixed length the format requires. The
 * library is a bijection over exactly 3200-character pages; any other length
 * is not a page and cannot be located.
 */
export class InvalidPageLengthError extends Error {
  readonly expected: number;
  readonly received: number;

  constructor(expected: number, received: number) {
    super(`Expected page length ${String(expected)}, received ${String(received)}`);
    this.name = 'InvalidPageLengthError';
    this.expected = expected;
    this.received = received;
  }
}

/**
 * An address component fell outside its permitted range. Names the component,
 * the offending value and the inclusive range it must lie in. `value` is a
 * string when the malformed input is a name rather than a number — an empty
 * room name, for instance, is reported as the room component holding `''`.
 */
export class InvalidAddressError extends Error {
  readonly component: string;
  readonly value: bigint | number | string;
  readonly min: bigint | number;
  readonly max: bigint | number;

  constructor(
    component: string,
    value: bigint | number | string,
    min: bigint | number,
    max: bigint | number
  ) {
    super(
      `Address component '${component}' out of range: ${String(value)} not in [${String(min)}, ${String(max)}]`
    );
    this.name = 'InvalidAddressError';
    this.component = component;
    this.value = value;
    this.min = min;
    this.max = max;
  }
}

/**
 * An address whose components are each individually in range, but whose linear
 * index lies at or beyond the end of the library. This is the unfilled tail of
 * the partially-filled last room (SPEC §3): the last room holds
 * `LIBRARY_SIZE mod PAGES_PER_ROOM` pages, not `PAGES_PER_ROOM`, so a page
 * past that tail does not exist. Carries the linear index and `LIBRARY_SIZE`
 * so the caller can see exactly how far past the end the address is.
 */
export class AddressBeyondLibraryError extends Error {
  readonly linear: bigint;
  readonly librarySize: bigint;

  constructor(linear: bigint, librarySize: bigint) {
    super(
      `Address lies beyond the end of the library: linear index ${String(linear)} is not in [0, ${String(librarySize)})`
    );
    this.name = 'AddressBeyondLibraryError';
    this.linear = linear;
    this.librarySize = librarySize;
  }
}

/**
 * A `bigint` does not fit the fixed-width radix representation requested:
 * it is negative or `>= radix ** length`. The value, radix and length are
 * kept so the caller can see exactly which bound was crossed.
 */
export class ValueOutOfDomainError extends Error {
  readonly value: bigint;
  readonly radix: number;
  readonly length: number;

  constructor(value: bigint, radix: number, length: number) {
    const max = BigInt(radix) ** BigInt(length) - 1n;
    super(
      `Value ${String(value)} out of domain for radix ${String(radix)} and length ${String(length)} (allowed [0, ${String(max)}])`
    );
    this.name = 'ValueOutOfDomainError';
    this.value = value;
    this.radix = radix;
    this.length = length;
  }
}
