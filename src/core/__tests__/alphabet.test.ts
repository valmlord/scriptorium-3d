import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  PAGE_ALPHABET,
  ROOM_ALPHABET,
  buildAlphabet,
  symbolToDigit,
  digitToSymbol,
  isInAlphabet,
  normalize,
} from '../alphabet';
import './fast-check-setup';

describe('PAGE_ALPHABET', () => {
  it('has exactly 36 symbols', () => {
    expect(PAGE_ALPHABET.symbols).toHaveLength(36);
    expect(PAGE_ALPHABET.radix).toBe(36);
  });

  it('places space at index 0', () => {
    expect(PAGE_ALPHABET.symbols[0]).toBe(' ');
  });

  it('places ё at index 7 and ъ at index 28', () => {
    expect(PAGE_ALPHABET.symbols[7]).toBe('ё');
    expect(PAGE_ALPHABET.symbols[28]).toBe('ъ');
  });

  it('places comma at index 34 and full stop at index 35', () => {
    expect(PAGE_ALPHABET.symbols[34]).toBe(',');
    expect(PAGE_ALPHABET.symbols[35]).toBe('.');
  });

  it('contains all 33 Russian letters exactly once', () => {
    const letters = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'.split('');
    for (const letter of letters) {
      expect(PAGE_ALPHABET.digitBySymbol.get(letter)).toBeDefined();
    }
    // No duplicates: the reverse lookup maps each symbol to exactly one digit.
    expect(PAGE_ALPHABET.digitBySymbol.size).toBe(36);
  });

  it('the digit value equals the index for every symbol', () => {
    PAGE_ALPHABET.symbols.forEach((symbol, index) => {
      expect(symbolToDigit(PAGE_ALPHABET, symbol)).toBe(index);
    });
  });
});

describe('ROOM_ALPHABET', () => {
  it('is 0-9a-z in order', () => {
    expect(ROOM_ALPHABET.symbols.join('')).toBe('0123456789abcdefghijklmnopqrstuvwxyz');
    expect(ROOM_ALPHABET.radix).toBe(36);
  });

  it('differs from the page alphabet', () => {
    expect(ROOM_ALPHABET.symbols).not.toEqual(PAGE_ALPHABET.symbols);
  });
});

describe('buildAlphabet', () => {
  it('builds a working alphabet from a complete symbol list', () => {
    const alphabet = buildAlphabet(['a', 'b', 'c']);
    expect(alphabet.radix).toBe(3);
    expect(symbolToDigit(alphabet, 'b')).toBe(1);
    expect(digitToSymbol(alphabet, 2)).toBe('c');
  });

  it('throws when the symbol list has a hole', () => {
    // A hole would silently shift every digit value after it and corrupt the
    // format, so it must be rejected at construction time.
    const holey = ['a'] as string[];
    holey.length = 3;
    expect(() => buildAlphabet(holey)).toThrow('hole');
  });
});

describe('symbolToDigit / digitToSymbol', () => {
  it('returns undefined for a symbol outside the alphabet', () => {
    expect(symbolToDigit(PAGE_ALPHABET, 'x')).toBeUndefined();
    expect(symbolToDigit(PAGE_ALPHABET, '0')).toBeUndefined();
    expect(symbolToDigit(PAGE_ALPHABET, 'А')).toBeUndefined();
  });

  it('digitToSymbol returns the symbol for a valid digit', () => {
    expect(digitToSymbol(PAGE_ALPHABET, 0)).toBe(' ');
    expect(digitToSymbol(PAGE_ALPHABET, 35)).toBe('.');
  });

  it('digitToSymbol throws for an out-of-range digit', () => {
    expect(() => digitToSymbol(PAGE_ALPHABET, 36)).toThrow(RangeError);
    expect(() => digitToSymbol(PAGE_ALPHABET, -1)).toThrow(RangeError);
  });
});

describe('isInAlphabet', () => {
  it('accepts text entirely within the alphabet', () => {
    expect(isInAlphabet(PAGE_ALPHABET, 'привет мир')).toBe(true);
  });

  it('rejects text containing a foreign character', () => {
    expect(isInAlphabet(PAGE_ALPHABET, 'привет!')).toBe(false);
    expect(isInAlphabet(PAGE_ALPHABET, 'hello')).toBe(false);
  });

  it('accepts an empty string', () => {
    expect(isInAlphabet(PAGE_ALPHABET, '')).toBe(true);
  });
});

describe('normalize', () => {
  it('lower-cases and NFC-normalizes input', () => {
    // 'Е' is U+0415; NFC keeps it as a single code point.
    const result = normalize('ЕЖ');
    expect(result.text).toBe('еж');
    expect(result.unknown).toHaveLength(0);
  });

  it('preserves ё as itself, never folding it into е', () => {
    const result = normalize('ЁЛКА');
    expect(result.text).toBe('ёлка');
    expect(result.unknown).toHaveLength(0);
  });

  it('collapses any whitespace run to a single space', () => {
    const result = normalize('привет   мир\n\t там');
    expect(result.text).toBe('привет мир там');
    expect(result.unknown).toHaveLength(0);
  });
  it('collapses leading and trailing whitespace to a single space', () => {
    const result = normalize('  привет  ');
    expect(result.text).toBe(' привет ');
    expect(result.unknown).toHaveLength(0);
  });
  it('reports Latin homoglyphs with their positions instead of substituting', () => {
    const result = normalize('привет x мир');
    expect(result.text).toBe('привет  мир');
    expect(result.unknown).toEqual([{ symbol: 'x', index: 7 }]);
  });

  it('reports every unknown character, not just the first', () => {
    const result = normalize('a?b!');
    expect(result.unknown).toEqual([
      { symbol: 'a', index: 0 },
      { symbol: '?', index: 1 },
      { symbol: 'b', index: 2 },
      { symbol: '!', index: 3 },
    ]);
  });

  it('reports punctuation that is not in the alphabet', () => {
    const result = normalize('— «кавычки»');
    expect(result.unknown.length).toBeGreaterThan(0);
    expect(result.text).toBe(' кавычки');
  });

  it('keeps comma and full stop, which are in the alphabet', () => {
    const result = normalize('Привет, мир.');
    expect(result.text).toBe('привет, мир.');
    expect(result.unknown).toHaveLength(0);
  });

  it('reports the position relative to the original input, not the cleaned text', () => {
    // The 'x' is at index 8 in the input (after 'привет ' and the space).
    const result = normalize('привет  x');
    expect(result.unknown).toEqual([{ symbol: 'x', index: 8 }]);
  });

  it('does not use locale-dependent lower-casing', () => {
    // Turkish 'I' lower-cases to 'ı' under toLocaleLowerCase('tr'); the
    // library must never do that. 'I' is not in the alphabet either way, but
    // it must be reported as the ASCII 'i' glyph, not a Turkish dotless one.
    const result = normalize('I');
    expect(result.unknown).toEqual([{ symbol: 'i', index: 0 }]);
  });

  it('reports positions in the original input when case folding expands a character', () => {
    // 'İ' (U+0130) lower-cases to two code points, 'i' + combining dot, both
    // reported at the index of the 'İ' they came from. The '?' is at index 3
    // in the original input; the expansion of 'İ' must not shift it to 4.
    const result = normalize('İаб?');
    const question = result.unknown.find((u) => u.symbol === '?');
    expect(question).toEqual({ symbol: '?', index: 3 });
  });

  it('reports an astral character before an unknown symbol at its original index', () => {
    // '😀' (U+1F600) is a surrogate pair: one code point at code-point index 0.
    // It is itself unknown and reported at index 0; the '?' follows it at
    // code-point index 1, not shifted by the expansion into two UTF-16 units.
    const result = normalize('😀?');
    expect(result.unknown).toEqual([
      { symbol: '😀', index: 0 },
      { symbol: '?', index: 1 },
    ]);
  });

  it('reports code-point offsets, not UTF-16 offsets', () => {
    // The contract M7 will build highlighting on. These two indexing schemes
    // agree for every alphabet symbol, since all of them are in the BMP, and
    // diverge only around an astral character — which can only ever be an
    // unknown symbol. Pinned here so nobody reaches for slice() later.
    const input = 'а😀б?';

    const result = normalize(input);

    const question = result.unknown.find((u) => u.symbol === '?');
    expect(question).toEqual({ symbol: '?', index: 3 });
    // Array.from splits by code point, which is the indexing this contract
    // uses; the linter flags string spread because that is rarely intended.
    expect(Array.from(input)[3]).toBe('?');
    // The same character sits at a different offset in UTF-16 terms.
    expect(input.indexOf('?')).toBe(4);
  });

  it('reports the source index when a folded character is itself unknown', () => {
    // 'İ' is not in the alphabet; its lower-cased expansion ('i' + combining
    // dot) is reported at the index of the 'İ' it came from, not at a shifted
    // position.
    const result = normalize('İ');
    expect(result.unknown).toEqual([
      { symbol: 'i', index: 0 },
      { symbol: '\u0307', index: 0 },
    ]);
  });

  it('composes a decomposed ё (е + U+0308) back into ё with no unknowns', () => {
    // macOS and several clipboards hand over Cyrillic in NFD. NFC must be
    // applied to the whole cluster (base + combining mark), not to each code
    // point on its own, or the composition can never happen and the mark is
    // reported as an unknown symbol.
    const result = normalize('\u0435\u0308');
    expect(result.text).toBe('ё');
    expect(result.unknown).toHaveLength(0);
  });

  it('composes a decomposed й (и + U+0306) back into й with no unknowns', () => {
    const result = normalize('\u0438\u0306');
    expect(result.text).toBe('й');
    expect(result.unknown).toHaveLength(0);
  });

  it('does not shift positions when a decomposed ё is followed by an unknown', () => {
    // The decomposed ё occupies two code points (е at 0, U+0308 at 1); the '?'
    // is at code-point index 2 in the original input. Composition must not
    // shift it.
    const result = normalize('\u0435\u0308?');
    expect(result.text).toBe('ё');
    expect(result.unknown).toEqual([{ symbol: '?', index: 2 }]);
  });

  it('is invariant under NFD for generated alphabet text', () => {
    // Composition form must not change the result: whatever the input, folding
    // its NFD form yields the same text and the same unknowns. This is the
    // property that makes the decomposed-ё regression impossible to
    // reintroduce without the suite noticing.
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom(...PAGE_ALPHABET.symbols))
          .map((chars) => chars.join('')),
        (s) => normalize(s).text === normalize(s.normalize('NFD')).text
      ),
      { numRuns: 1000 }
    );
  });
});
