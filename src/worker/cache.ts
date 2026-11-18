import {
  PAGES_PER_BOOK,
  PAGES_PER_ROOM,
  PAGE_LENGTH,
  RADIX,
  toLinear,
} from '@core/address';
import type { Address, BookAddress } from '@core/address';
// The specific modules rather than the barrel, although `worker` may import
// it: this module is read on the **main thread**, in front of the boundary,
// so the barrel would put the generation surface it re-exports into the
// main-thread bundle (ADR-0029, ADR-0032). The guard is in
// `src/__tests__/production-bundle.test.ts`.
import { TITLE_LENGTH } from '@core/format';

/**
 * The cache the worker client sits behind: generated pages and titles, kept by
 * recency of use, bounded in bytes.
 *
 * It lives on the main thread in front of the worker rather than inside it. A
 * `getPage` costs 1.0 to 1.35 ms on `ubuntu-latest`, a `getTitle` 0.73 to
 * 0.98 ms and a shelf of 32 titles 25.1 to 33.4 ms — one and a half to two
 * frames at 60 fps. A hit has to be free beside that, and a hit served from
 * inside the worker would still cost two `postMessage` hops and a task-queue
 * turn, which is the one part of the round trip the cache can remove entirely.
 *
 * **The budget is bytes, not entries.** A page is `PAGE_LENGTH` UTF-16
 * characters, a title `TITLE_LENGTH`: 6.4 KB against 50 bytes before keys,
 * three orders of magnitude apart. "A hundred entries" would therefore mean
 * 640 KB of pages or 5 KB of titles depending on which store it landed in,
 * which is a number that means nothing. Pages and titles get separate
 * ceilings, each derived below from the access pattern that revisits them.
 *
 * **Purity and determinism.** No clock, no timer, no `Math.random()`
 * (`architecture.md` §5). Recency is the order of use, nothing else, and the
 * order is read off a `Map`, whose iteration order the language specifies to be
 * insertion order. So the same sequence of operations evicts the same entries
 * on every machine and in every run, which is what makes eviction assertable
 * rather than merely plausible.
 */

/**
 * Bytes per character of a JavaScript string.
 *
 * Strings are UTF-16 and `String.prototype.length` counts code units, so the
 * byte figures below are code units times two. The page and room alphabets are
 * both inside the Basic Multilingual Plane (`core/alphabet.ts`), so no
 * character of a page, a title or a key is a surrogate pair and `length` is the
 * character count as well as the code-unit count. This counts the characters an
 * entry holds, not the `Map` node that holds them: the engine's per-entry
 * bookkeeping is not observable from here, and a budget cannot be built on a
 * number that cannot be read.
 */
const BYTES_PER_CHARACTER = 2;

/**
 * The longest a key can be.
 *
 * A key is a linear index rendered in base `RADIX`, and the largest linear
 * index in the library is `LIBRARY_SIZE - 1`, one below `RADIX ** PAGE_LENGTH`.
 * That is `PAGE_LENGTH` base-`RADIX` digits — the key of a page is as long as
 * the page it names, and the key of a title is 128 times the title. Keys are
 * therefore counted against the budget rather than dismissed as overhead;
 * ignoring them would let the title store hold 128 times the bytes it claims.
 */
const MAX_KEY_LENGTH = PAGE_LENGTH;

/** What one page entry costs at the far end of the library: 12 800 bytes. */
const MAX_PAGE_ENTRY_BYTES = (MAX_KEY_LENGTH + PAGE_LENGTH) * BYTES_PER_CHARACTER;

/** What one title entry costs at the far end of the library: 6 450 bytes. */
const MAX_TITLE_ENTRY_BYTES = (MAX_KEY_LENGTH + TITLE_LENGTH) * BYTES_PER_CHARACTER;

/** Volumes in one room: 4 walls * 5 shelves * 32 volumes = 640 (SPEC §3). */
const VOLUMES_PER_ROOM = PAGES_PER_ROOM / PAGES_PER_BOOK;

/**
 * The ceiling for page text: one whole volume at the worst cost an entry can
 * have, 410 * 12 800 = 5 248 000 bytes.
 *
 * One volume is the bound of the access pattern that revisits a page at all.
 * Reading is page-at-a-time inside a book — flip forward, flip back, follow a
 * search hit and return to it — and a page revisited across volumes is a
 * coincidence, not a pattern worth 6.4 KB of retention each. So the budget is
 * set to the largest working set the reader can actually have, and the
 * multiplier is `PAGES_PER_BOOK` rather than a round number chosen to look
 * like one: at 1.0 to 1.35 ms a page, a full volume retained is about half a
 * second of generation that a reader walking a book never pays twice.
 *
 * It is written as volumes times the worst-case entry rather than as a figure
 * in megabytes because the worst case is the realistic one here. A key is only
 * short for a room near the start of the library, and a room reached by a deep
 * link or by "open a random book" has a 3197-digit name.
 */
export const PAGE_BUDGET_BYTES = PAGES_PER_BOOK * MAX_PAGE_ENTRY_BYTES;

/**
 * The ceiling for titles: one whole room at the worst cost an entry can have,
 * 640 * 6 450 = 4 128 000 bytes.
 *
 * One room is the bound of the access pattern that revisits a title. Titles are
 * resolved when the camera is close enough to read them and cancelled when it
 * is not (`architecture.md` §3), and inside a room the camera turns: look at a
 * wall, turn to the next, turn back. Four of the six walls carry shelves, so
 * the set a turn can revisit is the room, and a room's worth of titles is 640.
 * At 25.1 to 33.4 ms a shelf of 32 that is 500 to 670 ms of generation — ten to
 * twenty frames' worth — not paid again for turning around.
 *
 * Leaving a room drops its titles, which is the intended behaviour and not a
 * gap: the room behind you is one `ROOM_COUNT` out of ~10^4975, and keeping it
 * would be keeping an arbitrary room forever.
 */
export const TITLE_BUDGET_BYTES = VOLUMES_PER_ROOM * MAX_TITLE_ENTRY_BYTES;

/** A title is the opening of page 0 of its volume (SPEC §5). */
const FIRST_PAGE_OF_VOLUME = 0;

/** A stored value together with what it costs, so the cost is computed once. */
interface CacheEntry {
  readonly value: string;
  readonly bytes: number;
}

/**
 * A least-recently-used cache from string keys to string values, bounded by the
 * total size in bytes of the keys and values it holds.
 *
 * ## Contract
 *
 * 1. **The ceiling holds.** After every operation, the sum over stored entries
 *    of `(key.length + value.length) * BYTES_PER_CHARACTER` is at most
 *    `budgetBytes`. There is no transient state in which it is exceeded and no
 *    operation that can exceed it.
 * 2. **Recency is the order of use.** A `get` that finds an entry and a `set`
 *    both move that key to the most-recent end. A `get` that misses, and
 *    `keysLeastRecentFirst`, move nothing.
 * 3. **Eviction takes the least recently used entry, and only as many as the
 *    ceiling requires.** Admitting an entry evicts from the least-recent end
 *    until the total fits, and stops there; it never takes a second entry it
 *    did not have to, and never takes the entry it has just admitted.
 * 4. **An entry that cannot fit the budget on its own is refused, not
 *    admitted.** The cache is left byte for byte as it was — including any
 *    entry already stored under that key, which is not displaced by a value
 *    that could not have been kept. The alternative, evicting everything and
 *    then storing it, trades a whole working set for one entry that the next
 *    insertion would evict anyway; and a refusal is a cache miss, which every
 *    caller already handles. With the two ceilings above no page or title can
 *    be refused — the largest page entry is one 410th of its budget — so this
 *    rule is what a budget too small for its contents does, not a case the
 *    library reaches.
 * 5. **Nothing is read but the arguments.** No clock, no counter outside the
 *    structure, no randomness. The same operations in the same order produce
 *    the same contents and the same recency order, always.
 *
 * Replacing the value under an existing key is an ordinary `set`: the old entry
 * is discharged from the total before the new one is counted, so a key cannot
 * be paid for twice.
 */
export class ByteBudgetedLru {
  /**
   * Insertion-ordered, and that order *is* the recency order: a promotion is a
   * `delete` followed by a `set`, which moves the key to the end. The first key
   * the iterator yields is the next one eviction will take.
   */
  private readonly entries = new Map<string, CacheEntry>();

  private storedBytes = 0;

  /**
   * @param budgetBytes The ceiling of contract rule 1. A budget below the cost
   * of a single entry is legal and makes every `set` a refusal under rule 4;
   * nothing in the structure special-cases it.
   */
  constructor(readonly budgetBytes: number) {}

  /** What the stored keys and values add up to. Never above `budgetBytes`. */
  get bytes(): number {
    return this.storedBytes;
  }

  /** How many entries are stored. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * The value for `key`, or `undefined` if it is not stored.
   *
   * A hit promotes the key to the most-recent end, which is the whole point of
   * reading through a cache rather than around it: the next eviction will not
   * take what has just been used.
   */
  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /**
   * Store `value` under `key`, evicting from the least-recent end until the
   * total fits the budget.
   *
   * Returns nothing: an admission the caller must check would be a second
   * contract to keep in step with rule 4, and a refusal is already observable
   * the way every other miss is — the next `get` returns `undefined` and the
   * caller computes the value again.
   */
  set(key: string, value: string): void {
    const bytes = entryBytes(key, value);
    // Refused before anything is touched, so rule 4's "byte for byte as it
    // was" holds for the entry already under this key as well.
    if (bytes > this.budgetBytes) {
      return;
    }
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.storedBytes -= previous.bytes;
      this.entries.delete(key);
    }
    this.entries.set(key, { value, bytes });
    this.storedBytes += bytes;
    this.evictUntilWithinBudget();
  }

  /**
   * The stored keys from least to most recently used: the order eviction will
   * take them in.
   *
   * It reads the recency order without disturbing it, which `get` cannot do.
   * A fresh array rather than the live iterator, so that a caller holding it
   * cannot be surprised by a later `set`, and O(size) — diagnostics and tests,
   * never a lookup path.
   */
  keysLeastRecentFirst(): readonly string[] {
    return [...this.entries.keys()];
  }

  /**
   * Drop least-recently-used entries until the total fits.
   *
   * The budget is checked before each deletion rather than after, so no entry
   * is taken that the ceiling did not require (rule 3). The entry just admitted
   * is safe without a check for it: `set` has already established that it fits
   * the budget on its own, so the total is within budget no later than the step
   * that would reach it.
   *
   * Deleting from a `Map` while iterating its entries is specified behaviour: a
   * key removed before the iterator reaches it is simply not visited.
   */
  private evictUntilWithinBudget(): void {
    for (const [key, entry] of this.entries) {
      if (this.storedBytes <= this.budgetBytes) {
        return;
      }
      this.entries.delete(key);
      this.storedBytes -= entry.bytes;
    }
  }
}

/** What an entry costs: its key and its value, in bytes. */
function entryBytes(key: string, value: string): number {
  return (key.length + value.length) * BYTES_PER_CHARACTER;
}

/**
 * The two caches the worker client reads through, keyed by address.
 *
 * **Pages and titles are separate stores with separate budgets**, which is what
 * makes the ceilings above meaningful and also what keeps the two keyspaces
 * apart: the title of a volume and page 0 of that same volume share a linear
 * index, so they would collide in one map — the same key naming 25 characters
 * in one store and 3200 in the other, each overwriting the other at a tenth of
 * the cost it was admitted for. Two stores make that collision unrepresentable
 * rather than guarded against, and give each budget the property its test
 * asserts: filling one evicts nothing from the other.
 *
 * Keys are the linear index rendered as a string. An `Address` is a plain
 * object, so two addresses naming the same page are different objects and
 * identity is not a key; and the structural key a `Map` could be given would be
 * a string in the end anyway. `toLinear` is the one canonical ordering
 * (SPEC §3), so the rendering is total and injective over the address space:
 * distinct addresses cannot share a key, and the same address cannot produce
 * two.
 */
export class GenerationCache {
  private readonly pages = new ByteBudgetedLru(PAGE_BUDGET_BYTES);
  private readonly titles = new ByteBudgetedLru(TITLE_BUDGET_BYTES);

  /** The cached text of one page, or `undefined`. A hit promotes it. */
  getPage(address: Address): string | undefined {
    return this.pages.get(pageKey(address));
  }

  /** Cache the text of one page. */
  setPage(address: Address, text: string): void {
    this.pages.set(pageKey(address), text);
  }

  /** The cached title of one volume, or `undefined`. A hit promotes it. */
  getTitle(book: BookAddress): string | undefined {
    return this.titles.get(titleKey(book));
  }

  /** Cache the title of one volume. */
  setTitle(book: BookAddress, title: string): void {
    this.titles.set(titleKey(book), title);
  }

  /** Bytes held by page text. At most `PAGE_BUDGET_BYTES`. */
  get pageBytes(): number {
    return this.pages.bytes;
  }

  /** Bytes held by titles. At most `TITLE_BUDGET_BYTES`. */
  get titleBytes(): number {
    return this.titles.bytes;
  }

  /** How many pages are cached. */
  get pageCount(): number {
    return this.pages.size;
  }

  /** How many titles are cached. */
  get titleCount(): number {
    return this.titles.size;
  }
}

/**
 * The key of a page: its linear index in base `RADIX`.
 *
 * Base `RADIX` rather than base 10 because `toString` is native for both and
 * the base-36 form is 3200 characters where the decimal form is 4981 — a third
 * less to hold, for a key nobody reads. The conversion is the documented cost
 * of a structural key: V8 renders a 16545-bit value in ~0.1 ms, an order of
 * magnitude under the 1.0 to 1.35 ms generation it saves, and it is paid once
 * per lookup rather than once per character.
 */
function pageKey(address: Address): string {
  return toLinear(address).toString(RADIX);
}

/**
 * The key of a title: the linear index of page 0 of its volume.
 *
 * A title *is* the opening of page 0 (SPEC §5), so that index names it exactly.
 * It is also the key page 0 itself would get, which is why titles are a
 * separate store rather than a prefixed key in a shared one — see
 * `GenerationCache`.
 */
function titleKey(book: BookAddress): string {
  return toLinear({ ...book, page: FIRST_PAGE_OF_VOLUME }).toString(RADIX);
}
