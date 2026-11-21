import {
  PAGES_PER_BOOK,
  PAGES_PER_ROOM,
  PAGE_LENGTH,
  RADIX,
  ROOM_COUNT,
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
 * What separates a key's room part from its index within the room.
 *
 * Neither part can contain it: both are rendered in base `RADIX`, whose digits
 * are `0-9a-z`, and a negative room only adds a leading `-`. Without it the
 * two parts could not be told apart — room 1 at index 71 and room 37 at index
 * 35 would both be `11z`.
 */
const KEY_SEPARATOR = ':';

/**
 * The longest room name, the last room's: 3197 base-`RADIX` digits (SPEC §3).
 *
 * Computed rather than written out so that it moves with `PAGE_LENGTH` and
 * `PAGES_PER_ROOM`; it is one conversion at module load, 0.1 ms under Node.
 */
const LONGEST_ROOM_PART_LENGTH = (ROOM_COUNT - 1n).toString(RADIX).length;

/**
 * The longest index within a room: `PAGES_PER_ROOM - 1` = 262 399, which is
 * `5mgv`, 4 base-`RADIX` digits.
 */
const LONGEST_INDEX_PART_LENGTH = (PAGES_PER_ROOM - 1).toString(RADIX).length;

/**
 * The longest a key can be: 3197 + 1 + 4 = 3202 characters.
 *
 * A key is a room name, the separator and an index within the room (see
 * `GenerationCache`), so at the far end of the library the key of a page is
 * slightly longer than the page it names, and the key of a title is 128 times
 * the title. Keys are therefore counted against the budget rather than
 * dismissed as overhead; ignoring them would let the title store hold 128
 * times the bytes it claims.
 */
const MAX_KEY_LENGTH =
  LONGEST_ROOM_PART_LENGTH + KEY_SEPARATOR.length + LONGEST_INDEX_PART_LENGTH;

/** What one page entry costs at the far end of the library: 12 804 bytes. */
const MAX_PAGE_ENTRY_BYTES = (MAX_KEY_LENGTH + PAGE_LENGTH) * BYTES_PER_CHARACTER;

/** What one title entry costs at the far end of the library: 6 454 bytes. */
const MAX_TITLE_ENTRY_BYTES = (MAX_KEY_LENGTH + TITLE_LENGTH) * BYTES_PER_CHARACTER;

/** Volumes in one room: 4 walls * 5 shelves * 32 volumes = 640 (SPEC §3). */
const VOLUMES_PER_ROOM = PAGES_PER_ROOM / PAGES_PER_BOOK;

/**
 * The ceiling for page text: one whole volume at the worst cost an entry can
 * have, 410 * 12 804 = 5 249 640 bytes.
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
 * 640 * 6 454 = 4 130 560 bytes.
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
 * How many room names `RoomNames` remembers.
 *
 * Two rather than one because one thrashes as soon as keys from two rooms
 * interleave, converting the room again on every key (about 50 ms per 64 keys
 * in Chromium and 20 ms in WebKit). M7 cannot interleave: a late reply to a
 * cancelled request is never cached and one shelf is in flight at a time.
 * Neighbouring rooms in M9 might, and the second entry costs nothing.
 */
const ROOM_NAME_MEMO_ENTRIES = 2;

/** A room and the key part rendered from it. */
interface RememberedRoom {
  readonly room: bigint;
  readonly name: string;
}

/**
 * A private memo of the room part of a key, most recent first.
 *
 * Rendering a room is the expensive half of a key: at the depth a deep link or
 * a search hit reaches it is a conversion of up to 16 526 bits, 0.78 ms cold in
 * Chromium, while the index within the room is at most four digits. Every key
 * of a shelf, and of the page open beside it, renders the same room, so it is
 * rendered once and remembered.
 *
 * It memoises a pure function of its argument, so it changes no answer the
 * cache gives and no byte it counts: a caller cannot observe it except by
 * timing. That is why it is not part of `ByteBudgetedLru`'s contract and is
 * not charged against either budget, which bound what the cache holds for its
 * callers, not what it holds to compute a key.
 */
class RoomNames {
  private remembered: readonly RememberedRoom[] = [];

  /**
   * The room rendered in base `RADIX`.
   *
   * `toString(RADIX)` rather than `roomToName`: the room alphabet is exactly
   * `0-9a-z` (`core/alphabet.ts`), so the digits are the same for every valid
   * room, but `roomToName` throws for a negative room. That would turn
   * `client.page` for such an address from a request that rejects with
   * `GenerationFailedError` into a synchronous throw on the main thread. It
   * also converts once where `roomToName` converts twice.
   */
  nameOf(room: bigint): string {
    const mostRecent = this.remembered[0];
    // The common case, every key of a shelf after its first, allocates nothing.
    if (mostRecent?.room === room) {
      return mostRecent.name;
    }
    const entry = this.remembered.find((candidate) => candidate.room === room) ?? {
      room,
      name: room.toString(RADIX),
    };
    this.remembered = [
      entry,
      ...this.remembered.filter((candidate) => candidate !== entry),
    ].slice(0, ROOM_NAME_MEMO_ENTRIES);
    return entry.name;
  }
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
 * **A key is `<room>:<index within the room>`, both parts in base `RADIX`.** An
 * `Address` is a plain object, so two addresses naming the same page are
 * different objects and identity is not a key; and the structural key a `Map`
 * could be given would be a string in the end anyway. The index within the
 * room is `toLinear(address) - room * PAGES_PER_ROOM`, so the pair is the
 * linear index split at the room boundary, and `toLinear` is the one canonical
 * ordering (SPEC §3). Both parts are canonical renderings and the separator is
 * in neither, so distinct addresses cannot share a key and the same address
 * cannot produce two.
 *
 * The key is split rather than the whole linear index rendered because the room
 * dominates a 16 544-bit index while being the same for all 32 volumes of a
 * shelf: rendered whole, a shelf at a deep room is 32 conversions of it, 25.3 to
 * 32.3 ms in Chromium as measured for M7. Split, the room is rendered once
 * (`RoomNames`) and each key adds a remainder of at most four digits.
 */
export class GenerationCache {
  private readonly pages = new ByteBudgetedLru(PAGE_BUDGET_BYTES);
  private readonly titles = new ByteBudgetedLru(TITLE_BUDGET_BYTES);
  private readonly roomNames = new RoomNames();

  /** The cached text of one page, or `undefined`. A hit promotes it. */
  getPage(address: Address): string | undefined {
    return this.pages.get(this.keyOf(address));
  }

  /** Cache the text of one page. */
  setPage(address: Address, text: string): void {
    this.pages.set(this.keyOf(address), text);
  }

  /** The cached title of one volume, or `undefined`. A hit promotes it. */
  getTitle(book: BookAddress): string | undefined {
    return this.titles.get(this.titleKey(book));
  }

  /** Cache the title of one volume. */
  setTitle(book: BookAddress, title: string): void {
    this.titles.set(this.titleKey(book), title);
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

  /**
   * The key a page is stored under, and page 0's the title of its volume.
   *
   * Public only so that its format can be asserted: `cache.test.ts` decodes it
   * back into a room and an index, which is what proves it injective. Callers
   * read through `getPage` and `getTitle` and never need a key.
   *
   * Base `RADIX` rather than base 10 because `toString` is native for both and
   * the base-36 form is shorter: a room name of 3197 characters where the
   * decimal form is 4975.
   */
  keyOf(address: Address): string {
    const indexWithinRoom = toLinear(address) - address.room * BigInt(PAGES_PER_ROOM);
    const roomPart = this.roomNames.nameOf(address.room);
    return roomPart + KEY_SEPARATOR + indexWithinRoom.toString(RADIX);
  }

  /**
   * The key of a title: the key of page 0 of its volume.
   *
   * A title *is* the opening of page 0 (SPEC §5), so that address names it
   * exactly. It is also the key page 0 itself would get, which is why titles
   * are a separate store rather than a prefixed key in a shared one.
   */
  private titleKey(book: BookAddress): string {
    return this.keyOf({ ...book, page: FIRST_PAGE_OF_VOLUME });
  }
}
