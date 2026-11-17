import { PAGE_LENGTH } from '@core/address';

/**
 * Dedicated error types for the ways what reaches the reader can be wrong, in
 * the pattern of `src/core/errors.ts`: each carries the offending value and
 * what was expected of it.
 *
 * There is one, and it guards the boundary this layer actually has. The ranges
 * of an address are `core`'s and are refused there; a navigation event with no
 * transition is `@state`'s and is refused there. What arrives here from
 * outside is the *text of a page*, over a `postMessage` boundary
 * (`code-style.md` §1), and a page of the wrong length is the one way that
 * text can be wrong without looking wrong: 3199 characters lay out as 80 lines
 * with one gap nobody would notice.
 */

/**
 * A page arrived at the reader without being `PAGE_LENGTH` characters long.
 *
 * `PAGE_LENGTH` is the whole of the format's shape (SPEC §1), and the grid is
 * 40 by 80 because that is 3200. A page of another length would be laid out
 * silently with a short last line, so it is refused by name instead.
 */
export class UnexpectedPageLengthError extends Error {
  readonly received: number;
  readonly expected: number = PAGE_LENGTH;

  constructor(received: number) {
    super(
      `The reader was given a page of ${String(received)} characters, and a page is ${String(PAGE_LENGTH)} (SPEC section 1)`
    );
    this.name = 'UnexpectedPageLengthError';
    this.received = received;
  }
}
