/**
 * Regenerate `src/core/__fixtures__/golden-vectors.json`.
 *
 * Read ADR-0003 before running this. The golden vectors are a **compatibility
 * contract**, not a snapshot: a red golden test means the library format
 * changed and every link ever shared now points at different text. The fix for
 * a red golden test is to revert the change or to bump `FORMAT_VERSION`
 * deliberately — never to run this script.
 *
 * Run with:  npm run golden:regenerate
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  BOOKS_PER_SHELF,
  LIBRARY_SIZE,
  PAGES_IN_LAST_ROOM,
  PAGES_PER_BOOK,
  PAGES_PER_ROOM,
  PAGE_LENGTH,
  ROOM_COUNT,
  SHELVES_PER_WALL,
  WALLS_PER_ROOM,
  fromLinear,
  type Address,
} from '../src/core/address';
import { PAGE_ALPHABET, digitToSymbol } from '../src/core/alphabet';
import { intToDigits } from '../src/core/bignum';
import { FORMAT_VERSION, getPage, getTitle, locate, search } from '../src/core/library';
import { DOMAIN_TAG, PRF_BYTES } from '../src/core/prf';
import { ROUNDS } from '../src/core/feistel';
import type { GoldenVectors } from '../src/core/__fixtures__/golden-vectors';

const WARNING = `
────────────────────────────────────────────────────────────────────────────
  ADR-0003 — THE FORMAT IS FROZEN

  The golden vectors are a COMPATIBILITY CONTRACT, not a snapshot.

  A red golden-vector test does not mean the fixture is stale. It means the
  library format has changed: the alphabet order, DOMAIN_TAG, the round
  count, PRF_BYTES or the address linearisation. All 36^3200 books have been
  replaced at once, and every link anyone has ever shared now points at
  different text. Nothing in the code will fail; users will simply be lied
  to.

  Regenerating this fixture to make a test pass destroys the only alarm the
  project has. If a golden test is red, either revert the change, or bump
  FORMAT_VERSION deliberately and say so in the pull request.

  Overwriting the fixture now.
────────────────────────────────────────────────────────────────────────────
`;

const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const addressOf = (linear: bigint): Address => fromLinear(linear);

/** The first address past the end of the library: the unfilled tail (SPEC §3). */
const firstInvalidLinear =
  BigInt(PAGES_PER_ROOM) * (ROOM_COUNT - 1n) + PAGES_IN_LAST_ROOM;

const namedAddresses: readonly (readonly [string, Address, string])[] = [
  [
    'first-page-of-the-library',
    { room: 0n, wall: 0, shelf: 0, volume: 0, page: 0 },
    'linear index 0 — room 0, the very first page',
  ],
  [
    'room-0-page-1',
    { room: 0n, wall: 0, shelf: 0, volume: 0, page: 1 },
    'the neighbour of the first page; a linear bijection would correlate the two',
  ],
  [
    'room-0-last-page',
    {
      room: 0n,
      wall: WALLS_PER_ROOM - 1,
      shelf: SHELVES_PER_WALL - 1,
      volume: BOOKS_PER_SHELF - 1,
      page: PAGES_PER_BOOK - 1,
    },
    'the last page of room 0, every component at its maximum',
  ],
  [
    'second-room-first-page',
    { room: 1n, wall: 0, shelf: 0, volume: 0, page: 0 },
    'the first page of room 1, pinning the room stride',
  ],
  [
    'mid-library',
    { room: 123456789012345678901234567890n, wall: 2, shelf: 3, volume: 17, page: 205 },
    'an ordinary address with a room index too large for a number',
  ],
  [
    'last-legal-address',
    addressOf(LIBRARY_SIZE - 1n),
    'the last legal address, in the partially filled final room (SPEC §3)',
  ],
  [
    'first-page-of-last-room',
    { room: ROOM_COUNT - 1n, wall: 0, shelf: 0, volume: 0, page: 0 },
    'the first page of the final room',
  ],
];

/** Pages chosen by their text rather than their address. */
const namedPages: readonly (readonly [string, string, string])[] = [
  [
    'all-index-0-symbols',
    digitToSymbol(PAGE_ALPHABET, 0).repeat(PAGE_LENGTH),
    'a page of 3200 spaces — the value 0, where fixed-length radix conversion breaks',
  ],
  [
    'maximum-value',
    intToDigits(LIBRARY_SIZE - 1n, PAGE_ALPHABET, PAGE_LENGTH),
    'the page holding the value one below 36^3200',
  ],
  [
    'single-trailing-symbol',
    `${digitToSymbol(PAGE_ALPHABET, 0).repeat(PAGE_LENGTH - 1)}${digitToSymbol(PAGE_ALPHABET, 1)}`,
    'the value 1 — 3199 leading zeros and a single significant digit',
  ],
];

const searchPhrases: readonly (readonly [string, 'spaces', number])[] = [
  ['книга', 'spaces', 0],
  ['библиотека вавилона', 'spaces', 1000],
  ['ёж', 'spaces', 3198],
  ['слово,', 'spaces', 3194],
];

function build(): GoldenVectors {
  return {
    $comment:
      'COMPATIBILITY CONTRACT (ADR-0003). A red test here means the library format changed and every shared link now points at different text. Never regenerate this file to make a test pass.',
    formatVersion: FORMAT_VERSION,
    parameters: {
      domainTag: DOMAIN_TAG,
      rounds: ROUNDS,
      prfBytes: PRF_BYTES,
      pageLength: PAGE_LENGTH,
      radix: PAGE_ALPHABET.radix,
      alphabet: PAGE_ALPHABET.symbols.join(''),
    },
    pages: namedAddresses.map(([name, address, note]) => {
      const text = getPage(address);
      return {
        name,
        note,
        address: {
          room: address.room.toString(),
          wall: address.wall,
          shelf: address.shelf,
          volume: address.volume,
          page: address.page,
        },
        sha256: sha256Hex(text),
        first64: text.slice(0, 64),
        title: getTitle({
          room: address.room,
          wall: address.wall,
          shelf: address.shelf,
          volume: address.volume,
        }),
      };
    }),
    locations: namedPages.map(([name, text, note]) => {
      const address = locate(text);
      return {
        name,
        note,
        pageSha256: sha256Hex(text),
        address: {
          room: address.room.toString(),
          wall: address.wall,
          shelf: address.shelf,
          volume: address.volume,
          page: address.page,
        },
      };
    }),
    searches: searchPhrases.map(([query, mode, offset]) => {
      const hit = search(query, mode, offset);
      return {
        query,
        mode,
        offset: hit.offset,
        address: {
          room: hit.address.room.toString(),
          wall: hit.address.wall,
          shelf: hit.address.shelf,
          volume: hit.address.volume,
          page: hit.address.page,
        },
      };
    }),
    invalid: {
      note: 'The first address past the end of the library (SPEC §3). It must stay invalid.',
      linear: firstInvalidLinear.toString(),
      librarySize: LIBRARY_SIZE.toString(),
    },
  };
}

function main(): void {
  process.stdout.write(WARNING);

  const target = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'core',
    '__fixtures__',
    'golden-vectors.json'
  );

  writeFileSync(target, `${JSON.stringify(build(), null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote ${target}\n`);
}

main();
