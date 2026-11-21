import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  LIBRARY_SIZE,
  PAGE_LENGTH,
  ROOM_COUNT,
  TITLE_LENGTH,
  fromLinear,
  getPage,
  getTitle,
  locate,
  search,
} from '@core/index';
import type { Address, BookAddress, PadMode, RandomSource } from '@core/index';
import {
  createProtocolHandlerState,
  handleProtocolMessage,
  type ProtocolHandlerState,
} from '../handler';
import {
  FIRST_REQUEST_ID,
  type ProtocolResponse,
  type ResponseKind,
} from '../protocol';
import {
  PINNED_SOURCE_BYTE_CAP,
  PinnedSourceExhaustedError,
  pinnedRandomSource,
} from './pinned-random';

/**
 * The protocol handler is a pure function, so every case below is an example or
 * a property rather than an assertion about a thread. The integration test
 * through a real `Worker` that M3 also asks for is a separate change: the
 * handler is where the bugs are, the thread is where the flakes are, and
 * testing.md §1 keeps them apart on purpose.
 *
 * The case counts are written out rather than routed through
 * `src/core/__tests__/property-runs.ts`. That helper exists to cap properties
 * under Stryker, and Stryker's Vitest configuration includes only
 * `src/core/__tests__/**` (ADR-0008), so nothing here ever runs under it and
 * the cap would be a no-op with a misleading name attached. The fixed seed from
 * `fast-check-setup.ts` does apply — it is a global `setupFiles` entry.
 *
 * Properties that do not care what the text says use addresses `core` rejects
 * immediately, because a page costs ~5 ms on `ubuntu-latest` and a 1000-case
 * property that generated real pages would take five seconds to prove something
 * about request ids.
 */

/** The first address in the library: room 0, wall 0, shelf 0, volume 0, page 0. */
const FIRST_ADDRESS: Address = { room: 0n, wall: 0, shelf: 0, volume: 0, page: 0 };
const FIRST_BOOK: BookAddress = { room: 0n, wall: 0, shelf: 0, volume: 0 };

/**
 * An address `core` refuses before it reaches the Feistel network, so a test
 * that only cares about ids and ordering costs microseconds instead of 5 ms.
 */
const REJECTED_ADDRESS: Address = { room: -1n, wall: 0, shelf: 0, volume: 0, page: 0 };
const REJECTED_BOOK: BookAddress = { room: -1n, wall: 0, shelf: 0, volume: 0 };

/**
 * The seed for every case that does not care which bytes it is given. Only a
 * `search` reads the source at all.
 */
const ANY_SEED = 1;

/** A fresh pinned source, so no two cases share the bytes one of them drew. */
function anySource(): RandomSource {
  return pinnedRandomSource(ANY_SEED);
}

/** Every kind the response union admits, so a test can assert totality. */
const RESPONSE_KINDS: Record<ResponseKind, true> = {
  page: true,
  title: true,
  located: true,
  found: true,
  'cancel-ack': true,
  dropped: true,
  stale: true,
  failed: true,
  'protocol-error': true,
};

/** The response kinds that mean `core` was actually called for this id. */
const RESULT_KINDS: readonly ResponseKind[] = [
  'page',
  'title',
  'located',
  'found',
  'failed',
];

function isResponseKind(response: ProtocolResponse): boolean {
  return Object.hasOwn(RESPONSE_KINDS, response.kind);
}

/** Fold the handler over a sequence of payloads, collecting what it answered. */
function run(payloads: readonly unknown[]): {
  responses: ProtocolResponse[];
  states: ProtocolHandlerState[];
} {
  let state = createProtocolHandlerState();
  const responses: ProtocolResponse[] = [];
  const states: ProtocolHandlerState[] = [state];
  for (const payload of payloads) {
    const outcome = handleProtocolMessage(payload, state, anySource());
    responses.push(outcome.response);
    state = outcome.state;
    states.push(state);
  }
  return { responses, states };
}

/** The single response to a single payload handled from a fresh state. */
function answer(payload: unknown): ProtocolResponse {
  return handleProtocolMessage(payload, createProtocolHandlerState(), anySource())
    .response;
}

describe('a well-formed request', () => {
  it('answers a page request with the text core generates for that address', () => {
    const response = answer({ kind: 'page', id: 1, address: FIRST_ADDRESS });

    expect(response).toEqual({
      kind: 'page',
      id: 1,
      text: getPage(FIRST_ADDRESS),
    });
  });

  it('answers a page request with exactly one page of characters', () => {
    const response = answer({ kind: 'page', id: 1, address: FIRST_ADDRESS });

    expect(response.kind).toBe('page');
    expect(response.kind === 'page' && Array.from(response.text).length).toBe(
      PAGE_LENGTH
    );
  });

  it('answers a title request with the title core generates for that volume', () => {
    const response = answer({ kind: 'title', id: 4, book: FIRST_BOOK });

    expect(response).toEqual({
      kind: 'title',
      id: 4,
      title: getTitle(FIRST_BOOK),
    });
    expect(response.kind === 'title' && Array.from(response.title).length).toBe(
      TITLE_LENGTH
    );
  });

  it('answers a locate request with the address of the page it was given', () => {
    const page = getPage(FIRST_ADDRESS);

    const response = answer({ kind: 'locate', id: 7, page });

    expect(response).toEqual({ kind: 'located', id: 7, address: FIRST_ADDRESS });
  });

  it('carries a room number as a bigint rather than widening it to a number', () => {
    const page = ' '.repeat(PAGE_LENGTH);
    const expected = locate(page);

    const response = answer({ kind: 'locate', id: 2, page });

    expect(response.kind).toBe('located');
    expect(response.kind === 'located' && typeof response.address.room).toBe('bigint');
    expect(response.kind === 'located' && response.address.room).toBe(expected.room);
  });

  it('accepts the smallest id a client may issue', () => {
    const response = answer({
      kind: 'title',
      id: FIRST_REQUEST_ID,
      book: REJECTED_BOOK,
    });

    expect(response.id).toBe(FIRST_REQUEST_ID);
    expect(response.kind).toBe('failed');
  });

  it('ignores an unknown extra property, so an added field is not a breaking change', () => {
    const response = answer({
      kind: 'title',
      id: 3,
      book: FIRST_BOOK,
      priority: 'high',
    });

    expect(response).toEqual({ kind: 'title', id: 3, title: getTitle(FIRST_BOOK) });
  });
});

describe('a request core refuses', () => {
  it('reports an address past the last room as a failed response', () => {
    const response = answer({
      kind: 'page',
      id: 1,
      address: { ...FIRST_ADDRESS, room: ROOM_COUNT },
    });

    expect(response.kind).toBe('failed');
    expect(response.kind === 'failed' && response.error.name).toBe(
      'InvalidAddressError'
    );
    expect(response.kind === 'failed' && response.error.message).toContain('room');
  });

  it('reports an address in the unfilled tail of the last room as a failed response', () => {
    const beyondTheEnd = fromLinear(LIBRARY_SIZE);

    const response = answer({ kind: 'page', id: 1, address: beyondTheEnd });

    expect(response.kind).toBe('failed');
    expect(response.kind === 'failed' && response.error.name).toBe(
      'AddressBeyondLibraryError'
    );
  });

  it('reports a page of the wrong length as a failed response', () => {
    const response = answer({ kind: 'locate', id: 1, page: 'не страница' });

    expect(response.kind).toBe('failed');
    expect(response.kind === 'failed' && response.error.name).toBe(
      'InvalidPageLengthError'
    );
  });

  it('reports a page holding a symbol outside the alphabet as a failed response', () => {
    const response = answer({
      kind: 'locate',
      id: 1,
      page: 'x'.repeat(PAGE_LENGTH),
    });

    expect(response.kind).toBe('failed');
    expect(response.kind === 'failed' && response.error.name).toBe(
      'UnknownSymbolError'
    );
  });

  it('answers the id of the request that failed, so its promise can settle', () => {
    const response = answer({ kind: 'title', id: 123, book: REJECTED_BOOK });

    expect(response.id).toBe(123);
  });

  it('still advances the watermark, because the id has had its one answer', () => {
    const outcome = handleProtocolMessage(
      { kind: 'page', id: 9, address: REJECTED_ADDRESS },
      createProtocolHandlerState(),
      anySource()
    );

    expect(outcome.state.highestIdSeen).toBe(9);
  });
});

describe('a payload that is not an object', () => {
  const notObjects: readonly [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'page'],
    ['a boolean', true],
    ['a bigint', 1n],
    ['a symbol', Symbol('page')],
    ['a function', (): void => undefined],
  ];

  for (const [description, payload] of notObjects) {
    it(`refuses ${description} as not an object`, () => {
      const response = answer(payload);

      expect(response.kind).toBe('protocol-error');
      expect(response.kind === 'protocol-error' && response.fault).toBe(
        'not-an-object'
      );
      expect(response.id).toBeNull();
    });
  }

  it('refuses an array, which is an object by typeof but never a message', () => {
    const response = answer([{ kind: 'page', id: 1, address: FIRST_ADDRESS }]);

    expect(response.kind).toBe('protocol-error');
    expect(response.kind === 'protocol-error' && response.fault).toBe('array-payload');
    expect(response.id).toBeNull();
  });
});

describe('a payload whose kind is not usable', () => {
  it('refuses a payload with no kind at all', () => {
    const response = answer({ id: 1, address: FIRST_ADDRESS });

    expect(response.kind === 'protocol-error' && response.fault).toBe('missing-kind');
  });

  it('refuses a kind that is not a string', () => {
    const response = answer({ kind: 7, id: 1 });

    expect(response.kind === 'protocol-error' && response.fault).toBe('missing-kind');
    expect(response.kind === 'protocol-error' && response.detail).toContain('number');
  });

  it('refuses a kind of null', () => {
    const response = answer({ kind: null, id: 1 });

    expect(response.kind === 'protocol-error' && response.fault).toBe('missing-kind');
    expect(response.kind === 'protocol-error' && response.detail).toContain('null');
  });

  it('refuses a string kind this protocol does not define', () => {
    // A shelf is a unit the client fans out, never a message (`protocol.ts`).
    const response = answer({ kind: 'shelf', id: 1, shelf: 0 });

    expect(response.kind === 'protocol-error' && response.fault).toBe('unknown-kind');
  });

  it('refuses a kind inherited from Object.prototype rather than owned', () => {
    // `'constructor' in KNOWN_KINDS` is true through the prototype chain, so a
    // truthiness read or an `in` check would have dispatched on it.
    const response = answer({ kind: 'constructor', id: 1 });

    expect(response.kind === 'protocol-error' && response.fault).toBe('unknown-kind');
  });

  it('names the id of an unknown kind, so the client can settle that promise', () => {
    const response = answer({ kind: 'shelf', id: 55 });

    expect(response.id).toBe(55);
  });
});

describe('a payload whose id is not usable', () => {
  const badIds: readonly [string, unknown][] = [
    ['absent', undefined],
    ['a string', '1'],
    ['a bigint', 1n],
    ['a fraction', 1.5],
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['past the safe integer range', Number.MAX_SAFE_INTEGER + 2],
  ];

  for (const [description, id] of badIds) {
    it(`refuses an id that is ${description}`, () => {
      const response = answer({ kind: 'page', id, address: FIRST_ADDRESS });

      expect(response.kind).toBe('protocol-error');
      expect(response.kind === 'protocol-error' && response.fault).toBe('invalid-id');
      expect(response.id).toBeNull();
    });
  }

  it('refuses an unusable id on a cancel as well as on a request', () => {
    const response = answer({ kind: 'cancel', id: 0 });

    expect(response.kind === 'protocol-error' && response.fault).toBe('invalid-id');
  });
});

describe('a request whose address is misshapen', () => {
  it('refuses a page request carrying no address', () => {
    const response = answer({ kind: 'page', id: 1 });

    expect(response.kind === 'protocol-error' && response.fault).toBe(
      'malformed-address'
    );
    expect(response.kind === 'protocol-error' && response.detail).toContain(
      "'address'"
    );
  });

  it('refuses an address that is an array', () => {
    const response = answer({ kind: 'page', id: 1, address: [0, 0, 0, 0, 0] });

    expect(response.kind === 'protocol-error' && response.fault).toBe(
      'malformed-address'
    );
  });

  it('refuses a room that is a number rather than a bigint', () => {
    const response = answer({
      kind: 'page',
      id: 1,
      address: { ...FIRST_ADDRESS, room: 0 },
    });

    expect(response.kind === 'protocol-error' && response.fault).toBe(
      'malformed-address'
    );
    expect(response.kind === 'protocol-error' && response.detail).toContain(
      "'address.room'"
    );
  });

  const misshapenComponents: readonly [string, Record<string, unknown>, string][] = [
    ['a wall that is a string', { wall: '0' }, "'address.wall'"],
    ['a missing shelf', { shelf: undefined }, "'address.shelf'"],
    ['a volume that is a fraction', { volume: 1.5 }, "'address.volume'"],
    ['a missing page', { page: undefined }, "'address.page'"],
    ['a page that is a bigint', { page: 0n }, "'address.page'"],
  ];

  for (const [description, override, field] of misshapenComponents) {
    it(`refuses ${description}`, () => {
      const response = answer({
        kind: 'page',
        id: 1,
        address: { ...FIRST_ADDRESS, ...override },
      });

      expect(response.kind === 'protocol-error' && response.fault).toBe(
        'malformed-address'
      );
      expect(response.kind === 'protocol-error' && response.detail).toContain(field);
    });
  }

  it('refuses a title request carrying no book', () => {
    const response = answer({ kind: 'title', id: 1 });

    expect(response.kind === 'protocol-error' && response.fault).toBe(
      'malformed-address'
    );
    expect(response.kind === 'protocol-error' && response.detail).toContain("'book'");
  });

  it('refuses a book whose volume is misshapen', () => {
    const response = answer({
      kind: 'title',
      id: 1,
      book: { ...FIRST_BOOK, volume: null },
    });

    expect(response.kind === 'protocol-error' && response.fault).toBe(
      'malformed-address'
    );
    expect(response.kind === 'protocol-error' && response.detail).toContain(
      "'book.volume'"
    );
  });

  it('refuses a title request that names a page, which a title has no room for', () => {
    // A client that spread a full `Address` into a title request has the wrong
    // model of what a title is. `getTitle` would have ignored the page
    // silently, which is the outcome architecture.md §4 rules out.
    const response = answer({ kind: 'title', id: 1, book: FIRST_ADDRESS });

    expect(response.kind === 'protocol-error' && response.fault).toBe(
      'unexpected-field'
    );
    expect(response.kind === 'protocol-error' && response.detail).toContain(
      "'book.page'"
    );
  });

  it('leaves the range of an address component to core, not to the protocol', () => {
    // Shape is the protocol's business; bounds are the domain's. A wall of 99
    // is a well-formed message about a page that does not exist, so it comes
    // back as a domain failure naming the component, not as a protocol error.
    const response = answer({
      kind: 'page',
      id: 1,
      address: { ...FIRST_ADDRESS, wall: 99 },
    });

    expect(response.kind).toBe('failed');
    expect(response.kind === 'failed' && response.error.name).toBe(
      'InvalidAddressError'
    );
    expect(response.kind === 'failed' && response.error.message).toContain('wall');
  });
});

describe('a locate request whose page is misshapen', () => {
  it('refuses a locate request carrying no page', () => {
    const response = answer({ kind: 'locate', id: 1 });

    expect(response.kind === 'protocol-error' && response.fault).toBe('malformed-page');
  });

  it('refuses a page that is not a string', () => {
    const response = answer({ kind: 'locate', id: 1, page: 3200 });

    expect(response.kind === 'protocol-error' && response.fault).toBe('malformed-page');
    expect(response.kind === 'protocol-error' && response.detail).toContain('number');
  });

  it('leaves the length of a page to core, not to the protocol', () => {
    const response = answer({ kind: 'locate', id: 1, page: '' });

    expect(response.kind).toBe('failed');
    expect(response.kind === 'failed' && response.error.name).toBe(
      'InvalidPageLengthError'
    );
  });
});

describe('a search request', () => {
  /**
   * Checked, for every length in `QUERY_LENGTHS`, both to terminate and to give
   * a random hit that differs from the spaces hit. Seed 2 is left out on
   * purpose: at 3199 code points its one-character random pad is a space, the
   * case that turns up for about one seed in 36, and the two hits coincide.
   */
  const PINNED_SEEDS = [1, 3, 4] as const;

  /**
   * Every length is shorter than a page: at `PAGE_LENGTH` there is no padding
   * and the two modes give the same page, so a handler that dropped the mode
   * would pass. `PAGE_LENGTH - 1` is the shortest pad there is.
   */
  const QUERY_LENGTHS = [7, PAGE_LENGTH / 2, PAGE_LENGTH - 1] as const;

  const PAD_MODES: readonly PadMode[] = ['spaces', 'random'];

  const PHRASE = 'в библиотеке вавилона, ';

  function queryOfLength(length: number): string {
    return PHRASE.repeat(Math.ceil(length / PHRASE.length)).slice(0, length);
  }

  function searchAnswer(query: string, mode: PadMode, seed: number): ProtocolResponse {
    return handleProtocolMessage(
      { kind: 'search', id: 1, query, mode },
      createProtocolHandlerState(),
      pinnedRandomSource(seed)
    ).response;
  }

  const everyCase = PINNED_SEEDS.flatMap((seed) =>
    QUERY_LENGTHS.flatMap((length) =>
      PAD_MODES.map((mode) => [seed, length, mode] as const)
    )
  );

  it.each(everyCase)(
    'a search message answers found with exactly the hit core computes for the same bytes: seed %i, %i code points, %s',
    (seed, length, mode) => {
      const query = queryOfLength(length);
      const expected = search(query, mode, undefined, pinnedRandomSource(seed));

      const response = searchAnswer(query, mode, seed);

      expect(response).toEqual({
        kind: 'found',
        id: 1,
        address: expected.address,
        offset: expected.offset,
      });
    }
  );

  const seedsAndLengths = PINNED_SEEDS.flatMap((seed) =>
    QUERY_LENGTHS.map((length) => [seed, length] as const)
  );

  it.each(seedsAndLengths)(
    'a random hit differs from the spaces hit for the same bytes: seed %i, %i code points',
    (seed, length) => {
      const query = queryOfLength(length);

      const spaces = searchAnswer(query, 'spaces', seed);
      const random = searchAnswer(query, 'random', seed);

      expect(spaces.kind).toBe('found');
      expect(random.kind).toBe('found');
      expect(random).not.toEqual(spaces);
    }
  );

  it('a pinned source past its byte cap throws PinnedSourceExhaustedError rather than spinning', () => {
    const source = pinnedRandomSource(ANY_SEED);
    source(PINNED_SOURCE_BYTE_CAP);

    expect(() => source(1)).toThrow(PinnedSourceExhaustedError);
  });

  it('answers a search whose source runs dry as failed, naming it, rather than hanging', () => {
    const source = pinnedRandomSource(ANY_SEED);
    source(PINNED_SOURCE_BYTE_CAP);

    const response = handleProtocolMessage(
      { kind: 'search', id: 1, query: 'вавилон', mode: 'random' },
      createProtocolHandlerState(),
      source
    ).response;

    expect(response.kind === 'failed' && response.error.name).toBe(
      'PinnedSourceExhaustedError'
    );
  });

  it.each([
    ['a mode that names no pad mode', { query: 'вавилон', mode: 'sideways' }, "'mode'"],
    [
      'a mode inherited from Object.prototype',
      { query: 'вавилон', mode: 'constructor' },
      "'mode'",
    ],
    ['no mode', { query: 'вавилон' }, "'mode'"],
    ['a mode that is not a string', { query: 'вавилон', mode: 1 }, "'mode'"],
    ['a query that is not a string', { query: 7, mode: 'random' }, "'query'"],
    ['no query', { mode: 'random' }, "'query'"],
  ])(
    'a search with an unknown mode or a non-string query is a malformed-search protocol error: %s',
    (_description, body, field) => {
      const response = answer({ kind: 'search', id: 3, ...body });

      expect(response.kind === 'protocol-error' && response.fault).toBe(
        'malformed-search'
      );
      expect(response.id).toBe(3);
      expect(response.kind === 'protocol-error' && response.detail).toContain(field);
      expect(response.kind === 'protocol-error' && response.detail).not.toContain(
        'sideways'
      );
    }
  );

  it.each([
    ['a number', 0],
    ['undefined', undefined],
  ])(
    'a search carrying an offset is refused as an unexpected field: an offset of %s',
    (_description, offset) => {
      const response = answer({
        kind: 'search',
        id: 4,
        query: 'вавилон',
        mode: 'spaces',
        offset,
      });

      expect(response.kind === 'protocol-error' && response.fault).toBe(
        'unexpected-field'
      );
      expect(response.kind === 'protocol-error' && response.detail).toContain(
        "'offset'"
      );
    }
  );

  it('a search carrying an unknown field is answered normally', () => {
    const query = 'вавилон';

    const response = handleProtocolMessage(
      { kind: 'search', id: 1, query, mode: 'random', priority: 'high' },
      createProtocolHandlerState(),
      pinnedRandomSource(ANY_SEED)
    ).response;

    expect(response).toEqual(searchAnswer(query, 'random', ANY_SEED));
    expect(response.kind).toBe('found');
  });

  it.each([
    ['an empty query', '', 'InvalidSearchQueryError'],
    [
      'a query longer than a page',
      'а'.repeat(PAGE_LENGTH + 1),
      'InvalidSearchQueryError',
    ],
    ['a symbol outside the alphabet', 'babel', 'UnknownSymbolError'],
  ])(
    "a query core refuses is answered as failed with the error's name: %s",
    (_description, query, name) => {
      const response = answer({ kind: 'search', id: 6, query, mode: 'random' });

      expect(response.kind).toBe('failed');
      expect(response.id).toBe(6);
      expect(response.kind === 'failed' && response.error.name).toBe(name);
    }
  );

  it('a search cancelled before it arrives is dropped and carries the request', () => {
    const request = { kind: 'search', id: 5, query: 'вавилон', mode: 'random' };

    const { responses } = run([{ kind: 'cancel', id: 5 }, request]);

    expect(responses[1]).toEqual({ kind: 'dropped', id: 5, request });
  });
});

describe('a protocol error', () => {
  it('names the id when the id is sound but the body is not', () => {
    const response = answer({ kind: 'page', id: 31, address: { room: 0 } });

    expect(response.kind).toBe('protocol-error');
    expect(response.id).toBe(31);
  });

  it('reports no id when the id itself could not be narrowed', () => {
    const response = answer({ kind: 'page', id: 'thirty-one', address: FIRST_ADDRESS });

    expect(response.id).toBeNull();
  });

  it('does not touch the handler state, since nothing was answered for an id', () => {
    const before = createProtocolHandlerState();

    const outcome = handleProtocolMessage({ kind: 'nonsense' }, before, anySource());

    expect(outcome.state).toBe(before);
  });

  it('does not echo the offending value back to the client', () => {
    const secret = 'цитата из книги';

    const response = answer({ kind: 'locate', id: 1, page: { text: secret } });

    expect(response.kind === 'protocol-error' && response.detail).not.toContain(secret);
  });
});

describe('a cancel that arrives before the request it names', () => {
  it('acknowledges it as pre-emptive', () => {
    const { responses } = run([{ kind: 'cancel', id: 5 }]);

    expect(responses[0]).toEqual({
      kind: 'cancel-ack',
      id: 5,
      disposition: 'pre-emptive',
    });
  });

  it('does not advance the watermark, because nothing has been answered', () => {
    const { states } = run([{ kind: 'cancel', id: 5 }]);

    expect(states[1]?.highestIdSeen).toBe(0);
    expect(states[1]?.cancelledIds.has(5)).toBe(true);
  });

  it('drops the request when it arrives, without calling core', () => {
    const request = { kind: 'page', id: 5, address: FIRST_ADDRESS };

    const { responses } = run([{ kind: 'cancel', id: 5 }, request]);

    expect(responses[1]).toEqual({ kind: 'dropped', id: 5, request });
  });

  it('drops a locate the same way it drops a page', () => {
    const request = { kind: 'locate', id: 5, page: ' '.repeat(PAGE_LENGTH) };

    const { responses } = run([{ kind: 'cancel', id: 5 }, request]);

    expect(responses[1]?.kind).toBe('dropped');
  });

  it('carries the dropped request, so the rejection can name its address', () => {
    // ADR-0016: the client's error carries the request id and the address. The
    // handler hands both back rather than making the client keep the request it
    // has already given up on.
    const { responses } = run([
      { kind: 'cancel', id: 5 },
      { kind: 'page', id: 5, address: FIRST_ADDRESS },
    ]);

    const dropped = responses[1];
    expect(dropped?.kind === 'dropped' && dropped.request).toEqual({
      kind: 'page',
      id: 5,
      address: FIRST_ADDRESS,
    });
  });

  it('acknowledges a second cancel for the same id as already cancelled', () => {
    const { responses, states } = run([
      { kind: 'cancel', id: 5 },
      { kind: 'cancel', id: 5 },
    ]);

    expect(responses[1]).toEqual({
      kind: 'cancel-ack',
      id: 5,
      disposition: 'already-cancelled',
    });
    expect(states[2]).toBe(states[1]);
  });

  it('cancels only the id it names', () => {
    const { responses } = run([
      { kind: 'cancel', id: 5 },
      { kind: 'title', id: 3, book: REJECTED_BOOK },
    ]);

    expect(responses[1]?.kind).toBe('failed');
  });

  it('forgets a cancelled id once a later request has passed it', () => {
    // Pre-emptive cancel of 5, then request 7 is answered. Request 5 can no
    // longer be dropped — the watermark is past it — so it is stale, and the
    // cancelled set is empty rather than growing for the rest of the session.
    const { responses, states } = run([
      { kind: 'cancel', id: 5 },
      { kind: 'title', id: 7, book: REJECTED_BOOK },
      { kind: 'page', id: 5, address: FIRST_ADDRESS },
    ]);

    expect(states[2]?.cancelledIds.size).toBe(0);
    expect(responses[2]).toEqual({ kind: 'stale', id: 5, highestIdSeen: 7 });
  });

  it('forgets a dropped id, so its request is not dropped twice', () => {
    const { responses, states } = run([
      { kind: 'cancel', id: 5 },
      { kind: 'page', id: 5, address: FIRST_ADDRESS },
      { kind: 'page', id: 5, address: FIRST_ADDRESS },
    ]);

    expect(states[2]?.cancelledIds.size).toBe(0);
    expect(responses[2]).toEqual({ kind: 'stale', id: 5, highestIdSeen: 5 });
  });
});

describe('a cancel that races the reply it tried to prevent', () => {
  it('acknowledges it as reply-in-flight once the id has been answered', () => {
    // The hazard ADR-0016 names: by the time a cancel is posted, the reply is
    // usually already computed and on its way. The handler cannot unsend it,
    // so it says so, and the client rejects its promise and ignores the result
    // when it lands rather than caching it.
    const { responses } = run([
      { kind: 'title', id: 8, book: FIRST_BOOK },
      { kind: 'cancel', id: 8 },
    ]);

    expect(responses[0]?.kind).toBe('title');
    expect(responses[1]).toEqual({
      kind: 'cancel-ack',
      id: 8,
      disposition: 'reply-in-flight',
    });
  });

  it('acknowledges it as reply-in-flight when the answer was a failure', () => {
    const { responses } = run([
      { kind: 'title', id: 8, book: REJECTED_BOOK },
      { kind: 'cancel', id: 8 },
    ]);

    expect(responses[0]?.kind).toBe('failed');
    expect(responses[1]?.kind === 'cancel-ack' && responses[1].disposition).toBe(
      'reply-in-flight'
    );
  });

  it('acknowledges a cancel for an id below the watermark the same way', () => {
    const { responses } = run([
      { kind: 'title', id: 8, book: REJECTED_BOOK },
      { kind: 'cancel', id: 2 },
    ]);

    expect(responses[1]?.kind === 'cancel-ack' && responses[1].disposition).toBe(
      'reply-in-flight'
    );
  });

  it('leaves the state untouched, because the id has nothing left to cancel', () => {
    const { states } = run([
      { kind: 'title', id: 8, book: REJECTED_BOOK },
      { kind: 'cancel', id: 8 },
    ]);

    expect(states[2]).toBe(states[1]);
  });
});

describe('a request that arrives out of order', () => {
  it('refuses a request replayed after it was answered', () => {
    const { responses } = run([
      { kind: 'title', id: 4, book: REJECTED_BOOK },
      { kind: 'title', id: 4, book: REJECTED_BOOK },
    ]);

    expect(responses[1]).toEqual({ kind: 'stale', id: 4, highestIdSeen: 4 });
  });

  it('refuses a request whose id is below the highest one seen', () => {
    const { responses } = run([
      { kind: 'title', id: 9, book: REJECTED_BOOK },
      { kind: 'page', id: 2, address: FIRST_ADDRESS },
    ]);

    expect(responses[1]).toEqual({ kind: 'stale', id: 2, highestIdSeen: 9 });
  });

  it('reports the watermark, so the client can see how far behind it was', () => {
    const { responses } = run([
      { kind: 'title', id: 9, book: REJECTED_BOOK },
      { kind: 'title', id: 20, book: REJECTED_BOOK },
      { kind: 'title', id: 9, book: REJECTED_BOOK },
    ]);

    expect(responses[2]?.kind === 'stale' && responses[2].highestIdSeen).toBe(20);
  });

  it('does not call core for a stale request', () => {
    const { responses } = run([
      { kind: 'title', id: 9, book: REJECTED_BOOK },
      { kind: 'page', id: 9, address: FIRST_ADDRESS },
    ]);

    expect(responses[1]?.kind).toBe('stale');
  });

  it('leaves the state untouched for a stale request', () => {
    const { states } = run([
      { kind: 'title', id: 9, book: REJECTED_BOOK },
      { kind: 'title', id: 9, book: REJECTED_BOOK },
    ]);

    expect(states[2]).toBe(states[1]);
  });

  it('honours a cancel that overtook its request even above the watermark', () => {
    // A cancel channel that overtakes the request queue is the only way a
    // cancel can be useful: posted down one channel it would queue behind the
    // ~122 ms of titles it is trying to prevent. So the cancelled set is
    // consulted before the watermark, and a gap in the ids changes nothing.
    const { responses } = run([
      { kind: 'title', id: 10, book: REJECTED_BOOK },
      { kind: 'cancel', id: 31 },
      { kind: 'page', id: 31, address: FIRST_ADDRESS },
    ]);

    expect(responses[2]?.kind).toBe('dropped');
  });
});

describe('the handler as a pure function', () => {
  it('does not mutate the state it was given', () => {
    const state = createProtocolHandlerState();

    handleProtocolMessage({ kind: 'cancel', id: 5 }, state, anySource());
    handleProtocolMessage(
      { kind: 'title', id: 9, book: REJECTED_BOOK },
      state,
      anySource()
    );

    expect(state.highestIdSeen).toBe(0);
    expect(state.cancelledIds.size).toBe(0);
  });

  it('does not mutate the payload it was given', () => {
    const payload = { kind: 'page', id: 1, address: { ...FIRST_ADDRESS } };
    const snapshot = structuredClone(payload);

    handleProtocolMessage(payload, createProtocolHandlerState(), anySource());

    expect(payload).toEqual(snapshot);
  });

  it('answers the same payload and state identically every time', () => {
    const state = createProtocolHandlerState();
    const payload = { kind: 'title', id: 2, book: FIRST_BOOK };

    const first = handleProtocolMessage(payload, state, anySource());
    const second = handleProtocolMessage(payload, state, anySource());

    expect(second.response).toEqual(first.response);
    expect(second.state).toEqual(first.state);
  });

  it('copies the request out of the payload rather than aliasing it', () => {
    // A response holding a reference into an untrusted payload would let the
    // sender mutate what the client reads after the fact. Narrowing builds
    // fresh objects, so there is nothing shared to mutate.
    const address = { ...FIRST_ADDRESS };
    const payload = { kind: 'page', id: 1, address };

    const dropped = run([{ kind: 'cancel', id: 1 }, payload]).responses[1];

    expect(dropped?.kind).toBe('dropped');
    expect(dropped?.kind === 'dropped' && dropped.request).not.toBe(payload);
    expect(
      dropped?.kind === 'dropped' &&
        dropped.request.kind === 'page' &&
        dropped.request.address
    ).not.toBe(address);
    expect(dropped?.kind === 'dropped' && dropped.request).toEqual({
      kind: 'page',
      id: 1,
      address: FIRST_ADDRESS,
    });
  });
});

describe('the handler over generated input', () => {
  /** Any request kind against an address core rejects without computing. */
  const cheapRequest = (id: number): fc.Arbitrary<unknown> =>
    fc.constantFrom(
      { kind: 'page', id, address: REJECTED_ADDRESS },
      { kind: 'title', id, book: REJECTED_BOOK },
      { kind: 'locate', id, page: '' }
    );

  /** Requests and cancels in arbitrary order over a small pool of ids. */
  const messageSequence: fc.Arbitrary<unknown[]> = fc.array(
    fc
      .record({ id: fc.integer({ min: 1, max: 12 }), cancel: fc.boolean() })
      .chain(({ id, cancel }) =>
        cancel ? fc.constant<unknown>({ kind: 'cancel', id }) : cheapRequest(id)
      ),
    { minLength: 0, maxLength: 24 }
  );

  const arbitraryState: fc.Arbitrary<ProtocolHandlerState> = fc
    .record({
      highestIdSeen: fc.integer({ min: 0, max: 40 }),
      cancelled: fc.uniqueArray(fc.integer({ min: 41, max: 80 }), { maxLength: 6 }),
    })
    .map(({ highestIdSeen, cancelled }) => ({
      highestIdSeen,
      cancelledIds: new Set(cancelled),
    }));

  it('answers every payload with one response of a kind the protocol defines', () => {
    fc.assert(
      fc.property(fc.anything(), arbitraryState, (payload, state) => {
        const outcome = handleProtocolMessage(payload, state, anySource());
        return isResponseKind(outcome.response);
      }),
      { numRuns: 1000 }
    );
  });

  it('never throws, whatever the payload turns out to be', () => {
    fc.assert(
      fc.property(fc.anything(), arbitraryState, (payload, state) => {
        expect(() => handleProtocolMessage(payload, state, anySource())).not.toThrow();
      }),
      { numRuns: 1000 }
    );
  });

  it('leaves the state it was given unchanged', () => {
    fc.assert(
      fc.property(fc.anything(), arbitraryState, (payload, state) => {
        const watermark = state.highestIdSeen;
        const cancelled = [...state.cancelledIds];

        handleProtocolMessage(payload, state, anySource());

        return (
          state.highestIdSeen === watermark &&
          [...state.cancelledIds].join() === cancelled.join()
        );
      }),
      { numRuns: 1000 }
    );
  });

  it('names the id of every message that carries a usable one', () => {
    // Whichever branch a message lands in — a result, a failure, a drop, a
    // stale notice or a cancel acknowledgement — the response answers the id
    // that was asked. A response that named a different id, or none, would
    // leave a promise pending.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 80 }),
        fc.boolean(),
        arbitraryState,
        (id, cancel, state) => {
          const payload = cancel
            ? { kind: 'cancel', id }
            : { kind: 'title', id, book: REJECTED_BOOK };

          return handleProtocolMessage(payload, state, anySource()).response.id === id;
        }
      ),
      { numRuns: 1000 }
    );
  });

  it('never walks the watermark backwards', () => {
    fc.assert(
      fc.property(messageSequence, (payloads) => {
        const { states } = run(payloads);

        return states.every((state, index) => {
          const previous = states[index - 1];
          return (
            previous === undefined || state.highestIdSeen >= previous.highestIdSeen
          );
        });
      }),
      { numRuns: 1000 }
    );
  });

  it('keeps every cancelled id above the watermark', () => {
    fc.assert(
      fc.property(messageSequence, (payloads) => {
        const { states } = run(payloads);
        return states.every((state) =>
          [...state.cancelledIds].every((id) => id > state.highestIdSeen)
        );
      }),
      { numRuns: 1000 }
    );
  });

  it('never answers a pre-emptively cancelled id with a result from core', () => {
    fc.assert(
      fc.property(messageSequence, (payloads) => {
        const { responses } = run(payloads);
        const cancelled = new Set<number>();
        for (const response of responses) {
          if (
            response.kind === 'cancel-ack' &&
            response.disposition === 'pre-emptive'
          ) {
            cancelled.add(response.id);
            continue;
          }
          // A `protocol-error` is the only response that may carry no id, and
          // it is never a result, so the null check costs nothing here.
          if (
            response.id !== null &&
            RESULT_KINDS.includes(response.kind) &&
            cancelled.has(response.id)
          ) {
            return false;
          }
        }
        return true;
      }),
      { numRuns: 1000 }
    );
  });

  it('answers every request of a strictly increasing id with a result from core', () => {
    // The converse of the cancellation property: with no cancels in the trace
    // and ids that only ever rise, nothing is dropped and nothing is stale, so
    // every single request reaches `core`. A handler that refused one of these
    // would be dropping work the client is still waiting for.
    const increasingIds = fc
      .uniqueArray(fc.integer({ min: 1, max: 200 }), { minLength: 1, maxLength: 12 })
      .map((ids) => [...ids].sort((left, right) => left - right));

    fc.assert(
      fc.property(increasingIds, (ids) => {
        const payloads = ids.map((id) => ({ kind: 'title', id, book: REJECTED_BOOK }));

        const { responses } = run(payloads);

        return (
          responses.length === ids.length &&
          responses.every(
            (response, index) =>
              response.kind === 'failed' && response.id === ids[index]
          )
        );
      }),
      { numRuns: 1000 }
    );
  });
});
