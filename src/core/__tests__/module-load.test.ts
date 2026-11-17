import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * What `core` builds while its modules are being imported, asserted from
 * outside the import.
 *
 * Every other test file in this directory imports its subject at the top. That
 * is the right shape for testing a function and it is blind to one class of
 * defect: when a mutation makes a module *body* throw, every file that imports
 * that module fails to collect, so it contributes no failing test — only a
 * failing file. The suite still goes red, and a person reading it sees why;
 * Stryker's Vitest runner reads verdicts from test tasks, sees a run with no
 * failing test in it, and records `Survived`. Eight mutants were reported that
 * way in all thirteen nightly runs of one commit (ADR-0031, issue #6).
 *
 * This file therefore imports nothing from `core` at the top: with the module
 * body broken it still collects, and each test evaluates that body itself,
 * inside a test, where a throw is a failing test rather than a missing file.
 *
 * The constants below are asserted in `address.test.ts`, `prf.test.ts` and
 * `alphabet.test.ts` as well. The duplication is the point: there the subject
 * is the value, here it is the import, and asserting the value is what lets
 * this file fail for the right reason rather than merely observing that an
 * import resolved.
 */

beforeEach(() => {
  // Each test evaluates the module body itself rather than inheriting an
  // instance an earlier test loaded. A cached module body runs once, so
  // without this the first test to reach a module would be the only one that
  // could fail when its body throws.
  vi.resetModules();
});

describe('the core barrel', () => {
  it('evaluates every core module and re-exports the generation surface', async () => {
    // The barrel imports all eight modules (ADR-0029), so this is the one test
    // that fails for a load-time throw anywhere in `core`, including in a
    // module added after this file was written.
    const core = await import('../index');

    expect(Object.keys(core)).toEqual(
      expect.arrayContaining([
        'getPage',
        'getTitle',
        'locate',
        'search',
        'randomAddress',
      ])
    );
  });
});

describe('the alphabet tables', () => {
  it('builds the frozen page alphabet while loading', async () => {
    const { PAGE_ALPHABET } = await import('../alphabet');

    expect(PAGE_ALPHABET.symbols.join('')).toBe(' абвгдеёжзийклмнопрстуфхцчшщъыьэюя,.');
    expect(PAGE_ALPHABET.digitBySymbol.size).toBe(36);
    PAGE_ALPHABET.symbols.forEach((symbol, digit) => {
      expect(PAGE_ALPHABET.digitBySymbol.get(symbol)).toBe(digit);
    });
  });

  it('builds the room alphabet while loading', async () => {
    const { ROOM_ALPHABET } = await import('../alphabet');

    expect(ROOM_ALPHABET.symbols.join('')).toBe('0123456789abcdefghijklmnopqrstuvwxyz');
    expect(ROOM_ALPHABET.digitBySymbol.size).toBe(36);
  });
});

describe('the address constants', () => {
  it('computes the SPEC §3 arithmetic while loading', async () => {
    const { PAGES_PER_ROOM, LIBRARY_SIZE, ROOM_COUNT, PAGES_IN_LAST_ROOM } =
      await import('../address');

    expect(PAGES_PER_ROOM).toBe(262_400);
    expect(LIBRARY_SIZE).toBe(36n ** 3200n);
    expect(PAGES_IN_LAST_ROOM).toBe(261_376n);

    // ROOM_COUNT by its definition — the smallest room count that holds the
    // library — rather than by the ceiling expression the module uses, which
    // would only restate the line under test.
    const pagesPerRoom = BigInt(PAGES_PER_ROOM);
    expect(ROOM_COUNT * pagesPerRoom).toBeGreaterThanOrEqual(LIBRARY_SIZE);
    expect((ROOM_COUNT - 1n) * pagesPerRoom).toBeLessThan(LIBRARY_SIZE);
  });
});

describe('the PRF tables', () => {
  it('encodes the domain tag and the hex table while loading', async () => {
    const { seedInput, fromBytesBE, DOMAIN_TAG, HALF_LENGTH, HALF_DOMAIN } =
      await import('../prf');

    // `DOMAIN_TAG_BYTES` and `HEX_PAIRS` are module-private and built at load.
    // `seedInput` prefixes the seed with the first and `fromBytesBE` reads
    // every byte through the second, so these two calls are the public path to
    // each of them.
    expect(Array.from(seedInput(0, 0n).subarray(0, DOMAIN_TAG.length))).toEqual(
      Array.from(DOMAIN_TAG, (character) => character.charCodeAt(0))
    );
    expect(fromBytesBE(Uint8Array.of(0xde, 0xad))).toBe(0xdeadn);

    expect(HALF_LENGTH).toBe(1600);
    expect(HALF_DOMAIN).toBe(36n ** 1600n);
  });
});

describe('the library constants', () => {
  it('computes the title shift while loading', async () => {
    const { TITLE_LENGTH, TITLE_SHIFT } = await import('../library');

    expect(TITLE_LENGTH).toBe(25);
    expect(TITLE_SHIFT).toBe(36n ** 3175n);
  });
});
