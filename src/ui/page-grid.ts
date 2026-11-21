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
 * Pure, and in its own module for that reason: the layout of a page, and of
 * the phrase a search marks in it, is arithmetic over a string and is
 * unit-tested directly, where the reader that writes it to the DOM needs a
 * browser (`docs/testing.md` §1).
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

/**
 * The characters of a page to mark: `length` of them from `offset`.
 *
 * `offset` is the hit's code-point index into the page and also its UTF-16
 * index, because every alphabet symbol is one unit; `length` is the accepted
 * query's code-point length, not the raw input's, so a U+0451 typed decomposed,
 * as U+0435 and U+0308, is one character marked.
 */
export interface HighlightRange {
  readonly offset: number;
  readonly length: number;
}

/** A run of one line's characters, marked or not. */
export interface LineSegment {
  readonly text: string;
  readonly isMarked: boolean;
}

/**
 * Cut `text` into the grid's lines as `pageLines` does, each line split into
 * the runs inside and outside `range`.
 *
 * A line is at most three segments, before, inside and after, and a segment is
 * never empty, so a line the range does not touch is one unmarked segment. A
 * range spanning lines is cut at each line's edge, which is what lets the
 * reader keep one element per line and mark the phrase with an element per
 * line it crosses rather than one per character.
 */
export function highlightedLines(
  text: string,
  range: HighlightRange | null
): readonly (readonly LineSegment[])[] {
  return pageLines(text).map((line, row) => {
    if (range === null) {
      return [{ text: line, isMarked: false }];
    }
    const lineStart = row * READER_COLUMNS;
    // The range in this line's own columns, clamped to the line.
    const from = clamp(range.offset - lineStart);
    const to = clamp(range.offset + range.length - lineStart);
    const segments: LineSegment[] = [];
    pushSegment(segments, line.slice(0, from), false);
    pushSegment(segments, line.slice(from, to), true);
    pushSegment(segments, line.slice(Math.max(from, to)), false);
    return segments;
  });
}

function clamp(column: number): number {
  return Math.min(Math.max(column, 0), READER_COLUMNS);
}

function pushSegment(segments: LineSegment[], text: string, isMarked: boolean): void {
  if (text !== '') {
    segments.push({ text, isMarked });
  }
}
