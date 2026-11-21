import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { PAGE_LENGTH } from '@core/address';
import { PAGE_ALPHABET, normalize } from '@core/alphabet';
import {
  MAX_COMBINING_MARKS,
  MAX_NAMED_SYMBOLS,
  MAX_QUERY_INPUT_UNITS,
  judgeQuery,
} from '@ui/query';
import type {
  MessageSegment,
  NamedSymbol,
  QueryRefusal,
  QueryVerdict,
} from '@ui/query';

/**
 * Every fixture holding a combining mark is written with `\u` escapes, never
 * as the character itself: an editor or a formatter that normalizes to NFC
 * recomposes a decomposed `ё` silently, and the test then passes for the wrong
 * reason (which is what happened to the design's own mark-run fixture).
 */

/** testing.md §2: at least 1000 cases. */
const PROPERTY_RUNS = 1000;

const LETTERS = PAGE_ALPHABET.symbols.filter((symbol) => symbol !== ' ');

/** `ё` and `й` as two code points each, and their capitals. */
const DECOMPOSED = ['\u0435\u0308', '\u0438\u0306', '\u0415\u0308', '\u0418\u0306'];

/** Outside the alphabet and not whitespace. None is a combining mark. */
const FOREIGN = ['!', 'a', 'Z', '7', '\u{1F600}', 'ß'];

/** Whitespace that is not U+0020, which ADR-0035 reports rather than converts. */
const OTHER_WHITESPACE = ['\t', '\n', '\r', '\u00A0', '\u2028', '\u3000'];

/** One piece of a query a person could type, mostly ones the alphabet accepts. */
const typedPiece = fc.oneof(
  { weight: 30, arbitrary: fc.constantFrom(...LETTERS) },
  { weight: 10, arbitrary: fc.constantFrom(...LETTERS).map((s) => s.toUpperCase()) },
  { weight: 4, arbitrary: fc.constantFrom(...DECOMPOSED) },
  { weight: 8, arbitrary: fc.integer({ min: 1, max: 4 }).map((n) => ' '.repeat(n)) },
  { weight: 1, arbitrary: fc.constantFrom(...FOREIGN) },
  { weight: 1, arbitrary: fc.constantFrom(...OTHER_WHITESPACE) }
);

/** One symbol the alphabet accepts, typed one way or another. */
const acceptedPiece = fc.oneof(
  { weight: 30, arbitrary: fc.constantFrom(...PAGE_ALPHABET.symbols) },
  { weight: 2, arbitrary: fc.constantFrom(...DECOMPOSED) }
);

/**
 * Short inputs with runs of spaces anywhere, leading and trailing included,
 * and inputs either side of a page's length, where the last rule decides.
 */
const inputs = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.array(typedPiece, { maxLength: 40 }).map((p) => p.join('')),
  },
  {
    weight: 1,
    arbitrary: fc
      .array(acceptedPiece, { minLength: PAGE_LENGTH - 5, maxLength: PAGE_LENGTH + 5 })
      .map((pieces) => pieces.join('')),
  }
);

function refusalOf(verdict: QueryVerdict): QueryRefusal {
  if (verdict.isAccepted) {
    throw new Error(`expected a refusal, and "${verdict.query}" was accepted`);
  }
  return verdict.refusal;
}

function namedOf(verdict: QueryVerdict): readonly NamedSymbol[] {
  const refusal = refusalOf(verdict);
  if (refusal.reason !== 'unknown-symbols') {
    throw new Error(`expected unknown symbols, and the refusal was ${refusal.reason}`);
  }
  return refusal.named;
}

/** The message as one string, the way it is read aloud. */
function spoken(message: readonly MessageSegment[]): string {
  return message.map((segment) => segment.text).join('');
}

function glyphsOf(message: readonly MessageSegment[]): readonly string[] {
  return message
    .filter((segment) => segment.kind === 'glyph')
    .map((segment) => segment.text);
}

describe('judging a search query', () => {
  it('property: an input is accepted exactly when normalize reports no unknown and the text is 1 to PAGE_LENGTH code points, and the accepted text equals normalize(input).text', () => {
    // Recomposed, these would be one unit each and the property would never
    // see a decomposed letter.
    expect(DECOMPOSED.map((symbol) => symbol.length)).toEqual([2, 2, 2, 2]);
    // Likewise, any of these turned into U+0020 would be accepted, and the
    // property would never see the whitespace it reports.
    expect(OTHER_WHITESPACE.map((space) => space.codePointAt(0))).toEqual([
      0x09, 0x0a, 0x0d, 0xa0, 0x2028, 0x3000,
    ]);

    fc.assert(
      fc.property(inputs, (input) => {
        const expected = normalize(input);
        const length = Array.from(expected.text).length;
        const isAcceptable =
          expected.unknown.length === 0 && length >= 1 && length <= PAGE_LENGTH;

        const verdict = judgeQuery(input);

        expect(verdict.isAccepted).toBe(isAcceptable);
        if (verdict.isAccepted) {
          expect(verdict.query).toBe(expected.text);
        }
      }),
      { numRuns: PROPERTY_RUNS }
    );
  });

  it('keeps leading, trailing and inner runs of spaces as typed', () => {
    const verdict = judgeQuery('  мир   дом  ');

    expect(verdict).toEqual({ isAccepted: true, query: '  мир   дом  ' });
  });

  it('a lone tab is refused naming U+0009 at position 1, not as empty', () => {
    const verdict = judgeQuery('\t');

    expect(namedOf(verdict)).toEqual([
      { position: 1, cluster: '\t', codePoints: ['U+0009'], isPrintable: false },
    ]);
    expect(spoken(refusalOf(verdict).message)).toContain('U+0009 at position 1');
  });

  it('an input with nothing in it is refused as empty', () => {
    const refusal = refusalOf(judgeQuery(''));

    expect(refusal.reason).toBe('empty');
    expect(spoken(refusal.message)).toBe('The query is empty.');
  });

  it('a line feed is refused by name, not turned into a space', () => {
    expect(namedOf(judgeQuery('мир\nдом'))).toEqual([
      { position: 4, cluster: '\n', codePoints: ['U+000A'], isPrintable: false },
    ]);
    expect(
      namedOf(judgeQuery('мир\r\nдом')).map(({ position, codePoints }) => ({
        position,
        codePoints,
      }))
    ).toEqual([
      { position: 4, codePoints: ['U+000D'] },
      { position: 5, codePoints: ['U+000A'] },
    ]);
    for (const [space, label] of [
      ['\u00A0', 'U+00A0'],
      ['\u2028', 'U+2028'],
      ['\u3000', 'U+3000'],
    ] as const) {
      expect(namedOf(judgeQuery(`мир${space}дом`))).toEqual([
        { position: 4, cluster: space, codePoints: [label], isPrintable: false },
      ]);
    }
  });

  it('a refused combining mark is named with the letter it sits on', () => {
    const stressedMir = '\u043C\u0438\u0301\u0440';
    const stressedPrivet = '\u043F\u0440\u0438\u0432\u0435\u0301\u0442';

    const mir = namedOf(judgeQuery(stressedMir));
    const privet = namedOf(judgeQuery(stressedPrivet));

    expect(mir).toEqual([
      {
        position: 2,
        cluster: '\u0438\u0301',
        codePoints: ['U+0438', 'U+0301'],
        isPrintable: true,
      },
    ]);
    expect(mir[0]?.codePoints).not.toEqual(['U+0438']);
    expect(
      privet.map(({ position, codePoints }) => ({ position, codePoints }))
    ).toEqual([{ position: 5, codePoints: ['U+0435', 'U+0301'] }]);
  });

  it('a combining mark at the very start is a cluster of its own, named by code point', () => {
    const verdict = judgeQuery('\u0301\u043C\u0438\u0440');

    expect(namedOf(verdict)).toEqual([
      { position: 1, cluster: '\u0301', codePoints: ['U+0301'], isPrintable: false },
    ]);
    expect(glyphsOf(refusalOf(verdict).message)).toEqual([]);
  });

  it('a Hangul filler is named by code point without a glyph', () => {
    // U+3164 is a letter (Lo) that renders blank; only
    // Default_Ignorable_Code_Point keeps it out of the glyphs.
    const verdict = judgeQuery('мир\u3164');

    expect(namedOf(verdict)).toEqual([
      { position: 4, cluster: '\u3164', codePoints: ['U+3164'], isPrintable: false },
    ]);
    expect(glyphsOf(refusalOf(verdict).message)).toEqual([]);
  });

  it('an astral character is named with five hex digits and not split', () => {
    const verdict = judgeQuery('мир\u{1F600}');

    expect(namedOf(verdict)).toEqual([
      { position: 4, cluster: '\u{1F600}', codePoints: ['U+1F600'], isPrintable: true },
    ]);
    expect(glyphsOf(refusalOf(verdict).message)).toEqual(['\u{1F600}']);
  });

  it('U+10FFFD is named with six', () => {
    expect(namedOf(judgeQuery('\u{10FFFD}'))).toEqual([
      {
        position: 1,
        cluster: '\u{10FFFD}',
        codePoints: ['U+10FFFD'],
        isPrintable: false,
      },
    ]);
  });

  it('a lone surrogate is named as itself', () => {
    expect(namedOf(judgeQuery('мир\uD800'))).toEqual([
      { position: 4, cluster: '\uD800', codePoints: ['U+D800'], isPrintable: false },
    ]);
  });

  it('unknown characters are named by what was typed, with code point and one-based position', () => {
    const verdict = judgeQuery('мир!a');

    expect(namedOf(verdict)).toEqual([
      { position: 4, cluster: '!', codePoints: ['U+0021'], isPrintable: true },
      { position: 5, cluster: 'a', codePoints: ['U+0061'], isPrintable: true },
    ]);
    expect(spoken(refusalOf(verdict).message)).toBe(
      'Not in the alphabet: ! (U+0021) at position 4, a (U+0061) at position 5. Positions count from 1.'
    );
    expect(namedOf(judgeQuery('мирA'))).toEqual([
      { position: 4, cluster: 'A', codePoints: ['U+0041'], isPrintable: true },
    ]);
  });

  it('a character that folds to two unknown code points is named once, as typed, and not counted again', () => {
    // U+0130 lower-cases to `i` and U+0307, both reported at the index of the
    // U+0130.
    const refusal = refusalOf(judgeQuery('мир\u0130'));

    expect(spoken(refusal.message)).toBe(
      'Not in the alphabet: \u0130 (U+0130) at position 4. Positions count from 1.'
    );
    expect(refusal).toMatchObject({
      reason: 'unknown-symbols',
      named: [
        { position: 4, cluster: '\u0130', codePoints: ['U+0130'], isPrintable: true },
      ],
      unnamed: 0,
    });
  });

  it('ten characters that each fold to two unknown code points are named eight and counted two', () => {
    // Twenty reported indices, ten distinct: the count is of characters typed,
    // not of code points `normalize` reported for them.
    const refusal = refusalOf(judgeQuery('\u0130'.repeat(10)));
    const eightNamed = [1, 2, 3, 4, 5, 6, 7, 8]
      .map((position) => `\u0130 (U+0130) at position ${String(position)}`)
      .join(', ');

    expect(spoken(refusal.message)).toBe(
      `Not in the alphabet: ${eightNamed}, and 2 more. Positions count from 1.`
    );
    expect(refusal).toMatchObject({ reason: 'unknown-symbols', unnamed: 2 });
  });

  it('a bidi override, a line separator and a zero-width space are named by code point alone', () => {
    for (const [character, label] of [
      ['\u202E', 'U+202E'],
      ['\u2028', 'U+2028'],
      ['\u200B', 'U+200B'],
    ] as const) {
      const verdict = judgeQuery(`мир${character}`);

      expect(namedOf(verdict)).toEqual([
        { position: 4, cluster: character, codePoints: [label], isPrintable: false },
      ]);
      const message = refusalOf(verdict).message;
      expect(glyphsOf(message)).toEqual([]);
      expect(spoken(message)).not.toContain(character);
    }
  });

  it('a printable RTL letter is wrapped in its own bdi', () => {
    const message = refusalOf(judgeQuery('мирאдом')).message;

    expect(glyphsOf(message)).toEqual(['א']);
    const plainText = message
      .filter((segment) => segment.kind === 'text')
      .map((segment) => segment.text)
      .join('');
    expect(plainText).not.toContain('א');
    expect(plainText).toContain('(U+05D0) at position 4');
  });

  it('more than eight unknown characters are named eight and counted', () => {
    const verdict = judgeQuery('!'.repeat(MAX_NAMED_SYMBOLS + 3));

    const refusal = refusalOf(verdict);
    expect(namedOf(verdict).map((symbol) => symbol.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(refusal).toMatchObject({ reason: 'unknown-symbols', unnamed: 3 });
    expect(spoken(refusal.message)).toMatch(/, and 3 more\. Positions count from 1\.$/);
  });

  it('exactly eight unknown characters are all named and none counted', () => {
    const refusal = refusalOf(judgeQuery('!'.repeat(MAX_NAMED_SYMBOLS)));

    expect(refusal).toMatchObject({ reason: 'unknown-symbols', unnamed: 0 });
    expect(spoken(refusal.message)).not.toContain('more');
  });

  it('raw input past 6400 units is refused before normalize runs', () => {
    const spy = vi.fn(normalize);

    const refusal = refusalOf(judgeQuery('а'.repeat(MAX_QUERY_INPUT_UNITS + 1), spy));

    expect(MAX_QUERY_INPUT_UNITS).toBe(6400);
    expect(spy).not.toHaveBeenCalled();
    expect(refusal).toMatchObject({ reason: 'input-too-long', units: 6401 });
    expect(spoken(refusal.message)).toContain('6401');
    expect(spoken(refusal.message)).toContain('6400');
  });

  it('raw input of exactly 6400 units reaches normalize', () => {
    const spy = vi.fn(normalize);
    const decomposed = '\u0435\u0308'.repeat(PAGE_LENGTH);
    expect(decomposed).toHaveLength(MAX_QUERY_INPUT_UNITS);

    judgeQuery(decomposed, spy);

    expect(spy).toHaveBeenCalledOnce();
  });

  it('a page typed in decomposed form, 6400 units, is accepted as 3200 symbols', () => {
    const decomposed = '\u0435\u0308'.repeat(PAGE_LENGTH);

    const verdict = judgeQuery(decomposed);

    expect(decomposed).toHaveLength(MAX_QUERY_INPUT_UNITS);
    expect(verdict).toEqual({ isAccepted: true, query: 'ё'.repeat(PAGE_LENGTH) });
  });

  it('a run of two combining marks is refused naming the code-point position of the character it sits on, before normalize runs', () => {
    const fixture = '\u{1F600}\u{1F600}a\u0301\u0301\u0440';
    const spy = vi.fn(normalize);
    // The fixture must still hold its run: a fixture recomposed or stripped
    // would make the rest of this test vacuous.
    expect(/\p{M}{2,}/u.exec(fixture)?.index).toBe(5);

    const refusal = refusalOf(judgeQuery(fixture, spy));

    expect(spy).not.toHaveBeenCalled();
    expect(refusal).toMatchObject({
      reason: 'mark-run',
      marks: 2,
      base: { position: 3, cluster: 'a', codePoints: ['U+0061'], isPrintable: true },
    });
    const message = spoken(refusal.message);
    expect(message).toBe(
      '2 combining marks in a row on a (U+0061) at position 3, and a symbol of the alphabet carries at most 1. Positions count from 1.'
    );
    expect(message).not.toContain('U+0301');
  });

  it('counts the marks of a run in code points, not UTF-16 units', () => {
    // U+1D167 is an astral combining mark, two units each.
    const refusal = refusalOf(judgeQuery('a\u{1D167}\u{1D167}\u{1D167}'));

    expect(refusal).toMatchObject({ reason: 'mark-run', marks: 3 });
  });

  it('a base with one mark passes the pre-check and two do not', () => {
    const one = judgeQuery(`\u0438${'\u0306'.repeat(MAX_COMBINING_MARKS)}`);
    const two = judgeQuery(`\u0438${'\u0306'.repeat(MAX_COMBINING_MARKS + 1)}`);

    expect(one).toEqual({ isAccepted: true, query: 'й' });
    expect(refusalOf(two).reason).toBe('mark-run');
  });

  it('a run of combining marks at the very start is refused as having no character before it', () => {
    const spy = vi.fn(normalize);

    const refusal = refusalOf(judgeQuery('\u0301\u0301\u043C\u0438\u0440', spy));

    expect(spy).not.toHaveBeenCalled();
    expect(refusal.reason).toBe('leading-marks');
    expect(spoken(refusal.message)).toBe(
      'Combining marks at position 1 with no character before them.'
    );
  });

  it('a query longer than a page after normalizing is refused naming both lengths', () => {
    const refusal = refusalOf(judgeQuery('а'.repeat(PAGE_LENGTH + 1)));

    expect(refusal).toMatchObject({ reason: 'too-long', length: PAGE_LENGTH + 1 });
    expect(spoken(refusal.message)).toBe(
      'The query is 3201 symbols long after normalizing, and a page holds 3200.'
    );
  });

  it('a query of exactly a page is accepted', () => {
    expect(judgeQuery('а'.repeat(PAGE_LENGTH))).toEqual({
      isAccepted: true,
      query: 'а'.repeat(PAGE_LENGTH),
    });
  });
});
