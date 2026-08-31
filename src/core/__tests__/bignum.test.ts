import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { PAGE_ALPHABET, ROOM_ALPHABET, type Alphabet } from '../alphabet';
import { digitsToInt, intToDigits } from '../bignum';
import { UnknownSymbolError, ValueOutOfDomainError } from '../errors';

/**
 * A naive divide-by-radix implementation, kept in the test file on purpose.
 * It is the reference the fast native path is verified against: if the two
 * ever disagree, the fast path is wrong.
 */
function naiveIntToDigits(value: bigint, alphabet: Alphabet, length: number): string {
  const radix = BigInt(alphabet.radix);
  const out = new Array<string>(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    const digit = Number(v % radix);
    out[i] = alphabet.symbols[digit] ?? '';
    v = v / radix;
  }
  return out.join('');
}

function naiveDigitsToInt(text: string, alphabet: Alphabet): bigint {
  let value = 0n;
  for (const char of text) {
    const digit = alphabet.digitBySymbol.get(char);
    if (digit === undefined) {
      throw new UnknownSymbolError([{ symbol: char, index: 0 }]);
    }
    value = value * BigInt(alphabet.radix) + BigInt(digit);
  }
  return value;
}

/** A generator of fixed-width strings over an alphabet, reaching the edges. */
function fixedWidthString(alphabet: Alphabet, length: number): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...alphabet.symbols), {
      minLength: length,
      maxLength: length,
    })
    .map((chars) => chars.join(''));
}

describe('intToDigits', () => {
  it('round-trips through digitsToInt for arbitrary values', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 36n ** 3200n - 1n }),
        (value) =>
          digitsToInt(intToDigits(value, PAGE_ALPHABET, 3200), PAGE_ALPHABET) === value
      ),
      { numRuns: 1000 }
    );
  });

  it('round-trips through digitsToInt for arbitrary fixed-width text', () => {
    fc.assert(
      fc.property(fixedWidthString(PAGE_ALPHABET, 3200), (text) => {
        const value = digitsToInt(text, PAGE_ALPHABET);
        return intToDigits(value, PAGE_ALPHABET, 3200) === text;
      }),
      { numRuns: 1000 }
    );
  });

  it('pads a page of 3200 index-0 symbols to the value 0 and back', () => {
    const spaces = ' '.repeat(3200);
    expect(digitsToInt(spaces, PAGE_ALPHABET)).toBe(0n);
    expect(intToDigits(0n, PAGE_ALPHABET, 3200)).toBe(spaces);
  });

  it('produces exactly 3200 characters for every value in the domain', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 36n ** 3200n - 1n }),
        (value) => intToDigits(value, PAGE_ALPHABET, 3200).length === 3200
      ),
      { numRuns: 1000 }
    );
  });

  it('produces only alphabet symbols for every value in the domain', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 36n ** 3200n - 1n }), (value) => {
        const text = intToDigits(value, PAGE_ALPHABET, 3200);
        // Array.from iterates by code point; every alphabet symbol is a
        // single BMP code point, so this is exact.
        return Array.from(text).every((c) => PAGE_ALPHABET.digitBySymbol.has(c));
      }),
      { numRuns: 1000 }
    );
  });

  it('throws ValueOutOfDomainError for a negative value', () => {
    expect(() => intToDigits(-1n, PAGE_ALPHABET, 3200)).toThrow(ValueOutOfDomainError);
  });

  it('throws ValueOutOfDomainError for a value at or above radix ** length', () => {
    expect(() => intToDigits(36n ** 3200n, PAGE_ALPHABET, 3200)).toThrow(
      ValueOutOfDomainError
    );
    expect(() => intToDigits(36n ** 3200n + 1n, PAGE_ALPHABET, 3200)).toThrow(
      ValueOutOfDomainError
    );
  });

  it('carries the value, radix and length on the error', () => {
    try {
      intToDigits(36n ** 3200n, PAGE_ALPHABET, 3200);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ValueOutOfDomainError);
      const err = e as ValueOutOfDomainError;
      expect(err.value).toBe(36n ** 3200n);
      expect(err.radix).toBe(36);
      expect(err.length).toBe(3200);
    }
  });

  it('handles a value one below 36 ** 3200', () => {
    const text = intToDigits(36n ** 3200n - 1n, PAGE_ALPHABET, 3200);
    expect(text.length).toBe(3200);
    expect(digitsToInt(text, PAGE_ALPHABET)).toBe(36n ** 3200n - 1n);
  });

  it('works for the room-name alphabet too', () => {
    const name = intToDigits(123456789n, ROOM_ALPHABET, 6);
    expect(name).toBe('21i3v9');
    expect(digitsToInt(name, ROOM_ALPHABET)).toBe(123456789n);
  });
});

describe('digitsToInt', () => {
  it('returns 0 for an empty string', () => {
    expect(digitsToInt('', PAGE_ALPHABET)).toBe(0n);
  });

  it('throws UnknownSymbolError naming every offending position', () => {
    try {
      digitsToInt('аxбyв', PAGE_ALPHABET);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownSymbolError);
      const err = e as UnknownSymbolError;
      expect(err.symbols).toEqual([
        { symbol: 'x', index: 1 },
        { symbol: 'y', index: 3 },
      ]);
    }
  });

  it('throws UnknownSymbolError for a single unknown symbol', () => {
    expect(() => digitsToInt('привет!', PAGE_ALPHABET)).toThrow(UnknownSymbolError);
  });

  it('reports an astral character as one symbol at its code-point index', () => {
    // '😀' (U+1F600) is a surrogate pair. Chunks are cut on code-point
    // boundaries, so it must be reported as a single unknown symbol at index 0
    // — never split across two chunks and reported as two meaningless symbols.
    try {
      digitsToInt('😀а', PAGE_ALPHABET);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownSymbolError);
      const err = e as UnknownSymbolError;
      expect(err.symbols).toEqual([{ symbol: '😀', index: 0 }]);
    }
  });

  it('reports an astral character inside a chunk at the right offset', () => {
    // The astral character sits mid-chunk; its index must be its code-point
    // position in the original string, not a UTF-16 offset.
    try {
      digitsToInt('аб😀в', PAGE_ALPHABET);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownSymbolError);
      const err = e as UnknownSymbolError;
      expect(err.symbols).toEqual([{ symbol: '😀', index: 2 }]);
    }
  });
});

describe('fast path agrees with the naive implementation', () => {
  // The naive divide-by-radix loop is O(n²) in the digit count, so the
  // property comparison runs at a moderate length where 1000 cases are fast.
  // A single full-length case below pins the 3200-digit behaviour.
  const NAIVE_LENGTH = 200;

  it('intToDigits matches naiveIntToDigits over the domain', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 36n ** BigInt(NAIVE_LENGTH) - 1n }),
        (value) =>
          intToDigits(value, PAGE_ALPHABET, NAIVE_LENGTH) ===
          naiveIntToDigits(value, PAGE_ALPHABET, NAIVE_LENGTH)
      ),
      { numRuns: 1000 }
    );
  });

  it('digitsToInt matches naiveDigitsToInt over fixed-width text', () => {
    fc.assert(
      fc.property(fixedWidthString(PAGE_ALPHABET, NAIVE_LENGTH), (text) => {
        const fast = digitsToInt(text, PAGE_ALPHABET);
        const slow = naiveDigitsToInt(text, PAGE_ALPHABET);
        return fast === slow;
      }),
      { numRuns: 1000 }
    );
  });

  it('agrees with the naive implementation at the full 3200-digit length', () => {
    const value = 36n ** 3200n - 123456789n;
    expect(intToDigits(value, PAGE_ALPHABET, 3200)).toBe(
      naiveIntToDigits(value, PAGE_ALPHABET, 3200)
    );
    const text = 'а'.repeat(3199) + 'я';
    expect(digitsToInt(text, PAGE_ALPHABET)).toBe(
      naiveDigitsToInt(text, PAGE_ALPHABET)
    );
  });
});
