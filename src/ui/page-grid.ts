import { PAGE_LENGTH } from '@core/address';
import { UnexpectedPageLengthError } from './errors';

/**
 * The reader's grid: 3200 characters as 80 lines of 40.
 *
 * **One element per line, not one per character.** 3200 spans are 3200 nodes
 * the browser lays out on every turn, and a selection dragged across them
 * comes back with artefacts between the characters. 80 line elements select
 * cleanly and give the newlines for free, which is what makes the text on
 * screen the page rather than a picture of it.
 *
 * The grid is a grid only because the font has a fixed character advance, so
 * the monospace stack in `./reader.css` is part of this decision and not a
 * style detail: in a proportional font these 80 lines are 80 ragged rows.
 *
 * Pure, and in its own module for that reason: the layout of a page is
 * arithmetic over a string and is unit-tested directly, where everything else
 * in this layer needs a browser (`docs/testing.md` §1).
 */

/** Characters across one line of the grid. */
export const READER_COLUMNS = 40;

/** Lines down the grid. `READER_COLUMNS * READER_ROWS` is `PAGE_LENGTH`. */
export const READER_ROWS = 80;

/**
 * Cut `text` into the grid's lines, in reading order.
 *
 * Refuses a page that is not `PAGE_LENGTH` characters: the text crosses a
 * `postMessage` boundary to get here, and the alternative is 80 lines with one
 * short row that nobody would notice (`./errors.ts`).
 */
export function pageLines(text: string): readonly string[] {
  if (text.length !== PAGE_LENGTH) {
    throw new UnexpectedPageLengthError(text.length);
  }
  const lines: string[] = [];
  for (let row = 0; row < READER_ROWS; row += 1) {
    lines.push(text.slice(row * READER_COLUMNS, (row + 1) * READER_COLUMNS));
  }
  return lines;
}
