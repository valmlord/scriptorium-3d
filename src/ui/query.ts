import { PAGE_LENGTH } from '@core/address';
import { normalize } from '@core/alphabet';
import type { NormalizationResult } from '@core/alphabet';

/**
 * What the user typed into the search panel, judged: an accepted query to
 * send to the worker, or a refusal saying exactly what is wrong and where.
 *
 * **The order is the design's, and each step is there for the one after it**
 * (SPEC §2, ADR-0035):
 *
 * 1. The raw length, before any work, so that nothing below runs on a paste of
 *    unbounded size.
 * 2. Runs of combining marks, a linear pre-check, because NFC's canonical
 *    reordering inside `normalize` is quadratic in the length of such a run.
 * 3. `normalize`, which keeps runs of spaces as typed and reports every other
 *    whitespace character as unknown.
 * 4. Unknown symbols before emptiness, so a lone tab is named rather than
 *    called empty.
 * 5. The length after normalizing.
 *
 * **Nothing here substitutes or strips.** No trim, no collapse, no line break
 * turned into a space: each is a silent substitution that sends the user to a
 * different page than the one they typed (SPEC §2 rule 3). Normalizing runs on
 * submit only, and there is no `maxlength` on the field for the same reason:
 * it would truncate a paste without a word.
 *
 * **A refusal's message is data, not markup.** It is a list of segments, and
 * `./search.ts` turns each into a text node or a `<bdi>` element. A refused
 * character is something the user typed, so it is never interpolated into
 * HTML, and its glyph is shown only where it can be shown safely.
 *
 * Pure, and unit-tested whole for that reason (`./__tests__/query.test.ts`).
 */

/**
 * The longest raw input judged at all, in UTF-16 code units.
 *
 * The longest input that can still be accepted is a page of 3200 symbols each
 * typed in decomposed form, and only two of them decompose, U+0439 and U+0451,
 * to two units each: so `2 * PAGE_LENGTH`. A page copied out of the reader is 3279 units, under
 * it, so its 79 line breaks are named rather than the whole paste being
 * refused as too long.
 */
export const MAX_QUERY_INPUT_UNITS = 2 * PAGE_LENGTH;

/**
 * The most combining marks any alphabet symbol is typed with: U+0451 is U+0435
 * and U+0308, U+0439 is U+0438 and U+0306, and nothing needs two. A longer run cannot
 * become an accepted symbol, so it is refused before `normalize` pays for it.
 */
export const MAX_COMBINING_MARKS = 1;

/**
 * How many refused characters a message names before it counts the rest.
 *
 * The message is read aloud whole from a `role="alert"` region, and naming
 * 6400 refused characters one by one would be minutes of speech; the cap also
 * bounds the work, which is why it is applied before any entry is built.
 */
export const MAX_NAMED_SYMBOLS = 8;

/**
 * One piece of a refusal's message. A `glyph` is a character the user typed,
 * shown as itself inside its own `<bdi>`, so that a right-to-left letter
 * cannot reorder the sentence around it and a combining mark attaches only to
 * its own base. Everything else is `text`.
 */
export type MessageSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'glyph'; readonly text: string };

/** A refused character as the message names it. */
export interface NamedSymbol {
  /** One-based, as the message says it. */
  readonly position: number;
  /** The whole cluster typed there: a base and the mark on it, or one of them. */
  readonly cluster: string;
  /** Every code point of the cluster as `U+XXXX`, four to six hex digits. */
  readonly codePoints: readonly string[];
  /** Whether the cluster's glyph is shown beside its code points. */
  readonly isPrintable: boolean;
}

/** Why a query was not sent, with what the message needs to say so. */
export type QueryRefusal =
  | {
      readonly reason: 'input-too-long';
      readonly units: number;
      readonly message: readonly MessageSegment[];
    }
  | {
      readonly reason: 'mark-run';
      readonly base: NamedSymbol;
      readonly marks: number;
      readonly message: readonly MessageSegment[];
    }
  | {
      readonly reason: 'leading-marks';
      readonly message: readonly MessageSegment[];
    }
  | {
      readonly reason: 'unknown-symbols';
      readonly named: readonly NamedSymbol[];
      readonly unnamed: number;
      readonly message: readonly MessageSegment[];
    }
  | {
      readonly reason: 'empty';
      readonly message: readonly MessageSegment[];
    }
  | {
      readonly reason: 'too-long';
      readonly length: number;
      readonly message: readonly MessageSegment[];
    };

/** The verdict on one submitted input. */
export type QueryVerdict =
  | { readonly isAccepted: true; readonly query: string }
  | { readonly isAccepted: false; readonly refusal: QueryRefusal };

/** What `judgeQuery` normalizes with: `core`'s, or a test's spy on it. */
export type Normalizer = (input: string) => NormalizationResult;

/**
 * A run of more than `MAX_COMBINING_MARKS` marks. Written as a literal because
 * a pattern built from the constant would hide the one number a reader of the
 * regex needs; the test asserts the two agree.
 */
const MARK_RUN = /\p{M}{2,}/u;

/** One combining mark, the rule `normalize` splits clusters by. */
const COMBINING_MARK = /\p{M}/u;

/**
 * A first code point whose glyph is not shown: controls, format characters
 * (bidi overrides and isolates, zero-width characters), surrogates and private
 * use (`\p{C}`); separators, including U+2028 and U+2029 (`\p{Z}`); a mark,
 * which would attach to the text before it (`\p{M}`); and default-ignorable
 * code points, which catch the Hangul fillers, letters that render blank.
 */
const UNPRINTABLE = /^[\p{C}\p{Z}\p{M}\p{Default_Ignorable_Code_Point}]/u;

/** The sentence every message with a computed position ends with. */
const POSITIONS_NOTE = ' Positions count from 1.';

/** Judge `input`, in the order the header gives. */
export function judgeQuery(
  input: string,
  normalizeInput: Normalizer = normalize
): QueryVerdict {
  if (input.length > MAX_QUERY_INPUT_UNITS) {
    return refused(inputTooLong(input.length));
  }
  const markRun = findMarkRun(input);
  if (markRun !== null) {
    return refused(markRun);
  }
  const { text, unknown } = normalizeInput(input);
  if (unknown.length > 0) {
    return refused(
      unknownSymbols(
        input,
        unknown.map((symbol) => symbol.index)
      )
    );
  }
  if (text === '') {
    return refused({ reason: 'empty', message: [plain('The query is empty.')] });
  }
  const length = Array.from(text).length;
  if (length > PAGE_LENGTH) {
    return refused({
      reason: 'too-long',
      length,
      message: [
        plain(
          `The query is ${String(length)} symbols long after normalizing, and a page holds ${String(PAGE_LENGTH)}.`
        ),
      ],
    });
  }
  return { isAccepted: true, query: text };
}

function refused(refusal: QueryRefusal): QueryVerdict {
  return { isAccepted: false, refusal };
}

function inputTooLong(units: number): QueryRefusal {
  return {
    reason: 'input-too-long',
    units,
    message: [
      plain(
        `The input is ${String(units)} UTF-16 code units long, and the search reads at most ${String(MAX_QUERY_INPUT_UNITS)}.`
      ),
    ],
  };
}

/**
 * The first run of combining marks too long for any symbol, or `null`.
 *
 * `exec` reports where the run starts in **UTF-16 units**, and every position
 * this module shows is in code points, so it is converted by counting the code
 * points before it. In `'\u{1F600}\u{1F600}a\u0301\u0301'` the run starts at
 * unit 5 and code point 3, both counted from 0. The base is the code point
 * before the run; it is never a mark, since the leftmost match would then have
 * started there.
 *
 * The message names the base, its position and how many marks sit on it,
 * never the run itself: a base followed by 6399 marks is a cluster of 6400
 * code points, which named as `U+XXXX` would be some 44 800 characters of
 * alert read aloud.
 */
function findMarkRun(input: string): QueryRefusal | null {
  const match = MARK_RUN.exec(input);
  if (match === null) {
    return null;
  }
  const before = Array.from(input.slice(0, match.index));
  const baseCodePoint = before.at(-1);
  if (baseCodePoint === undefined) {
    return {
      reason: 'leading-marks',
      message: [plain('Combining marks at position 1 with no character before them.')],
    };
  }
  // Counted in code points: an astral mark is two UTF-16 units.
  const marks = Array.from(match[0]).length;
  const base = nameSymbol(baseCodePoint, before.length - 1);
  return {
    reason: 'mark-run',
    base,
    marks,
    message: [
      plain(`${String(marks)} combining marks in a row on `),
      ...symbolSegments(base),
      plain(
        `, and a symbol of the alphabet carries at most ${String(MAX_COMBINING_MARKS)}.${POSITIONS_NOTE}`
      ),
    ],
  };
}

/**
 * The refusal naming the unknown symbols `normalize` reported, by what was
 * typed at each reported index.
 *
 * `normalize` attributes every output code point to the start of the cluster
 * it came from, so a refused stress mark U+0301 typed on a U+0438 is reported
 * at the index of the U+0438. Naming the code point at that index would put
 * that alphabet letter in the alert and never the U+0301 that was refused, so
 * the whole cluster starting there is named instead: U+0438 U+0301.
 *
 * **One pass, cap first.** The distinct reported indices are collected in
 * order and the first `MAX_NAMED_SYMBOLS` of them kept; the input is then
 * split into clusters once, and only the clusters starting at a kept index
 * are built into entries. The rest are counted. An `İ` lower-cases to two
 * unknown code points at one index, and is named once. `normalize` reports in
 * input order, so the clusters come out in the order it reported them.
 */
function unknownSymbols(input: string, indices: readonly number[]): QueryRefusal {
  const distinct = [...new Set(indices)];
  const kept = new Set(distinct.slice(0, MAX_NAMED_SYMBOLS));
  const named: NamedSymbol[] = [];
  for (const [start, cluster] of clustersByStart(input)) {
    if (kept.has(start)) {
      named.push(nameSymbol(cluster, start));
    }
  }
  const unnamed = distinct.length - named.length;

  const message: MessageSegment[] = [plain('Not in the alphabet: ')];
  named.forEach((symbol, order) => {
    if (order > 0) {
      message.push(plain(', '));
    }
    message.push(...symbolSegments(symbol));
  });
  if (unnamed > 0) {
    message.push(plain(`, and ${String(unnamed)} more`));
  }
  message.push(plain(`.${POSITIONS_NOTE}`));
  return { reason: 'unknown-symbols', named, unnamed, message };
}

/**
 * The input's clusters keyed by the code-point index each starts at, split by
 * the rule `normalize` uses: a combining mark joins the cluster before it, and
 * anything else starts a new one. A mark at the very start has nothing to
 * join, so it is a cluster of its own with no base.
 */
function clustersByStart(input: string): ReadonlyMap<number, string> {
  const clusters = new Map<number, string>();
  let start = 0;
  let current = '';
  Array.from(input).forEach((codePoint, index) => {
    if (COMBINING_MARK.test(codePoint)) {
      current += codePoint;
      return;
    }
    if (current !== '') {
      clusters.set(start, current);
    }
    start = index;
    current = codePoint;
  });
  if (current !== '') {
    clusters.set(start, current);
  }
  return clusters;
}

function nameSymbol(cluster: string, index: number): NamedSymbol {
  return {
    position: index + 1,
    cluster,
    codePoints: Array.from(cluster, codePointLabel),
    isPrintable: !UNPRINTABLE.test(cluster),
  };
}

/**
 * `U+` and the code point in four to six upper-case hex digits. A lone
 * surrogate is one element of `Array.from` and is named as itself; an astral
 * character is one element too, so it is never split into its surrogates.
 */
function codePointLabel(character: string): string {
  // `as number`: `character` is one element of `Array.from` over a string, so
  // it is never empty, and `codePointAt(0)` is undefined only for an empty one.
  const value = character.codePointAt(0) as number;
  return `U+${value.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** A symbol as the message names it: the glyph if it is printable, then the code points. */
function symbolSegments(symbol: NamedSymbol): readonly MessageSegment[] {
  const codePoints = symbol.codePoints.join(' ');
  const position = ` at position ${String(symbol.position)}`;
  if (!symbol.isPrintable) {
    return [plain(`${codePoints}${position}`)];
  }
  return [glyph(symbol.cluster), plain(` (${codePoints})${position}`)];
}

function plain(text: string): MessageSegment {
  return { kind: 'text', text };
}

function glyph(text: string): MessageSegment {
  return { kind: 'glyph', text };
}
