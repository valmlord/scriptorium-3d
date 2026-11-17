import {
  assertValidAddress,
  isCanonicalRoomName,
  roomFromName,
  roomToName,
} from '@core/address';
import type { Address } from '@core/address';
import { FORMAT_VERSION } from '@core/format';
import {
  DuplicateUrlParameterError,
  NonNumericComponentError,
  UndecodableParameterError,
  UnknownFormatVersionError,
  UnknownLanguageError,
  UnknownUrlParameterError,
  UrlPrefixError,
  UrlSegmentCountError,
  UrlSegmentLabelError,
} from './errors';

/**
 * The URL scheme of SPEC §7, as a pure codec:
 *
 * ```
 * #/v1/r/<room-base36>/w/<0-3>/s/<0-4>/b/<0-31>/p/<0-409>[?q=<query>&lang=ru|en]
 * ```
 *
 * A string in, an `Address` out, and back again. Nothing here reads or writes
 * `location`, `history` or any other browser global: `docs/architecture.md` §4
 * makes the navigation FSM the single source of truth and the URL a projection
 * of it, so the fragment is written from the FSM and parsed into it and no
 * other code touches `location`. The FSM does not exist yet; wiring these two
 * functions to it is M8's remaining work.
 *
 * **Why every malformed fragment is refused by name.** This library has no
 * database. A page is computed from its address, so a fragment parsed slightly
 * wrong does not fail — it yields a different book, equally well-formed and
 * equally plausible, and nothing downstream can tell. The `v1` segment is the
 * extreme case and the reason the scheme carries a version at all (SPEC §4.5,
 * ADR-0003): the same coordinates under another format name different text, so
 * an unknown version is refused with an explanation and never opened.
 *
 * **What a caller gets for each way a fragment can be wrong.**
 *
 * | Input                                    | Result                                              |
 * | ---------------------------------------- | --------------------------------------------------- |
 * | no `#/` prefix                           | `UrlPrefixError`                                    |
 * | `#/v2/...`, `#/x/...`, `#/v/...`         | `UnknownFormatVersionError`                         |
 * | a segment missing, or one too many       | `UrlSegmentCountError`                              |
 * | a label in the wrong place               | `UrlSegmentLabelError`                              |
 * | `p/abc`, `w/-1`, `s/1.5`, an empty value | `NonNumericComponentError`                          |
 * | a component out of range                 | `InvalidAddressError` from `core`, naming the bound |
 * | the unfilled tail of the last room       | `AddressBeyondLibraryError` from `core`             |
 * | a room name outside `0-9a-z`             | `UnknownSymbolError` from `core`, naming each glyph |
 * | `lang=de`                                | `UnknownLanguageError`                              |
 * | `?zoom=3`                                | `UnknownUrlParameterError`                          |
 * | `?q=one&q=two`                           | `DuplicateUrlParameterError`                        |
 * | `?q=%D0`                                 | `UndecodableParameterError`                         |
 * | a non-canonical room name, `0001`        | resolves; `isCanonical` is false                    |
 *
 * The component ranges are not restated here. `assertValidAddress` owns them,
 * derives them from the structural constants and already reports which
 * component crossed which bound, so the scheme's `0-3`, `0-4`, `0-31` and
 * `0-409` appear in this file only as the documentation above.
 *
 * The last row is not a refusal, and that is deliberate. SPEC §3 and ADR-0009
 * keep room-name parsing lenient so a hand-edited link lands somewhere
 * sensible, while leaving exactly one canonical name per room so that a link
 * still *is* the page. A parse therefore resolves `0001` to room 1 and reports
 * both that the fragment was not canonical and what the canonical form is, for
 * the router to rewrite on load.
 */

/** The interface languages (SPEC §8). The library text itself is always Cyrillic. */
export type Language = 'ru' | 'en';

/** The languages the `lang` parameter may name, in the order SPEC §7 lists them. */
export const SUPPORTED_LANGUAGES: readonly Language[] = ['ru', 'en'];

/** The optional parameters a fragment may carry alongside the address. */
export interface FragmentParameters {
  /** The search query that led here, carried verbatim; `core` owns its validation. */
  query?: string;
  /** The interface language the link was shared in. */
  language?: Language;
}

/** Everything a fragment yields: the address it names, its parameters and its canonicality. */
export interface ParsedFragment {
  /** The address the fragment names. Already validated by `assertValidAddress`. */
  readonly address: Address;
  /** The decoded `q` parameter, or `null` when the fragment carried none. */
  readonly query: string | null;
  /** The `lang` parameter, or `null` when the fragment carried none. */
  readonly language: Language | null;
  /**
   * The canonical fragment for this address and these parameters: what
   * `addressToFragment` would produce. Equal to the input when `isCanonical`.
   * The router rewrites to this on load (ADR-0009), which is what keeps one
   * page from being reachable through unboundedly many URLs.
   */
  readonly canonicalFragment: string;
  /**
   * Whether the room name was canonical — no leading zeros — as decided by
   * `core`'s `isCanonicalRoomName`. Reported separately from `isCanonical`
   * because the room name is the segment a human hand-edits and the one that
   * runs to 3197 characters, so a log that says which segment was rewritten is
   * worth more than one that says only that something was.
   */
  readonly hasCanonicalRoomName: boolean;
  /** Whether the whole fragment was already canonical, parameters and all. */
  readonly isCanonical: boolean;
}

/** The scheme's prefix: a hash, then the path (SPEC §7). */
const FRAGMENT_PREFIX = '#/';
/** The letter that marks the version segment, as in `v1`. */
const VERSION_PREFIX = 'v';
/** The separator between path segments. */
const SEGMENT_SEPARATOR = '/';
/** The separator between the path and the parameters. */
const PARAMETER_SEPARATOR = '?';
/** The separator between two parameters. */
const PARAMETER_DELIMITER = '&';
/** The separator between a parameter's name and its value. */
const PARAMETER_ASSIGNMENT = '=';

/** The search query that led to this page. */
const QUERY_PARAMETER = 'q';
/** The interface language the link was shared in. */
const LANGUAGE_PARAMETER = 'lang';
/** Every parameter the scheme defines; anything else is refused. */
const SUPPORTED_PARAMETERS: readonly string[] = [QUERY_PARAMETER, LANGUAGE_PARAMETER];

/**
 * The five path segments, each pairing its URL label with the address
 * component it carries. The letters are frozen by SPEC §7, which is why `b`
 * carries `volume`: the SPEC's URL writes `b` for the book on the shelf while
 * the SPEC's vocabulary calls it a volume (code-style §2), and the component
 * names here are the ones `assertValidAddress` reports, so a refusal from this
 * file and a refusal from `core` name the same thing.
 */
const PATH_COMPONENTS = [
  { label: 'r', component: 'room' },
  { label: 'w', component: 'wall' },
  { label: 's', component: 'shelf' },
  { label: 'b', component: 'volume' },
  { label: 'p', component: 'page' },
] as const;

const [ROOM, WALL, SHELF, VOLUME, PAGE] = PATH_COMPONENTS;

/** One entry of the path table above. */
type PathComponent = (typeof PATH_COMPONENTS)[number];

/**
 * Where a component's label sits in the path: the version occupies segment 0,
 * then every component takes two. Derived from the table rather than written
 * out, so a position in a refusal cannot drift from the position actually read.
 */
function labelPositionOf(component: PathComponent): number {
  return 1 + PATH_COMPONENTS.indexOf(component) * 2;
}

/** The version segment this build serves, e.g. `v1` (SPEC §4.5). */
const EXPECTED_VERSION_SEGMENT = `${VERSION_PREFIX}${String(FORMAT_VERSION)}`;

/**
 * How many segments a path has: the version, then a label and a value for each
 * component.
 */
const PATH_SEGMENT_COUNT = 1 + PATH_COMPONENTS.length * 2;

/**
 * The path once its width is known. The tuple restates the width that
 * `PATH_SEGMENT_COUNT` computes, and the two are pinned together by the
 * round-trip property: were they to disagree, a valid fragment would read a
 * component from the wrong place and the property would fail on its first case.
 */
type PathSegments = readonly [
  version: string,
  roomLabel: string,
  roomName: string,
  wallLabel: string,
  wall: string,
  shelfLabel: string,
  shelf: string,
  volumeLabel: string,
  volume: string,
  pageLabel: string,
  page: string,
];

/** A run of decimal digits, and nothing else. `\d` without `u` is ASCII `0-9`. */
const DECIMAL_DIGITS = /^\d+$/;

/**
 * Serialise an address, and optionally the query and language it was reached
 * with, to the fragment of SPEC §7.
 *
 * The address is validated first: a link to a page that does not exist is not
 * worth producing, and the unfilled tail of the last room is a real edge of the
 * domain (SPEC §3). The room name is never truncated or abbreviated — it runs
 * to 3197 characters for the last rooms, which is inside every browser's
 * fragment limit, and shortening it would make the name ambiguous.
 */
export function addressToFragment(
  address: Address,
  parameters: FragmentParameters = {}
): string {
  assertValidAddress(address);
  return buildFragment(address, parameters);
}

/**
 * The fragment for an address already known to be valid.
 *
 * Split out so that validation happens exactly once per public call. The
 * parser needs the canonical fragment of an address it has just validated, and
 * routing that through `addressToFragment` would validate it a second time —
 * which, besides the wasted work on a 3197-character room name, would leave
 * the parser's own `assertValidAddress` with nothing to do: remove it and the
 * refusal would still arrive, from here, by accident. A guard whose removal
 * changes no behaviour is not a guard.
 */
function buildFragment(address: Address, parameters: FragmentParameters): string {
  const path = [
    EXPECTED_VERSION_SEGMENT,
    ROOM.label,
    roomToName(address.room),
    WALL.label,
    String(address.wall),
    SHELF.label,
    String(address.shelf),
    VOLUME.label,
    String(address.volume),
    PAGE.label,
    String(address.page),
  ].join(SEGMENT_SEPARATOR);

  return `${FRAGMENT_PREFIX}${path}${parametersToQueryString(parameters)}`;
}

/**
 * Parse a fragment of SPEC §7 back into an address and its parameters.
 *
 * The version is checked before anything else about the shape, because a
 * future format may lay its path out differently: reporting a wrong segment
 * count for a `v2` link would bury the one fact that matters about it.
 */
export function fragmentToAddress(fragment: string): ParsedFragment {
  if (!fragment.startsWith(FRAGMENT_PREFIX)) {
    throw new UrlPrefixError(fragment, FRAGMENT_PREFIX);
  }

  const body = fragment.slice(FRAGMENT_PREFIX.length);
  const parameterStart = body.indexOf(PARAMETER_SEPARATOR);
  const hasParameters = parameterStart !== -1;
  const path = hasParameters ? body.slice(0, parameterStart) : body;
  const queryString = hasParameters ? body.slice(parameterStart + 1) : '';

  assertKnownVersion(path);

  const segments = path.split(SEGMENT_SEPARATOR);
  if (!hasPathShape(segments)) {
    throw new UrlSegmentCountError(path, segments.length, PATH_SEGMENT_COUNT);
  }
  const [
    ,
    roomLabel,
    roomName,
    wallLabel,
    wallText,
    shelfLabel,
    shelfText,
    volumeLabel,
    volumeText,
    pageLabel,
    pageText,
  ] = segments;

  const address: Address = {
    room: readRoom(roomLabel, roomName),
    wall: readComponent(WALL, wallLabel, wallText),
    shelf: readComponent(SHELF, shelfLabel, shelfText),
    volume: readComponent(VOLUME, volumeLabel, volumeText),
    page: readComponent(PAGE, pageLabel, pageText),
  };
  assertValidAddress(address);

  const { query, language } = parseQueryString(queryString);
  const canonicalFragment = buildFragment(address, toParameters(query, language));

  return {
    address,
    query,
    language,
    canonicalFragment,
    hasCanonicalRoomName: isCanonicalRoomName(roomName),
    isCanonical: fragment === canonicalFragment,
  };
}

/**
 * Refuse a path whose version segment is not this build's.
 *
 * Matched on the segment rather than by splitting the whole path, so that a
 * `v2` fragment of any shape at all is reported as the version problem it is.
 */
function assertKnownVersion(path: string): void {
  const separator = path.indexOf(SEGMENT_SEPARATOR);
  const versionSegment = separator === -1 ? path : path.slice(0, separator);
  if (versionSegment !== EXPECTED_VERSION_SEGMENT) {
    throw new UnknownFormatVersionError(versionSegment, FORMAT_VERSION);
  }
}

/**
 * Narrow the split path to its fixed width. A predicate rather than an
 * assertion: the length it tests is exactly the length the tuple claims, which
 * is what lets every read below be a `string` under
 * `noUncheckedIndexedAccess`.
 */
function hasPathShape(segments: readonly string[]): segments is PathSegments {
  return segments.length === PATH_SEGMENT_COUNT;
}

/**
 * The room from its label and name. Parsing is lenient about leading zeros
 * (ADR-0009) and strict about everything else: a name carrying a glyph outside
 * `0-9a-z` raises `core`'s `UnknownSymbolError`, which names every offending
 * character and its offset — the detail that matters when the name is 3197
 * characters long.
 */
function readRoom(receivedLabel: string, name: string): bigint {
  assertLabel(ROOM, receivedLabel);
  return roomFromName(name);
}

/**
 * One numeric component, by label position. `Number` is reached for only after
 * the text is known to be decimal digits: it would otherwise read `''` as 0 and
 * `'1e2'` as 100, and both of those open a real page the link did not name.
 */
function readComponent(
  component: PathComponent,
  receivedLabel: string,
  text: string
): number {
  assertLabel(component, receivedLabel);
  if (!DECIMAL_DIGITS.test(text)) {
    throw new NonNumericComponentError(component.component, text);
  }
  return Number(text);
}

/** Refuse a label segment that names a component other than the one fixed here. */
function assertLabel(component: PathComponent, received: string): void {
  if (received !== component.label) {
    throw new UrlSegmentLabelError(
      labelPositionOf(component),
      received,
      component.label
    );
  }
}

/**
 * The optional parameters, in the order SPEC §7 writes them. A fixed order is
 * what makes a canonical fragment a single string rather than a set of
 * equivalent ones.
 */
function parametersToQueryString(parameters: FragmentParameters): string {
  const parts: string[] = [];
  if (parameters.query !== undefined) {
    parts.push(
      `${QUERY_PARAMETER}${PARAMETER_ASSIGNMENT}${encodeURIComponent(parameters.query)}`
    );
  }
  if (parameters.language !== undefined) {
    // The language is remembered between sessions (SPEC §8), so by the time it
    // reaches here it has been through storage and is no longer trustworthy
    // just because the type says `Language`.
    assertKnownLanguage(parameters.language);
    parts.push(`${LANGUAGE_PARAMETER}${PARAMETER_ASSIGNMENT}${parameters.language}`);
  }
  if (parts.length === 0) {
    return '';
  }
  return `${PARAMETER_SEPARATOR}${parts.join(PARAMETER_DELIMITER)}`;
}

/**
 * The `q` and `lang` parameters, decoded. An unknown name, a repeated name and
 * an undecodable value are each refused: silently dropping any of them
 * discards part of what the sender shared.
 *
 * A `+` is a literal plus, not a space. Form encoding reads it as a space, but
 * this is a fragment rather than a submitted form, `encodeURIComponent` writes
 * a space as `%20`, and a query containing a real `+` is what a reader of this
 * library would far more likely have typed.
 */
function parseQueryString(queryString: string): {
  query: string | null;
  language: Language | null;
} {
  let query: string | null = null;
  let language: Language | null = null;
  if (queryString.length === 0) {
    return { query, language };
  }

  for (const part of queryString.split(PARAMETER_DELIMITER)) {
    const assignment = part.indexOf(PARAMETER_ASSIGNMENT);
    const hasValue = assignment !== -1;
    const name = hasValue ? part.slice(0, assignment) : part;
    const rawValue = hasValue ? part.slice(assignment + 1) : '';

    if (name === QUERY_PARAMETER) {
      if (query !== null) {
        throw new DuplicateUrlParameterError(name);
      }
      query = decodeParameter(name, rawValue);
      continue;
    }
    if (name === LANGUAGE_PARAMETER) {
      if (language !== null) {
        throw new DuplicateUrlParameterError(name);
      }
      const decoded = decodeParameter(name, rawValue);
      assertKnownLanguage(decoded);
      language = decoded;
      continue;
    }
    throw new UnknownUrlParameterError(name, SUPPORTED_PARAMETERS);
  }

  return { query, language };
}

/** Percent-decode a parameter value, naming the parameter if it cannot be decoded. */
function decodeParameter(parameter: string, rawValue: string): string {
  try {
    return decodeURIComponent(rawValue);
  } catch {
    // decodeURIComponent throws a bare URIError on a truncated escape such as
    // a trailing `%D0`. Rethrown as a named error so the caller learns which
    // parameter was damaged instead of a URIError from somewhere unknown.
    throw new UndecodableParameterError(parameter, rawValue);
  }
}

/** Refuse a language the interface does not have, and narrow it when it does. */
function assertKnownLanguage(value: string): asserts value is Language {
  if (!SUPPORTED_LANGUAGES.some((supported) => supported === value)) {
    throw new UnknownLanguageError(value, SUPPORTED_LANGUAGES);
  }
}

/**
 * The nullable results of a parse, back as the optional parameters a
 * serialisation takes. Written as two conditional assignments rather than an
 * object literal because `exactOptionalPropertyTypes` distinguishes an absent
 * property from one holding `undefined`, and only the absent one means "this
 * fragment carries no query".
 */
function toParameters(
  query: string | null,
  language: Language | null
): FragmentParameters {
  const parameters: FragmentParameters = {};
  if (query !== null) {
    parameters.query = query;
  }
  if (language !== null) {
    parameters.language = language;
  }
  return parameters;
}
