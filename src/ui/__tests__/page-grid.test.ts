import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PAGE_LENGTH } from '@core/address';
import { PAGE_ALPHABET } from '@core/alphabet';
import { UnexpectedPageLengthError } from '@ui/errors';
import { READER_COLUMNS, READER_ROWS, pageLines } from '@ui/page-grid';

/**
 * The grid is the one part of the reader that is arithmetic rather than DOM,
 * so it is the one part with unit tests: everything else in `@ui` needs a
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
