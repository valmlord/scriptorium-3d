/**
 * The 36-symbol alphabet. The index of a symbol IS its digit value, so the
 * order is part of the library format (ADR-0001): reordering this table
 * replaces every book in the library and invalidates every shared link.
 *
 * The alphabet is exported as a structure that can describe any 36-symbol
 * alphabet, because room names use `0-9a-z` — deliberately different from
 * page text so the two can never be confused for one another.
 */

/**
 * A single symbol and its position in the input it came from.
 *
 * `index` is a **code-point** offset — the position in `[...input]`, not a
 * UTF-16 offset into `input`. The two differ only when the input contains an
 * astral character, which can only ever be an unknown symbol here, since every
 * alphabet symbol is in the BMP. A caller that needs a UTF-16 offset, such as
 * one driving `setSelectionRange` to highlight the offending character, must
 * convert; it must not pass this value to `String.prototype.slice`.
 */
export interface UnknownSymbol {
  symbol: string;
  index: number;
}

/** The result of normalizing search input: cleaned text plus every unknown. */
export interface NormalizationResult {
  text: string;
  unknown: readonly UnknownSymbol[];
}

/** A fixed-width alphabet: a symbol list plus a prebuilt reverse lookup. */
export interface Alphabet {
  /** The symbols in digit-value order. `symbols[digit]` is the digit's glyph. */
  readonly symbols: readonly string[];
  /** Reverse lookup: glyph → digit value. Built once, never via `indexOf`. */
  readonly digitBySymbol: ReadonlyMap<string, number>;
  readonly radix: number;
}

/**
 * Build an `Alphabet` from an ordered symbol list. The list must be complete
 * (no holes): a hole would silently shift every digit value after it and
 * corrupt the format. Exported so other 36-symbol alphabets can be described.
 */
export function buildAlphabet(symbols: readonly string[]): Alphabet {
  const digitBySymbol = new Map<string, number>();
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    if (symbol === undefined) {
      throw new Error('Alphabet symbol list has a hole');
    }
    digitBySymbol.set(symbol, i);
  }
  return { symbols, digitBySymbol, radix: symbols.length };
}

/**
 * The page-text alphabet: space, all 33 Russian letters (ё and ъ included),
 * comma, full stop. Dropping ё or ъ would make a class of Russian words
 * unwritable — completeness is the single property this project exists to
 * have (ADR-0001).
 */
export const PAGE_ALPHABET: Alphabet = buildAlphabet([
  ' ',
  'а',
  'б',
  'в',
  'г',
  'д',
  'е',
  'ё',
  'ж',
  'з',
  'и',
  'й',
  'к',
  'л',
  'м',
  'н',
  'о',
  'п',
  'р',
  'с',
  'т',
  'у',
  'ф',
  'х',
  'ц',
  'ч',
  'ш',
  'щ',
  'ъ',
  'ы',
  'ь',
  'э',
  'ю',
  'я',
  ',',
  '.',
]);

/**
 * The room-name alphabet: `0-9a-z`. Room names are the room number in base 36
 * over this alphabet, deliberately different from page text so a room name can
 * never be mistaken for a page.
 */
export const ROOM_ALPHABET: Alphabet = buildAlphabet([
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'u',
  'v',
  'w',
  'x',
  'y',
  'z',
]);

/** The digit value of a symbol, or `undefined` if it is not in the alphabet. */
export function symbolToDigit(alphabet: Alphabet, symbol: string): number | undefined {
  return alphabet.digitBySymbol.get(symbol);
}

/** The symbol for a digit value. Throws if the digit is out of range. */
export function digitToSymbol(alphabet: Alphabet, digit: number): string {
  const symbol = alphabet.symbols[digit];
  if (symbol === undefined) {
    throw new RangeError(
      `Digit ${String(digit)} out of range for radix ${String(alphabet.radix)}`
    );
  }
  return symbol;
}

/** Whether every character of `text` is a member of `alphabet`. */
export function isInAlphabet(alphabet: Alphabet, text: string): boolean {
  for (const char of text) {
    if (!alphabet.digitBySymbol.has(char)) {
      return false;
    }
  }
  return true;
}

/**
 * Normalize search input. NFC, then lower case, then collapse any whitespace
 * run to a single space. ё is preserved as itself — it is symbol 7, not a
 * variant of е. Unknown characters are reported, never substituted or
 * stripped: silently replacing them sends the user to a different book than
 * the one they asked for.
 *
 * Uses `toLowerCase`, never `toLocaleLowerCase`: Turkish `I` alone would fork
 * the library for some users.
 *
 * Reported positions are code-point offsets into the **original** input, not
 * into the cleaned text and not UTF-16 offsets (see `UnknownSymbol`). NFC and
 * case folding can change a character's length — `İ` lower-cases to two code
 * points — so the offset is tracked through every transformation. When a
 * transformation makes an exact original position impossible for a character,
 * the offset of the source character it came from is reported instead.
 */
export function normalize(input: string): NormalizationResult {
  const unknown: UnknownSymbol[] = [];
  let text = '';
  let pendingSpace = false;

  // Walk the input in clusters: one base code point followed by any run of
  // combining marks (\p{M}). NFC composition only ever combines a base with
  // the marks that follow it, so applying NFC to the whole cluster — rather
  // than to each source code point on its own — is what lets a decomposed ё
  // (е + U+0308) compose back into ё. Every code point in the output is
  // attributed to the cluster's starting code-point index, exactly as
  // expanding case folding is attributed today, so reported positions keep
  // indexing the string the user typed: `İ` lower-cases to two code points,
  // and both are reported at the index of the `İ` they came from, so a later
  // unknown is not shifted by the expansion.
  const clusters: string[] = [];
  let current = '';
  for (const codePoint of Array.from(input)) {
    if (/\p{M}/u.test(codePoint)) {
      current += codePoint;
    } else {
      if (current !== '') {
        clusters.push(current);
      }
      current = codePoint;
    }
  }
  if (current !== '') {
    clusters.push(current);
  }

  let index = 0;
  for (const cluster of clusters) {
    const folded = cluster.normalize('NFC').toLowerCase();
    for (const char of folded) {
      if (/\s/.test(char)) {
        pendingSpace = true;
      } else {
        if (pendingSpace) {
          text += ' ';
          pendingSpace = false;
        }
        if (PAGE_ALPHABET.digitBySymbol.has(char)) {
          text += char;
        } else {
          unknown.push({ symbol: char, index });
        }
      }
    }
    index += Array.from(cluster).length;
  }
  if (pendingSpace) {
    text += ' ';
  }

  return { text, unknown };
}
