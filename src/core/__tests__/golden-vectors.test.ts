import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import vectors from '../__fixtures__/golden-vectors.json';
import type { GoldenAddress, GoldenVectors } from '../__fixtures__/golden-vectors';
import { LIBRARY_SIZE, PAGE_LENGTH, toLinear, type Address } from '../address';
import { PAGE_ALPHABET, digitToSymbol } from '../alphabet';
import { intToDigits } from '../bignum';
import { AddressBeyondLibraryError } from '../errors';
import { ROUNDS } from '../feistel';
import {
  FORMAT_VERSION,
  TITLE_LENGTH,
  getPage,
  getTitle,
  locate,
  search,
  type PadMode,
} from '../library';
import { DOMAIN_TAG, PRF_BYTES } from '../prf';

/**
 * The golden vectors are a **compatibility contract**, not a snapshot
 * (ADR-0003). A failure in this file does not mean the fixture is stale: it
 * means the library format changed, every one of the 36^3200 books was
 * replaced at once, and every link anyone has ever shared now points at
 * different text. Nothing else in the suite would notice.
 *
 * The correct response to a red test here is to revert the change, or to bump
 * `FORMAT_VERSION` deliberately and say so in the pull request. It is never to
 * run `npm run golden:regenerate`.
 *
 * The hashes are checked with Node's SHA-256 rather than the library's own
 * `@noble/hashes`, so a fault in that dependency cannot agree with itself.
 */

const golden: GoldenVectors = vectors;

const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const toAddress = (address: GoldenAddress): Address => ({
  room: BigInt(address.room),
  wall: address.wall,
  shelf: address.shelf,
  volume: address.volume,
  page: address.page,
});

/** Narrow the fixture's `mode` string at the boundary, rather than asserting. */
const toPadMode = (mode: string): PadMode => {
  if (mode === 'spaces' || mode === 'random') {
    return mode;
  }
  throw new Error(`Golden fixture carries an unknown pad mode: ${mode}`);
};

/**
 * The three pages that are named by their text rather than their address.
 * Rebuilt from their definitions here, so the fixture pins the hash of the
 * page a definition produces rather than a blob nobody can re-derive.
 */
const pageByName = new Map<string, () => string>([
  [
    'all-index-0-symbols',
    (): string => digitToSymbol(PAGE_ALPHABET, 0).repeat(PAGE_LENGTH),
  ],
  [
    'maximum-value',
    (): string => intToDigits(LIBRARY_SIZE - 1n, PAGE_ALPHABET, PAGE_LENGTH),
  ],
  [
    'single-trailing-symbol',
    (): string =>
      `${digitToSymbol(PAGE_ALPHABET, 0).repeat(PAGE_LENGTH - 1)}${digitToSymbol(PAGE_ALPHABET, 1)}`,
  ],
]);

describe('the golden fixture itself', () => {
  it('is populated, so that nothing here can pass by being empty', () => {
    expect(golden.pages.length).toBeGreaterThanOrEqual(7);
    expect(golden.locations.length).toBeGreaterThanOrEqual(3);
    expect(golden.searches.length).toBeGreaterThanOrEqual(4);
  });

  it('carries a definition for every page named by its text', () => {
    for (const location of golden.locations) {
      expect(pageByName.has(location.name)).toBe(true);
    }
  });

  it('says in the file what it is for', () => {
    expect(golden.$comment).toMatch(/CONTRACT/);
    expect(golden.$comment).toMatch(/ADR-0003/);
  });
});

describe('the frozen format parameters (SPEC §4.5)', () => {
  it('still has the format version the fixture was built under', () => {
    expect(golden.formatVersion).toBe(FORMAT_VERSION);
  });

  it('still has the domain tag, round count and PRF byte count', () => {
    expect(golden.parameters.domainTag).toBe(DOMAIN_TAG);
    expect(golden.parameters.rounds).toBe(ROUNDS);
    expect(golden.parameters.prfBytes).toBe(PRF_BYTES);
  });

  it('still has the page length, radix and alphabet order', () => {
    expect(golden.parameters.pageLength).toBe(PAGE_LENGTH);
    expect(golden.parameters.radix).toBe(PAGE_ALPHABET.radix);
    expect(golden.parameters.alphabet).toBe(PAGE_ALPHABET.symbols.join(''));
  });
});

describe('pages pinned by address', () => {
  for (const vector of golden.pages) {
    describe(vector.name, () => {
      it(`still holds the same text (${vector.note})`, () => {
        const page = getPage(toAddress(vector.address));

        expect(page).toHaveLength(PAGE_LENGTH);
        expect(sha256Hex(page)).toBe(vector.sha256);
        expect(page.slice(0, 64)).toBe(vector.first64);
      });

      it('still has the same title', () => {
        const { room, wall, shelf, volume } = toAddress(vector.address);

        expect(getTitle({ room, wall, shelf, volume })).toBe(vector.title);
        expect(vector.title).toHaveLength(TITLE_LENGTH);
      });

      it('still locates back to its own address', () => {
        const address = toAddress(vector.address);

        expect(locate(getPage(address))).toEqual(address);
      });
    });
  }
});

describe('pages pinned by text', () => {
  for (const vector of golden.locations) {
    it(`${vector.name} still lives at the same address (${vector.note})`, () => {
      const build = pageByName.get(vector.name);
      expect(build).toBeDefined();
      const page = build?.() ?? '';

      expect(sha256Hex(page)).toBe(vector.pageSha256);
      expect(locate(page)).toEqual(toAddress(vector.address));
    });
  }
});

describe('search results', () => {
  for (const vector of golden.searches) {
    it(`"${vector.query}" at offset ${String(vector.offset)} still lands at the same book`, () => {
      const hit = search(vector.query, toPadMode(vector.mode), vector.offset);

      expect(hit.offset).toBe(vector.offset);
      expect(hit.address).toEqual(toAddress(vector.address));
      expect(
        getPage(hit.address).slice(vector.offset, vector.offset + vector.query.length)
      ).toBe(vector.query);
    });
  }
});

describe('the edge of the domain', () => {
  it('still ends where it did: the library size is unchanged', () => {
    expect(golden.invalid.librarySize).toBe(LIBRARY_SIZE.toString());
  });

  it('still refuses the first address past the end of the library', () => {
    // The fixture pins the linear index of the unfilled tail of the last room
    // (SPEC §3). If this ever became a valid address the library would have
    // grown pages that do not exist.
    expect(golden.invalid.linear).toBe(LIBRARY_SIZE.toString());

    const firstInvalid = golden.pages.find(
      (page) => page.name === 'last-legal-address'
    );
    expect(firstInvalid).toBeDefined();

    const lastLegal = toAddress(
      firstInvalid?.address ?? { room: '0', wall: 0, shelf: 0, volume: 0, page: 0 }
    );
    expect(toLinear(lastLegal)).toBe(LIBRARY_SIZE - 1n);
    expect(() => getPage({ ...lastLegal, page: lastLegal.page + 1 })).toThrow(
      AddressBeyondLibraryError
    );
  });
});
