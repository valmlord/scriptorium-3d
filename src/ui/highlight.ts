import type { Address } from '@core/address';
import type { HighlightRange } from './page-grid';

/**
 * The last search hit, which the reader projects as the marked phrase.
 *
 * **The highlight is a pure function of the machine's address and the last
 * hit**, and this module holds the second half and nothing else. It is not a
 * second record of where the user is: the reader marks the range only while
 * the machine has the hit's address open (`highlightAt`), so turning the page
 * clears the mark without anyone clearing it, and turning back shows it again.
 *
 * The search session writes it, before it tells the machine to move, so the
 * reader finds the hit already here when the machine's notification reaches
 * it. The reader also listens here, because a hit on the page already open
 * moves the machine nowhere and so notifies nobody through it.
 */

/** Where a search placed the accepted query, and how many characters it is. */
export interface Hit {
  readonly address: Address;
  /** The code-point index into the page where the query starts. */
  readonly offset: number;
  /** The accepted query's length in code points, not the raw input's. */
  readonly length: number;
}

/** The one holder of the last hit. */
export interface Highlight {
  readonly hit: Hit | null;
  /** Replace the last hit and tell every listener. */
  set(hit: Hit): void;
  /** Watch the hit. Returns the function that stops watching. */
  subscribe(listener: () => void): () => void;
}

export function createHighlight(): Highlight {
  let last: Hit | null = null;
  const listeners = new Set<() => void>();
  return {
    get hit(): Hit | null {
      return last;
    },
    set(hit: Hit): void {
      last = hit;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The range to mark on the page at `address`, which is the hit's or none. */
export function highlightAt(
  hit: Hit | null,
  address: Address | null
): HighlightRange | null {
  if (hit === null || address === null || !isSamePage(hit.address, address)) {
    return null;
  }
  return { offset: hit.offset, length: hit.length };
}

/** Whether two addresses name the same page. `room` is a `bigint`. */
function isSamePage(one: Address, other: Address): boolean {
  return (
    one.room === other.room &&
    one.wall === other.wall &&
    one.shelf === other.shelf &&
    one.volume === other.volume &&
    one.page === other.page
  );
}
