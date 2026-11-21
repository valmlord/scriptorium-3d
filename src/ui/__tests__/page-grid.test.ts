import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PAGE_LENGTH } from '@core/address';
import { PAGE_ALPHABET } from '@core/alphabet';
import { UnexpectedPageLengthError } from '@ui/errors';
import {
  READER_COLUMNS,
  READER_ROWS,
  highlightedLines,
  pageLines,
} from '@ui/page-grid';
import type { HighlightRange } from '@ui/page-grid';

/**
 * The grid is the part of the reader that is arithmetic rather than DOM, so it
 * is the part of the reader with unit tests: writing it into the DOM needs a
 * browser and is asserted end to end (`docs/testing.md` §1).
 *
 * `propertyRuns` is not used here, deliberately. It lives in
 * `src/core/__tests__`, and `@ui` may not reach into `core` by a relative path
 * (ADR-0029); what it exists for is Stryker, which runs `src/core`'s tests
 * alone (`vitest.stryker.config.ts`), so this file would not be capped by it
 * in any case.
 */

/** testing.md §2: at least 1000 cases. */
const PROPERTY_RUNS = 1000;

/** The alphabet of a page, as the characters a generated page is made of. */
const SYMBOLS = [...PAGE_ALPHABET.symbols];

/** A page of `PAGE_LENGTH` characters over the alphabet of SPEC §2. */
const pages = fc
  .array(fc.constantFrom(...SYMBOLS), {
    minLength: PAGE_LENGTH,
    maxLength: PAGE_LENGTH,
  })
  .map((symbols) => symbols.join(''));

/**
 * A range on the page, reaching the edges on purpose: anywhere, the whole
 * page, one ending at the last column of a line and one starting at the first.
 */
const ranges: fc.Arbitrary<HighlightRange> = fc.oneof(
  fc
    .integer({ min: 1, max: PAGE_LENGTH })
    .chain((length) =>
      fc
        .integer({ min: 0, max: PAGE_LENGTH - length })
        .map((offset) => ({ offset, length }))
    ),
  fc.constant({ offset: 0, length: PAGE_LENGTH }),
  fc
    .tuple(fc.integer({ min: 1, max: READER_ROWS }), fc.integer({ min: 1, max: 120 }))
    .map(([row, length]) => {
      const end = row * READER_COLUMNS;
      const clamped = Math.min(length, end);
      return { offset: end - clamped, length: clamped };
    }),
  fc
    .tuple(
      fc.integer({ min: 0, max: READER_ROWS - 1 }),
      fc.integer({ min: 1, max: 120 })
    )
    .map(([row, length]) => {
      const offset = row * READER_COLUMNS;
      return { offset, length: Math.min(length, PAGE_LENGTH - offset) };
    })
);

/** A page made of one repeated symbol. */
function pageOf(symbol: string): string {
  return symbol.repeat(PAGE_LENGTH);
}

describe('the reader grid', () => {
  it('holds exactly one page and not a character more', () => {
    // 40 by 80 is not a layout preference: it is the factorisation of
    // PAGE_LENGTH the reader is built on, and a grid that does not multiply
    // out to a page would lose or invent characters on every page.
    expect(READER_COLUMNS * READER_ROWS).toBe(PAGE_LENGTH);
  });

  it('cuts a page into 80 lines of 40 characters', () => {
    const lines = pageLines(pageOf('а'));

    expect(lines).toHaveLength(READER_ROWS);
    for (const line of lines) {
      expect(line).toHaveLength(READER_COLUMNS);
    }
  });

  it('keeps the characters in reading order', () => {
    const page = [...Array.from({ length: READER_ROWS }).keys()]
      .map((row) => SYMBOLS[row % SYMBOLS.length]?.repeat(READER_COLUMNS) ?? '')
      .join('');

    const lines = pageLines(page);

    expect(lines[0]).toBe(SYMBOLS[0]?.repeat(READER_COLUMNS));
    expect(lines[1]).toBe(SYMBOLS[1]?.repeat(READER_COLUMNS));
    expect(lines.at(-1)).toBe(
      SYMBOLS[(READER_ROWS - 1) % SYMBOLS.length]?.repeat(READER_COLUMNS)
    );
  });

  it('keeps a line of spaces, which is a line the alphabet can produce', () => {
    // Symbol 0 is a space (SPEC §2), so a run of them is ordinary text rather
    // than an edge case. Dropping it here would show as a short line on
    // screen, and `white-space: pre` in `reader.css` is the other half of it.
    const lines = pageLines(pageOf(PAGE_ALPHABET.symbols[0] ?? ' '));

    expect(lines).toHaveLength(READER_ROWS);
    expect(lines[0]).toBe(' '.repeat(READER_COLUMNS));
  });

  it('is reversible: the lines joined are the page again', () => {
    fc.assert(
      fc.property(pages, (page) => {
        expect(pageLines(page).join('')).toBe(page);
      }),
      { numRuns: PROPERTY_RUNS }
    );
  });

  it('refuses a page that is not 3200 characters, naming both lengths', () => {
    expect(() => pageLines(pageOf('а').slice(1))).toThrow(UnexpectedPageLengthError);
    expect(() => pageLines(pageOf('а').slice(1))).toThrow(
      /3199 characters, and a page is 3200/
    );
    expect(() => pageLines('')).toThrow(UnexpectedPageLengthError);
    expect(() => pageLines(`${pageOf('а')}а`)).toThrow(UnexpectedPageLengthError);
  });

  it('carries what was wrong on the refusal itself', () => {
    try {
      pageLines('');
      expect.unreachable('an empty page was accepted');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(UnexpectedPageLengthError);
      expect(error).toMatchObject({ received: 0, expected: PAGE_LENGTH });
    }
  });
});

describe('the highlight segments of the reader grid', () => {
  it('property: the highlight segments of every line concatenate to the page, and exactly the characters in [offset, offset + length) are marked', () => {
    fc.assert(
      fc.property(pages, ranges, (page, range) => {
        const lines = highlightedLines(page, range);

        expect(lines).toHaveLength(READER_ROWS);
        expect(lines.map((line) => line.map((s) => s.text).join('')).join('')).toBe(
          page
        );
        const marked = lines.flatMap((line) =>
          line.flatMap((segment) => Array.from(segment.text, () => segment.isMarked))
        );
        // One assertion per case rather than one per character: 3200 calls to
        // `expect` per run turn a 1000-run property into a 13-second test.
        const firstWrong = marked.findIndex(
          (isMarked, index) =>
            isMarked !== (index >= range.offset && index < range.offset + range.length)
        );
        expect(firstWrong).toBe(-1);
      }),
      { numRuns: PROPERTY_RUNS }
    );
  });

  it('never writes an empty segment, nor two neighbours that agree', () => {
    fc.assert(
      fc.property(ranges, (range) => {
        for (const line of highlightedLines(pageOf('а'), range)) {
          line.forEach((segment, index) => {
            expect(segment.text).not.toBe('');
            expect(segment.isMarked).not.toBe(line[index - 1]?.isMarked);
          });
        }
      }),
      { numRuns: PROPERTY_RUNS }
    );
  });

  it('marks up to the last column of a line and not a character of the next', () => {
    const lines = highlightedLines(pageOf('а'), { offset: 30, length: 10 });

    expect(lines[0]).toEqual([
      { text: 'а'.repeat(30), isMarked: false },
      { text: 'а'.repeat(10), isMarked: true },
    ]);
    expect(lines[1]).toEqual([{ text: 'а'.repeat(READER_COLUMNS), isMarked: false }]);
  });

  it('cuts a range spanning two lines at the edge between them', () => {
    const lines = highlightedLines(pageOf('а'), { offset: 38, length: 4 });

    expect(lines[0]).toEqual([
      { text: 'а'.repeat(38), isMarked: false },
      { text: 'аа', isMarked: true },
    ]);
    expect(lines[1]).toEqual([
      { text: 'аа', isMarked: true },
      { text: 'а'.repeat(38), isMarked: false },
    ]);
  });

  it('marks nothing without a range', () => {
    const lines = highlightedLines(pageOf('а'), null);

    for (const line of lines) {
      expect(line).toEqual([{ text: 'а'.repeat(READER_COLUMNS), isMarked: false }]);
    }
  });

  it('refuses a page that is not 3200 characters, as pageLines does', () => {
    expect(() => highlightedLines('', { offset: 0, length: 1 })).toThrow(
      UnexpectedPageLengthError
    );
  });
});
