import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BOOKS_PER_SHELF,
  LIBRARY_SIZE,
  PAGES_IN_LAST_ROOM,
  PAGES_PER_BOOK,
  ROOM_COUNT,
  SHELVES_PER_WALL,
  WALLS_PER_ROOM,
  assertValidAddress,
  fromLinear,
  roomToName,
} from '@core/address';
import type { Address } from '@core/address';
import {
  AddressBeyondLibraryError,
  InvalidAddressError,
  UnknownSymbolError,
} from '@core/errors';
import { FORMAT_VERSION } from '@core/format';
import {
  SUPPORTED_LANGUAGES,
  addressToFragment,
  fragmentToAddress,
  type Language,
} from '../url';
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
} from '../errors';

/**
 * The codec is a pure pair of functions, so every case below is an example or a
 * property — there is no thread, no DOM and no clock to arrange.
 *
 * The case counts are written out rather than routed through
 * `src/core/__tests__/property-runs.ts`. That helper caps properties under
 * Stryker, whose Vitest configuration includes only `src/core/__tests__/**`
 * (ADR-0008), so nothing here ever runs under it and the cap would be a no-op
 * with a misleading name attached. The fixed seed from `fast-check-setup.ts`
 * does apply: it is a global `setupFiles` entry.
 */

/** The version segment this build serves. Never written as `v1`: ADR-0003 makes
 *  the version the thing a format change announces itself with, so a test that
 *  hard-coded it would keep passing through exactly the change it should catch. */
const VERSION = `v${String(FORMAT_VERSION)}`;

/**
 * A version this build does not serve. Derived from `FORMAT_VERSION` rather
 * than written as `v2`, so that after a deliberate bump (ADR-0003) this stays a
 * case of an *unknown* version instead of quietly becoming the current one.
 * Today it is `v2`, which the first test below pins.
 */
const UNKNOWN_VERSION = `v${String(FORMAT_VERSION + 1)}`;

/** SPEC §3: a full room name runs to 3197 base-36 characters. */
const LONGEST_ROOM_NAME_LENGTH = 3197;

/** The first address in the library: room 0, wall 0, shelf 0, volume 0, page 0. */
const FIRST_ADDRESS: Address = { room: 0n, wall: 0, shelf: 0, volume: 0, page: 0 };

/** The last address that exists: linear index LIBRARY_SIZE - 1, in the partially
 *  filled final room (SPEC §3). */
const LAST_ADDRESS: Address = fromLinear(LIBRARY_SIZE - 1n);

/** A readable fragment for an address whose room name is one character long. */
function shortFragment(parts: {
  room?: string;
  wall?: string;
  shelf?: string;
  volume?: string;
  page?: string;
  parameters?: string;
}): string {
  const room = parts.room ?? '0';
  const wall = parts.wall ?? '0';
  const shelf = parts.shelf ?? '0';
  const volume = parts.volume ?? '0';
  const page = parts.page ?? '0';
  return `#/${VERSION}/r/${room}/w/${wall}/s/${shelf}/b/${volume}/p/${page}${parts.parameters ?? ''}`;
}

describe('addressToFragment', () => {
  it('writes the scheme of SPEC §7', () => {
    const address: Address = { room: 42n, wall: 2, shelf: 3, volume: 17, page: 409 };

    const fragment = addressToFragment(address);

    expect(fragment).toBe(`#/${VERSION}/r/16/w/2/s/3/b/17/p/409`);
  });

  it('carries the version from FORMAT_VERSION rather than a literal', () => {
    const fragment = addressToFragment(FIRST_ADDRESS);

    expect(fragment.startsWith(`#/v${String(FORMAT_VERSION)}/`)).toBe(true);
  });

  it('names a room in base 36, canonically', () => {
    const fragment = addressToFragment({ ...FIRST_ADDRESS, room: 35n });

    expect(fragment).toBe(shortFragment({ room: 'z' }));
  });

  it('appends the query and the language in the order SPEC §7 lists them', () => {
    const fragment = addressToFragment(FIRST_ADDRESS, {
      query: 'лабиринт',
      language: 'ru',
    });

    expect(fragment).toBe(
      shortFragment({
        parameters: '?q=%D0%BB%D0%B0%D0%B1%D0%B8%D1%80%D0%B8%D0%BD%D1%82&lang=ru',
      })
    );
  });

  it('percent-encodes a space rather than writing a plus', () => {
    const fragment = addressToFragment(FIRST_ADDRESS, { query: 'a b' });

    expect(fragment).toBe(shortFragment({ parameters: '?q=a%20b' }));
  });

  it('percent-encodes the characters that delimit the scheme itself', () => {
    const fragment = addressToFragment(FIRST_ADDRESS, { query: '?&=/#%' });

    expect(fragment).toBe(shortFragment({ parameters: '?q=%3F%26%3D%2F%23%25' }));
  });

  it('omits the query string when neither parameter is given', () => {
    expect(addressToFragment(FIRST_ADDRESS)).toBe(shortFragment({}));
  });

  it('writes a language without a query', () => {
    const fragment = addressToFragment(FIRST_ADDRESS, { language: 'en' });

    expect(fragment).toBe(shortFragment({ parameters: '?lang=en' }));
  });

  it('refuses to produce a link to an address out of range', () => {
    expect(() => addressToFragment({ ...FIRST_ADDRESS, page: PAGES_PER_BOOK })).toThrow(
      InvalidAddressError
    );
  });

  it('refuses to produce a link into the unfilled tail of the last room', () => {
    const beyond = fromLinear(LIBRARY_SIZE);

    expect(() => addressToFragment(beyond)).toThrow(AddressBeyondLibraryError);
  });

  it('refuses a language the interface does not have', () => {
    // The language is remembered between sessions (SPEC §8), so it reaches the
    // serialiser from storage and the type alone does not make it trustworthy.
    const fromStorage = 'de' as Language;

    expect(() => addressToFragment(FIRST_ADDRESS, { language: fromStorage })).toThrow(
      UnknownLanguageError
    );
  });
});

describe('fragmentToAddress', () => {
  it('reads the scheme of SPEC §7', () => {
    const parsed = fragmentToAddress(`#/${VERSION}/r/16/w/2/s/3/b/17/p/409`);

    expect(parsed.address).toEqual({
      room: 42n,
      wall: 2,
      shelf: 3,
      volume: 17,
      page: 409,
    });
    expect(parsed.query).toBeNull();
    expect(parsed.language).toBeNull();
    expect(parsed.isCanonical).toBe(true);
    expect(parsed.hasCanonicalRoomName).toBe(true);
  });

  it('decodes the query and the language', () => {
    const parsed = fragmentToAddress(
      shortFragment({
        parameters: '?q=%D0%BB%D0%B0%D0%B1%D0%B8%D1%80%D0%B8%D0%BD%D1%82&lang=ru',
      })
    );

    expect(parsed.query).toBe('лабиринт');
    expect(parsed.language).toBe('ru');
  });

  it('reads a plus as a literal plus, not as a space', () => {
    const parsed = fragmentToAddress(shortFragment({ parameters: '?q=a+b' }));

    expect(parsed.query).toBe('a+b');
  });

  it('reads an empty query as an empty string, not as an absent one', () => {
    const parsed = fragmentToAddress(shortFragment({ parameters: '?q=' }));

    expect(parsed.query).toBe('');
  });

  it('accepts either parameter alone', () => {
    expect(fragmentToAddress(shortFragment({ parameters: '?lang=en' })).language).toBe(
      'en'
    );
    expect(fragmentToAddress(shortFragment({ parameters: '?q=a' })).query).toBe('a');
  });

  it('resolves a non-canonical room name and reports the canonical fragment', () => {
    const fragment = shortFragment({ room: '0001' });

    const parsed = fragmentToAddress(fragment);

    expect(parsed.address.room).toBe(1n);
    expect(parsed.hasCanonicalRoomName).toBe(false);
    expect(parsed.isCanonical).toBe(false);
    expect(parsed.canonicalFragment).toBe(shortFragment({ room: '1' }));
  });

  it('reports a canonical room name inside a fragment that is not canonical', () => {
    // Leading zeros on a numeric component leave the room name untouched: the
    // two flags answer different questions, and a log that says which segment
    // was rewritten is worth more than one that says only that something was.
    const parsed = fragmentToAddress(shortFragment({ page: '007' }));

    expect(parsed.address.page).toBe(7);
    expect(parsed.hasCanonicalRoomName).toBe(true);
    expect(parsed.isCanonical).toBe(false);
    expect(parsed.canonicalFragment).toBe(shortFragment({ page: '7' }));
  });
});

describe('refusing a malformed fragment', () => {
  it('refuses a fragment without the scheme prefix', () => {
    const fragment = `/${VERSION}/r/0/w/0/s/0/b/0/p/0`;

    expect(() => fragmentToAddress(fragment)).toThrow(UrlPrefixError);
    try {
      fragmentToAddress(fragment);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UrlPrefixError);
      expect((error as UrlPrefixError).expectedPrefix).toBe('#/');
      expect((error as UrlPrefixError).fragment).toBe(fragment);
    }
  });

  it('refuses an unknown format version rather than opening a different book', () => {
    expect(UNKNOWN_VERSION).toBe('v2');
    const fragment = `#/${UNKNOWN_VERSION}/r/0/w/0/s/0/b/0/p/0`;

    try {
      fragmentToAddress(fragment);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownFormatVersionError);
      expect((error as UnknownFormatVersionError).received).toBe(UNKNOWN_VERSION);
      expect((error as UnknownFormatVersionError).expected).toBe(FORMAT_VERSION);
      expect((error as UnknownFormatVersionError).message).toContain('different text');
    }
  });

  it('refuses an unknown version whatever shape the rest of the path has', () => {
    // A future format may lay its path out differently. Reporting a segment
    // count for such a link would bury the only fact that matters about it.
    expect(() => fragmentToAddress(`#/${UNKNOWN_VERSION}/r/0`)).toThrow(
      UnknownFormatVersionError
    );
    expect(() =>
      fragmentToAddress(`#/${UNKNOWN_VERSION}/anything/at/all/0/1/2/3/4/5/6/7`)
    ).toThrow(UnknownFormatVersionError);
  });

  it('refuses a version segment that is not a version at all', () => {
    expect(() => fragmentToAddress('#/r/0/w/0/s/0/b/0/p/0')).toThrow(
      UnknownFormatVersionError
    );
    expect(() =>
      fragmentToAddress(`#/${VERSION.toUpperCase()}/r/0/w/0/s/0/b/0/p/0`)
    ).toThrow(UnknownFormatVersionError);
    expect(() => fragmentToAddress('#/v/r/0/w/0/s/0/b/0/p/0')).toThrow(
      UnknownFormatVersionError
    );
    expect(() => fragmentToAddress('#/v01/r/0/w/0/s/0/b/0/p/0')).toThrow(
      UnknownFormatVersionError
    );
  });

  it('refuses a fragment that is nothing but a version segment', () => {
    // No separator at all in the path: the version is still read, so the
    // refusal names the real problem in each direction.
    expect(() => fragmentToAddress(`#/${VERSION}`)).toThrow(UrlSegmentCountError);
    expect(() => fragmentToAddress('#/nonsense')).toThrow(UnknownFormatVersionError);
  });

  it('refuses a fragment with a segment missing', () => {
    const fragment = `#/${VERSION}/r/0/w/0/s/0/b/0/p`;

    try {
      fragmentToAddress(fragment);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UrlSegmentCountError);
      expect((error as UrlSegmentCountError).received).toBe(10);
      expect((error as UrlSegmentCountError).expected).toBe(11);
    }
  });

  it('refuses a fragment with a segment too many', () => {
    const fragment = `#/${VERSION}/r/0/w/0/s/0/b/0/p/0/extra`;

    try {
      fragmentToAddress(fragment);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UrlSegmentCountError);
      expect((error as UrlSegmentCountError).received).toBe(12);
      expect((error as UrlSegmentCountError).expected).toBe(11);
    }
  });

  it('refuses a trailing slash, which is a segment too many', () => {
    expect(() => fragmentToAddress(`${shortFragment({})}/`)).toThrow(
      UrlSegmentCountError
    );
  });

  it('refuses a label that names a component other than the one fixed there', () => {
    const fragment = `#/${VERSION}/r/0/s/0/s/0/b/0/p/0`;

    try {
      fragmentToAddress(fragment);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UrlSegmentLabelError);
      expect((error as UrlSegmentLabelError).position).toBe(3);
      expect((error as UrlSegmentLabelError).received).toBe('s');
      expect((error as UrlSegmentLabelError).expected).toBe('w');
    }
  });

  it('refuses the five labels being in the wrong order', () => {
    expect(() => fragmentToAddress(`#/${VERSION}/w/0/r/0/s/0/b/0/p/0`)).toThrow(
      UrlSegmentLabelError
    );
  });

  it('refuses a component that is not a decimal number', () => {
    const fragment = shortFragment({ page: 'abc' });

    try {
      fragmentToAddress(fragment);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NonNumericComponentError);
      expect((error as NonNumericComponentError).component).toBe('page');
      expect((error as NonNumericComponentError).value).toBe('abc');
    }
  });

  it('refuses the component spellings Number would have accepted', () => {
    // Number('') is 0, Number('1e2') is 100 and Number(' 7 ') is 7. Each of
    // those opens a real page that the link did not name.
    for (const page of ['', '1e2', ' 7 ', '+7', '-1', '1.5', '0x10', 'Infinity']) {
      expect(() => fragmentToAddress(shortFragment({ page }))).toThrow(
        NonNumericComponentError
      );
    }
  });

  it('refuses a room name carrying a glyph outside 0-9a-z', () => {
    const fragment = shortFragment({ room: '1Z' });

    try {
      fragmentToAddress(fragment);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownSymbolError);
      expect((error as UnknownSymbolError).symbols).toEqual([
        { symbol: 'Z', index: 1 },
      ]);
    }
  });

  it('refuses an empty room name', () => {
    expect(() => fragmentToAddress(shortFragment({ room: '' }))).toThrow(
      InvalidAddressError
    );
  });

  it('refuses each component out of range, naming the bound it crossed', () => {
    const cases = [
      { parts: { wall: String(WALLS_PER_ROOM) }, component: 'wall' },
      { parts: { shelf: String(SHELVES_PER_WALL) }, component: 'shelf' },
      { parts: { volume: String(BOOKS_PER_SHELF) }, component: 'volume' },
      { parts: { page: String(PAGES_PER_BOOK) }, component: 'page' },
      { parts: { room: roomToName(ROOM_COUNT) }, component: 'room' },
    ];

    for (const { parts, component } of cases) {
      try {
        fragmentToAddress(shortFragment(parts));
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidAddressError);
        expect((error as InvalidAddressError).component).toBe(component);
      }
    }
  });

  it('refuses an address in the unfilled tail of the last room', () => {
    const beyond = fromLinear(LIBRARY_SIZE);
    const fragment = `#/${VERSION}/r/${roomToName(beyond.room)}/w/${String(beyond.wall)}/s/${String(beyond.shelf)}/b/${String(beyond.volume)}/p/${String(beyond.page)}`;

    expect(() => fragmentToAddress(fragment)).toThrow(AddressBeyondLibraryError);
  });

  it('refuses a language the interface does not have', () => {
    const fragment = shortFragment({ parameters: '?lang=de' });

    try {
      fragmentToAddress(fragment);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownLanguageError);
      expect((error as UnknownLanguageError).received).toBe('de');
      expect((error as UnknownLanguageError).supported).toEqual(SUPPORTED_LANGUAGES);
    }
  });

  it('refuses a parameter the scheme does not define', () => {
    const fragment = shortFragment({ parameters: '?zoom=3' });

    try {
      fragmentToAddress(fragment);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownUrlParameterError);
      expect((error as UnknownUrlParameterError).parameter).toBe('zoom');
      expect((error as UnknownUrlParameterError).supported).toEqual(['q', 'lang']);
    }
  });

  it('refuses a near miss for a parameter that does exist', () => {
    expect(() => fragmentToAddress(shortFragment({ parameters: '?lng=ru' }))).toThrow(
      UnknownUrlParameterError
    );
  });

  it('reads a parameter written without a value as carrying an empty one', () => {
    // `?q` and `?q=` mean the same thing; `?lang` names no language at all,
    // which is a language the interface does not have.
    expect(fragmentToAddress(shortFragment({ parameters: '?q' })).query).toBe('');
    expect(() => fragmentToAddress(shortFragment({ parameters: '?lang' }))).toThrow(
      UnknownLanguageError
    );
    expect(() => fragmentToAddress(shortFragment({ parameters: '?zoom' }))).toThrow(
      UnknownUrlParameterError
    );
  });

  it('refuses a repeated parameter rather than picking one of the two', () => {
    const fragment = shortFragment({ parameters: '?q=one&q=two' });

    try {
      fragmentToAddress(fragment);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateUrlParameterError);
      expect((error as DuplicateUrlParameterError).parameter).toBe('q');
    }
  });

  it('refuses a repeated language', () => {
    expect(() =>
      fragmentToAddress(shortFragment({ parameters: '?lang=ru&lang=en' }))
    ).toThrow(DuplicateUrlParameterError);
  });

  it('refuses a parameter value that is not valid percent-encoding', () => {
    const fragment = shortFragment({ parameters: '?q=%D0' });

    try {
      fragmentToAddress(fragment);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UndecodableParameterError);
      expect((error as UndecodableParameterError).parameter).toBe('q');
      expect((error as UndecodableParameterError).value).toBe('%D0');
    }
  });
});

describe('the round trip', () => {
  /**
   * Generators reaching the edges deliberately (testing.md §2): a uniform draw
   * over every linear index in the library, the first rooms, the last rooms —
   * where the base-36 name reaches its full 3197 characters — and the
   * partially filled final room, whose valid pages stop at
   * PAGES_IN_LAST_ROOM rather than PAGES_PER_ROOM.
   */
  const anywhereInTheLibrary: fc.Arbitrary<Address> = fc
    .bigInt({ min: 0n, max: LIBRARY_SIZE - 1n })
    .map(fromLinear);

  const firstRooms: fc.Arbitrary<Address> = components(
    fc.bigInt({ min: 0n, max: 255n })
  );

  const lastRooms: fc.Arbitrary<Address> = components(
    fc.bigInt({ min: ROOM_COUNT - 256n, max: ROOM_COUNT - 2n })
  );

  const theFinalRoom: fc.Arbitrary<Address> = fc
    .integer({ min: 0, max: Number(PAGES_IN_LAST_ROOM) - 1 })
    .map((offsetFromTheEnd) =>
      fromLinear(LIBRARY_SIZE - 1n - BigInt(offsetFromTheEnd))
    );

  /** Every component drawn independently, for a room the caller chooses. */
  function components(room: fc.Arbitrary<bigint>): fc.Arbitrary<Address> {
    return fc.record({
      room,
      wall: fc.integer({ min: 0, max: WALLS_PER_ROOM - 1 }),
      shelf: fc.integer({ min: 0, max: SHELVES_PER_WALL - 1 }),
      volume: fc.integer({ min: 0, max: BOOKS_PER_SHELF - 1 }),
      page: fc.integer({ min: 0, max: PAGES_PER_BOOK - 1 }),
    });
  }

  const anyAddress: fc.Arbitrary<Address> = fc.oneof(
    anywhereInTheLibrary,
    firstRooms,
    lastRooms,
    theFinalRoom
  );

  /**
   * A query built from the characters that can actually break a fragment:
   * Cyrillic, which is what this library's text is made of, and the delimiters
   * of the scheme itself.
   */
  const QUERY_CHARACTERS = [
    'а',
    'б',
    'в',
    'ю',
    'я',
    'a',
    'z',
    '0',
    '9',
    ' ',
    '?',
    '&',
    '=',
    '/',
    '#',
    '%',
    '+',
    '-',
    '_',
    '.',
    '~',
  ];

  const query: fc.Arbitrary<string> = fc
    .array(fc.constantFrom(...QUERY_CHARACTERS), { maxLength: 24 })
    .map((characters) => characters.join(''));

  const language: fc.Arbitrary<Language> = fc.constantFrom(...SUPPORTED_LANGUAGES);

  it('parse(serialise(address)) === address over the whole address space', () => {
    fc.assert(
      fc.property(anyAddress, (address) => {
        const { address: roundTripped } = fragmentToAddress(addressToFragment(address));
        return (
          roundTripped.room === address.room &&
          roundTripped.wall === address.wall &&
          roundTripped.shelf === address.shelf &&
          roundTripped.volume === address.volume &&
          roundTripped.page === address.page
        );
      }),
      { numRuns: 1000 }
    );
  });

  it('carries the query and the language through the round trip', () => {
    fc.assert(
      fc.property(anyAddress, query, language, (address, q, lang) => {
        const parsed = fragmentToAddress(
          addressToFragment(address, { query: q, language: lang })
        );
        return parsed.query === q && parsed.language === lang;
      }),
      { numRuns: 300 }
    );
  });

  it('calls its own output canonical', () => {
    // The reverse direction is not a bijection — malformed strings outnumber
    // well-formed ones — so serialise(parse(s)) === s is asserted only over
    // strings the serialiser produced.
    fc.assert(
      fc.property(anyAddress, query, language, (address, q, lang) => {
        const fragment = addressToFragment(address, { query: q, language: lang });
        const parsed = fragmentToAddress(fragment);
        return (
          parsed.isCanonical &&
          parsed.hasCanonicalRoomName &&
          parsed.canonicalFragment === fragment
        );
      }),
      { numRuns: 300 }
    );
  });

  it('round-trips the first address in the library', () => {
    const fragment = addressToFragment(FIRST_ADDRESS);

    expect(fragment).toBe(`#/${VERSION}/r/0/w/0/s/0/b/0/p/0`);
    expect(fragmentToAddress(fragment).address).toEqual(FIRST_ADDRESS);
  });

  it('round-trips the last address that exists', () => {
    const fragment = addressToFragment(LAST_ADDRESS);

    expect(fragmentToAddress(fragment).address).toEqual(LAST_ADDRESS);
    expect(LAST_ADDRESS.room).toBe(ROOM_COUNT - 1n);
    expect(() => {
      assertValidAddress({ ...LAST_ADDRESS, page: LAST_ADDRESS.page + 1 });
    }).toThrow(AddressBeyondLibraryError);
  });
});

describe('the longest fragment', () => {
  it('writes a 3197-character room name in full, with no truncation', () => {
    const name = roomToName(LAST_ADDRESS.room);

    const fragment = addressToFragment(LAST_ADDRESS);

    expect(name).toHaveLength(LONGEST_ROOM_NAME_LENGTH);
    expect(fragment).toContain(`/r/${name}/`);
    expect(fragmentToAddress(fragment).address.room).toBe(LAST_ADDRESS.room);
  });

  it('measures the longest fragment the codec can produce', () => {
    // The widest address with a full-length room name: the last room cannot
    // hold the widest components, so this is the room before it.
    const widest: Address = {
      room: ROOM_COUNT - 2n,
      wall: WALLS_PER_ROOM - 1,
      shelf: SHELVES_PER_WALL - 1,
      volume: BOOKS_PER_SHELF - 1,
      page: PAGES_PER_BOOK - 1,
    };

    const bare = addressToFragment(widest);
    const withParameters = addressToFragment(widest, {
      query: 'лабиринт',
      language: 'ru',
    });

    // 3223 = the 3197-character room name plus 26 characters of scheme:
    // `#/v1/r/`, `/w/3`, `/s/4`, `/b/31`, `/p/409`. The parameters add 59:
    // `?q=` plus eight Cyrillic characters at six characters each once
    // percent-encoded, plus `&lang=ru`.
    expect(roomToName(widest.room)).toHaveLength(LONGEST_ROOM_NAME_LENGTH);
    expect(bare).toHaveLength(LONGEST_ROOM_NAME_LENGTH + 26);
    expect(withParameters).toHaveLength(LONGEST_ROOM_NAME_LENGTH + 26 + 59);
  });
});

describe('browser globals', () => {
  /**
   * `docs/architecture.md` §4 gives the navigation FSM the URL, and nothing
   * else may touch `location`. The codec is pure by construction — the tests
   * above run under Vitest's `node` environment, where a browser global would
   * throw — but construction is what changes, so the source is checked too.
   *
   * Comments are stripped first, because the doc comment in `url.ts` names the
   * globals it promises not to use. The stripping is deliberately simple; it is
   * adequate for these two files, where no string literal contains a comment
   * opener.
   */
  const BROWSER_GLOBALS = [
    'window',
    'document',
    'location',
    'history',
    'navigator',
    'localStorage',
    'sessionStorage',
  ];

  function codeWithoutComments(file: string): string {
    return readFileSync(resolve('src/app', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
  }

  it.each(['url.ts', 'errors.ts'])('%s names no browser global', (file) => {
    const code = codeWithoutComments(file);

    for (const global of BROWSER_GLOBALS) {
      expect(code).not.toMatch(new RegExp(`\\b${global}\\b`));
    }
  });
});
