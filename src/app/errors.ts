/**
 * Dedicated error types for the ways a shareable URL can be wrong (SPEC §7).
 *
 * A page in this library is computed from its address, not stored, so a
 * fragment parsed slightly wrong does not fail — it silently yields a
 * different book that looks exactly as plausible as the right one. Every
 * refusal below therefore carries the offending value and what was expected of
 * it, in the pattern of `src/core/errors.ts`: a bare `Error('invalid URL')` is
 * useless during an incident and useless in a bug report.
 *
 * These are flat classes rather than a family under one base, deliberately.
 * Parsing a fragment also surfaces `InvalidAddressError`,
 * `AddressBeyondLibraryError` and `UnknownSymbolError` from `core` — the ranges
 * and the room-name alphabet are owned there and are not restated here — so a
 * base class would catch only part of what the codec can throw while looking
 * as though it caught all of it. The full list lives in the doc comment of
 * `./url.ts`.
 */

/**
 * The fragment does not begin with the scheme's prefix, so it is not an
 * address fragment at all. Carries the prefix that was expected, because the
 * usual cause is a caller passing a path or a whole URL where a fragment
 * belongs.
 */
export class UrlPrefixError extends Error {
  readonly fragment: string;
  readonly expectedPrefix: string;

  constructor(fragment: string, expectedPrefix: string) {
    super(
      `URL fragment does not start with '${expectedPrefix}': received '${fragment}'`
    );
    this.name = 'UrlPrefixError';
    this.fragment = fragment;
    this.expectedPrefix = expectedPrefix;
  }
}

/**
 * The fragment carries a format version this build does not implement
 * (SPEC §4.5, ADR-0003). This is the one refusal the scheme exists for: the
 * version is what a format change announces itself with, and a link made under
 * another format must be refused with an explanation rather than opened at
 * whatever book this format happens to compute for those coordinates.
 */
export class UnknownFormatVersionError extends Error {
  readonly received: string;
  readonly expected: number;

  constructor(received: string, expected: number) {
    super(
      `Unknown URL format version '${received}': this build serves version ${String(expected)} only, and a link made under another format would open at different text`
    );
    this.name = 'UnknownFormatVersionError';
    this.received = received;
    this.expected = expected;
  }
}

/**
 * The path has the wrong number of segments: a segment is missing, or there is
 * one too many. The two are the same failure seen from either side, and the
 * counts say which — `received` below `expected` is a truncated link, above it
 * a fragment with something appended.
 */
export class UrlSegmentCountError extends Error {
  readonly path: string;
  readonly received: number;
  readonly expected: number;

  constructor(path: string, received: number, expected: number) {
    super(
      `URL path has ${String(received)} segments, expected ${String(expected)}: '${path}'`
    );
    this.name = 'UrlSegmentCountError';
    this.path = path;
    this.received = received;
    this.expected = expected;
  }
}

/**
 * A label segment names a component other than the one the scheme fixes at
 * that position — `s` where `w` belongs, for instance. Carries the position so
 * the report names a place in the fragment rather than only a letter, which
 * matters when the fragment is several thousand characters long.
 */
export class UrlSegmentLabelError extends Error {
  readonly position: number;
  readonly received: string;
  readonly expected: string;

  constructor(position: number, received: string, expected: string) {
    super(
      `URL segment ${String(position)} is '${received}', expected the label '${expected}'`
    );
    this.name = 'UrlSegmentLabelError';
    this.position = position;
    this.received = received;
    this.expected = expected;
  }
}

/**
 * A numeric component is not a run of decimal digits: `p/abc`, `w/-1`,
 * `s/1.5`, or an empty segment. Refused rather than coerced, because `Number`
 * would read `''` as 0 and `'1e2'` as 100 and either would open a real page
 * that the link did not name.
 */
export class NonNumericComponentError extends Error {
  readonly component: string;
  readonly value: string;

  constructor(component: string, value: string) {
    super(
      `Address component '${component}' is not a decimal number: received '${value}'`
    );
    this.name = 'NonNumericComponentError';
    this.component = component;
    this.value = value;
  }
}

/**
 * The `lang` parameter names a language the interface does not have (SPEC §8).
 * Carries the languages that exist, so a caller can say which ones it could
 * have offered instead of silently falling back to one of them.
 */
export class UnknownLanguageError extends Error {
  readonly received: string;
  readonly supported: readonly string[];

  constructor(received: string, supported: readonly string[]) {
    super(
      `Unknown language '${received}': supported languages are ${supported.join(', ')}`
    );
    this.name = 'UnknownLanguageError';
    this.received = received;
    this.supported = supported;
  }
}

/**
 * The query string carries a parameter the scheme does not define. Refused
 * rather than ignored: an unknown parameter is either a typo for one that
 * exists — `lng` for `lang` — or a link from a scheme this build does not
 * implement, and dropping it silently discards part of what was shared.
 */
export class UnknownUrlParameterError extends Error {
  readonly parameter: string;
  readonly supported: readonly string[];

  constructor(parameter: string, supported: readonly string[]) {
    super(
      `Unknown URL parameter '${parameter}': the scheme defines ${supported.join(', ')}`
    );
    this.name = 'UnknownUrlParameterError';
    this.parameter = parameter;
    this.supported = supported;
  }
}

/**
 * A parameter appears more than once. Refused rather than resolved by taking
 * the first or the last occurrence: `?q=one&q=two` has no meaning the sender
 * can have intended, and picking one of the two is a guess made silently.
 */
export class DuplicateUrlParameterError extends Error {
  readonly parameter: string;

  constructor(parameter: string) {
    super(`URL parameter '${parameter}' appears more than once`);
    this.name = 'DuplicateUrlParameterError';
    this.parameter = parameter;
  }
}

/**
 * A parameter value is not valid percent-encoding, so it cannot be decoded —
 * a truncated `%D0` at the end of a copied link, typically. Carries the raw
 * value as it arrived, which is the only form of it that still exists.
 */
export class UndecodableParameterError extends Error {
  readonly parameter: string;
  readonly value: string;

  constructor(parameter: string, value: string) {
    super(
      `URL parameter '${parameter}' is not valid percent-encoding: received '${value}'`
    );
    this.name = 'UndecodableParameterError';
    this.parameter = parameter;
    this.value = value;
  }
}

/**
 * `window.__scriptorium.frames()` was asked for the frame budget, which M10
 * collects and M5's hook does not have.
 *
 * It refuses rather than returning a shape full of zeros: a frame-budget
 * assertion that passes against a hook which never measured anything is worse
 * than no hook at all, because it reports a budget as met. The milestone that
 * owns the measurement is named in the message, so a test that hits this knows
 * what it is waiting for.
 */
export class FrameTimingsUnavailableError extends Error {
  constructor() {
    super(
      'Frame timings are not collected yet: the rolling frame budget arrives with M10 (roadmap M10), and this hook reports nothing rather than reporting zeros'
    );
    this.name = 'FrameTimingsUnavailableError';
  }
}
