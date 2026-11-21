import { describe, it, expect } from 'vitest';
import {
  BOOKS_PER_SHELF,
  LIBRARY_SIZE,
  PAGE_LENGTH,
  ROOM_COUNT,
  TITLE_LENGTH,
  fromLinear,
  getPage,
  getTitle,
  locate,
} from '@core/index';
import type { Address, BookAddress } from '@core/index';
import { GenerationCache } from '../cache';
import { GenerationClient, WARM_UP_ADDRESS } from '../client';
import type { GenerationRequest, GenerationWorkerLike, ShelfAddress } from '../client';
import {
  CancelledRequestError,
  GenerationFailedError,
  MalformedResponseError,
  ProtocolViolationError,
  StaleRequestError,
  WorkerFailureError,
} from '../errors';
import { createWorkerLoop, yieldToMacrotask } from '../loop';
import type { WorkerLoop } from '../loop';
import { FIRST_REQUEST_ID } from '../protocol';
import type { RequestId } from '../protocol';

/**
 * What belongs to the client, and only that.
 *
 * The protocol handler is already unit-tested as a pure function and the loop
 * that runs it has its own tests; neither is re-asserted here. What is the
 * client's own is the bookkeeping on this side of the boundary: the ids it
 * issues, the cache it reads before the boundary rather than behind it, the
 * fan-out it aggregates, and — the one that carries the milestone — what it
 * does with a reply that was already in flight when a cancel went out.
 *
 * **Cancellation is asserted by outcome and needs no timer** (ADR-0016): the
 * promise rejects with that type, the cache holds no entry for the address,
 * and the late reply changes nothing. Nothing below waits on a duration.
 *
 * Two fakes stand in for a `Worker`, because the tests want two different
 * things from one. `ScriptedWorker` lets a test post the replies itself, which
 * is the only way to deliver a late reply, a malformed message or a result of
 * the wrong kind at an exact moment. `LoopbackWorker` runs the real message
 * loop in process, so the requests the client sends are answered by the same
 * handler a thread would use. The thread itself is `worker.integration.test.ts`.
 */

const FIRST_ADDRESS: Address = { room: 0n, wall: 0, shelf: 0, volume: 0, page: 0 };
const SECOND_ADDRESS: Address = { room: 0n, wall: 0, shelf: 0, volume: 0, page: 1 };
const FIRST_BOOK: BookAddress = { room: 0n, wall: 0, shelf: 0, volume: 0 };
const FIRST_SHELF: ShelfAddress = { room: 0n, wall: 0, shelf: 0 };

/** An address `core` refuses, for the tests about a failure crossing back. */
const REJECTED_ADDRESS: Address = { room: -1n, wall: 0, shelf: 0, volume: 0, page: 0 };

/** The address warm-up is specified to use: the midpoint of the library. */
const WARM_UP_PAGE_COUNT = 1;

/** A worker whose replies the test writes. */
class ScriptedWorker implements GenerationWorkerLike {
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  /** Every payload the client posted, in order. */
  readonly sent: unknown[] = [];

  terminated = false;

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Deliver a message as though the worker had posted it. */
  reply(response: unknown): void {
    this.onmessage?.({ data: response });
  }

  /** Fire the worker's `error` event: the thread will answer nothing more. */
  breakDown(): void {
    this.onerror?.({ message: 'the worker script failed to load' });
  }
}

/**
 * A worker that is the real message loop, in process.
 *
 * Not a thread, and so not a substitute for the integration test: the one
 * infidelity that matters is that a response is delivered synchronously from
 * inside `postMessage` where a real `Worker` would post it back as a task.
 * Everything else — the queue, the slice, the handler state, the cancellation
 * race — is the production code.
 */
class LoopbackWorker implements GenerationWorkerLike {
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  terminated = false;

  private readonly loop: WorkerLoop;

  constructor() {
    this.loop = createWorkerLoop({
      post: (response): void => {
        this.onmessage?.({ data: response });
      },
      yieldToEventLoop: yieldToMacrotask,
    });
  }

  postMessage(message: unknown): void {
    this.loop.accept(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Resolves when the loop has answered everything the client has sent. */
  whenIdle(): Promise<void> {
    return this.loop.whenIdle();
  }
}

/** The one id a single-address call issued. */
function onlyId(request: GenerationRequest<unknown>): RequestId {
  const [id] = request.ids;
  if (id === undefined) {
    throw new Error('the request issued no id, so it was served from the cache');
  }
  return id;
}

/** Whatever a promise rejected with, as a value rather than a throw. */
function rejection(result: Promise<unknown>): Promise<unknown> {
  return result.then(
    () => {
      throw new Error('the request resolved where it was expected to reject');
    },
    (reason: unknown) => reason
  );
}

describe('request ids', () => {
  it('issues the first id the protocol allows', () => {
    const client = new GenerationClient(new ScriptedWorker());

    const request = client.page(FIRST_ADDRESS);

    expect(request.ids).toEqual([FIRST_REQUEST_ID]);
  });

  it('increases the id by one per request, across all three kinds', () => {
    const client = new GenerationClient(new ScriptedWorker());

    const ids = [
      ...client.page(FIRST_ADDRESS).ids,
      ...client.title(FIRST_BOOK).ids,
      ...client.locate('whatever').ids,
    ];

    expect(ids).toEqual([FIRST_REQUEST_ID, FIRST_REQUEST_ID + 1, FIRST_REQUEST_ID + 2]);
  });

  it('issues one id per address for a shelf rather than one for the batch', () => {
    const client = new GenerationClient(new ScriptedWorker());

    const shelf = client.shelfTitles(FIRST_SHELF);

    expect(shelf.ids).toHaveLength(BOOKS_PER_SHELF);
    expect(shelf.ids).toEqual(
      Array.from(
        { length: BOOKS_PER_SHELF },
        (_unused, index) => FIRST_REQUEST_ID + index
      )
    );
  });

  it('issues no id at all for a call the cache answers', () => {
    const cache = new GenerationCache();
    cache.setPage(FIRST_ADDRESS, getPage(FIRST_ADDRESS));
    const client = new GenerationClient(new ScriptedWorker(), cache);

    const request = client.page(FIRST_ADDRESS);

    expect(request.ids).toEqual([]);
  });
});

describe('the messages the client sends', () => {
  it('names one address per request, with its own id', () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);

    client.page(SECOND_ADDRESS);

    expect(worker.sent).toEqual([
      { kind: 'page', id: FIRST_REQUEST_ID, address: SECOND_ADDRESS },
    ]);
  });

  it('asks for a title by volume, with no page component for it to carry', () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);

    client.title(FIRST_BOOK);

    expect(worker.sent).toEqual([
      { kind: 'title', id: FIRST_REQUEST_ID, book: FIRST_BOOK },
    ]);
  });

  it('sends one message per volume of a shelf', () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);

    client.shelfTitles(FIRST_SHELF);

    expect(worker.sent).toHaveLength(BOOKS_PER_SHELF);
    expect(worker.sent).toContainEqual({
      kind: 'title',
      id: FIRST_REQUEST_ID + BOOKS_PER_SHELF - 1,
      book: { ...FIRST_SHELF, volume: BOOKS_PER_SHELF - 1 },
    });
  });
});

describe('reading through the cache', () => {
  it('serves a cached page without sending anything to the worker', async () => {
    const cache = new GenerationCache();
    const text = getPage(FIRST_ADDRESS);
    cache.setPage(FIRST_ADDRESS, text);
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker, cache);

    const request = client.page(FIRST_ADDRESS);

    await expect(request.result).resolves.toBe(text);
    expect(worker.sent).toEqual([]);
  });

  it('admits a generated page to the cache, so the next call is a hit', async () => {
    const cache = new GenerationCache();
    const worker = new LoopbackWorker();
    const client = new GenerationClient(worker, cache);

    await client.page(FIRST_ADDRESS).result;

    expect(cache.getPage(FIRST_ADDRESS)).toBe(getPage(FIRST_ADDRESS));
    expect(client.page(FIRST_ADDRESS).ids).toEqual([]);
  });

  it('admits a generated title to the cache under the volume it names', async () => {
    const cache = new GenerationCache();
    const client = new GenerationClient(new LoopbackWorker(), cache);

    await client.title(FIRST_BOOK).result;

    expect(cache.getTitle(FIRST_BOOK)).toBe(getTitle(FIRST_BOOK));
  });

  it('sends only the titles of a shelf it does not already hold', () => {
    const cache = new GenerationCache();
    cache.setTitle(
      { ...FIRST_SHELF, volume: 0 },
      getTitle({ ...FIRST_SHELF, volume: 0 })
    );
    cache.setTitle(
      { ...FIRST_SHELF, volume: 5 },
      getTitle({ ...FIRST_SHELF, volume: 5 })
    );
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker, cache);

    const shelf = client.shelfTitles(FIRST_SHELF);

    expect(shelf.ids).toHaveLength(BOOKS_PER_SHELF - 2);
    expect(worker.sent).toHaveLength(BOOKS_PER_SHELF - 2);
  });

  it('does not cache a located address, whose key would be the page itself', async () => {
    const worker = new LoopbackWorker();
    const client = new GenerationClient(worker);
    const page = getPage(SECOND_ADDRESS);

    await client.locate(page).result;
    const second = client.locate(page);

    expect(second.ids).toHaveLength(1);
    await expect(second.result).resolves.toEqual(locate(page));
  });
});

describe('results coming back', () => {
  it('resolves a page with the 3200 characters core generates for that address', async () => {
    const client = new GenerationClient(new LoopbackWorker());

    const text = await client.page(SECOND_ADDRESS).result;

    expect(text).toBe(getPage(SECOND_ADDRESS));
    expect(text).toHaveLength(PAGE_LENGTH);
  });

  it('resolves a title with the 25 characters core generates for that volume', async () => {
    const client = new GenerationClient(new LoopbackWorker());

    const title = await client.title(FIRST_BOOK).result;

    expect(title).toBe(getTitle(FIRST_BOOK));
    expect(title).toHaveLength(TITLE_LENGTH);
  });

  it('resolves a locate with the address, carrying the room as a bigint', async () => {
    const client = new GenerationClient(new LoopbackWorker());
    const address = fromLinear(LIBRARY_SIZE / 3n);
    const expected = { ...address };

    const located = await client.locate(getPage(address)).result;

    expect(located).toEqual(expected);
    expect(typeof located.room).toBe('bigint');
  });

  it('aggregates a shelf into its 32 titles in volume order', async () => {
    const client = new GenerationClient(new LoopbackWorker());

    const titles = await client.shelfTitles(FIRST_SHELF).result;

    expect(titles).toEqual(
      Array.from({ length: BOOKS_PER_SHELF }, (_unused, volume) =>
        getTitle({ ...FIRST_SHELF, volume })
      )
    );
  });

  it('holds nothing pending once a shelf has settled', async () => {
    const client = new GenerationClient(new LoopbackWorker());

    await client.shelfTitles(FIRST_SHELF).result;

    expect(client.pendingCount).toBe(0);
  });
});

describe('cancellation', () => {
  it('rejects the pending promise with CancelledRequestError naming the request', async () => {
    const client = new GenerationClient(new ScriptedWorker());
    const request = client.page(FIRST_ADDRESS);
    const id = onlyId(request);

    request.cancel();

    const error = await rejection(request.result);
    expect(error).toBeInstanceOf(CancelledRequestError);
    expect(error).toMatchObject({
      id,
      request: { kind: 'page', id, address: FIRST_ADDRESS },
    });
  });

  it('posts a cancel naming the id, so the worker can refuse it', () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.page(FIRST_ADDRESS);
    const id = onlyId(request);

    request.cancel();
    void rejection(request.result);

    expect(worker.sent).toEqual([
      { kind: 'page', id, address: FIRST_ADDRESS },
      { kind: 'cancel', id },
    ]);
  });

  it('leaves no cache entry for the address it abandoned', async () => {
    const cache = new GenerationCache();
    const client = new GenerationClient(new ScriptedWorker(), cache);
    const request = client.page(FIRST_ADDRESS);

    request.cancel();
    await rejection(request.result);

    expect(cache.getPage(FIRST_ADDRESS)).toBeUndefined();
    expect(cache.pageCount).toBe(0);
  });

  it('ignores a reply that was already in flight: it neither resolves nor caches', async () => {
    const cache = new GenerationCache();
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker, cache);
    const request = client.page(FIRST_ADDRESS);
    const id = onlyId(request);

    request.cancel();
    // What the worker says when it lost the race: the one reply this id will
    // ever get was already computed and sent (`protocol.ts`).
    worker.reply({ kind: 'cancel-ack', id, disposition: 'reply-in-flight' });
    worker.reply({ kind: 'page', id, text: getPage(FIRST_ADDRESS) });

    expect(await rejection(request.result)).toBeInstanceOf(CancelledRequestError);
    expect(cache.getPage(FIRST_ADDRESS)).toBeUndefined();
    expect(cache.pageBytes).toBe(0);
    expect(client.pendingCount).toBe(0);
  });

  it('ignores the dropped response for a request the worker refused in time', async () => {
    const cache = new GenerationCache();
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker, cache);
    const request = client.page(FIRST_ADDRESS);
    const id = onlyId(request);

    request.cancel();
    worker.reply({ kind: 'cancel-ack', id, disposition: 'pre-emptive' });
    worker.reply({
      kind: 'dropped',
      id,
      request: { kind: 'page', id, address: FIRST_ADDRESS },
    });

    expect(await rejection(request.result)).toBeInstanceOf(CancelledRequestError);
    expect(cache.pageCount).toBe(0);
  });

  it('rejects a cancelled shelf with CancelledRequestError', async () => {
    const client = new GenerationClient(new ScriptedWorker());
    const shelf = client.shelfTitles(FIRST_SHELF);

    shelf.cancel();

    expect(await rejection(shelf.result)).toBeInstanceOf(CancelledRequestError);
  });

  it('leaves no title cached for any volume of a cancelled shelf', async () => {
    const cache = new GenerationCache();
    const client = new GenerationClient(new ScriptedWorker(), cache);
    const shelf = client.shelfTitles(FIRST_SHELF);

    shelf.cancel();
    await rejection(shelf.result);

    expect(cache.titleCount).toBe(0);
  });

  it('cancels only the requests still in flight', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const shelf = client.shelfTitles(FIRST_SHELF);
    const [firstId] = shelf.ids;
    if (firstId === undefined) {
      throw new Error('the shelf issued no requests');
    }

    worker.reply({
      kind: 'title',
      id: firstId,
      title: getTitle({ ...FIRST_SHELF, volume: 0 }),
    });
    shelf.cancel();
    await rejection(shelf.result);

    const cancels = worker.sent.filter(
      (message) =>
        message !== null &&
        typeof message === 'object' &&
        'kind' in message &&
        message.kind === 'cancel'
    );
    expect(cancels).toHaveLength(BOOKS_PER_SHELF - 1);
  });

  it('is idempotent: a second cancel posts nothing and changes nothing', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.page(FIRST_ADDRESS);

    request.cancel();
    const sentAfterFirst = worker.sent.length;
    request.cancel();
    await rejection(request.result);

    expect(worker.sent).toHaveLength(sentAfterFirst);
  });

  it('is a no-op for a call the cache answered, which issued nothing to abandon', async () => {
    const cache = new GenerationCache();
    const text = getPage(FIRST_ADDRESS);
    cache.setPage(FIRST_ADDRESS, text);
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker, cache);

    const request = client.page(FIRST_ADDRESS);
    request.cancel();

    await expect(request.result).resolves.toBe(text);
    expect(worker.sent).toEqual([]);
  });
});

describe('searching', () => {
  const QUERY = 'вавилонская библиотека';
  /** The query's length in code points, counted here rather than by the client. */
  const QUERY_LENGTH = Array.from(QUERY).length;
  /** The last offset a query of `QUERY_LENGTH` code points can start at. */
  const LAST_OFFSET = PAGE_LENGTH - QUERY_LENGTH;

  it('sends the query as given, spaces and all, and the mode, and no offset, under its own id', () => {
    // `'spaces'` because every other search here sends `'random'`, so a
    // client that fixed the mode would pass them all. The spaces at both ends
    // are part of the query, kept as typed (SPEC §2 rule 4).
    const padded = `  ${QUERY} `;
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);

    client.search(padded, 'spaces');

    expect(worker.sent).toEqual([
      { kind: 'search', id: FIRST_REQUEST_ID, query: padded, mode: 'spaces' },
    ]);
  });

  it('resolves with the address and the offset the worker found', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.search(QUERY, 'spaces');

    worker.reply({
      kind: 'found',
      id: onlyId(request),
      address: SECOND_ADDRESS,
      offset: 9,
    });

    await expect(request.result).resolves.toEqual({
      address: SECOND_ADDRESS,
      offset: 9,
    });
  });

  it('resolves through the real loop at a page that holds the query at the offset', async () => {
    const client = new GenerationClient(new LoopbackWorker());

    const hit = await client.search(QUERY, 'random').result;

    expect(getPage(hit.address).slice(hit.offset, hit.offset + QUERY_LENGTH)).toBe(
      QUERY
    );
  });

  it('search is never served from the cache', async () => {
    const cache = new GenerationCache();
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker, cache);
    const first = client.search(QUERY, 'random');
    worker.reply({
      kind: 'found',
      id: onlyId(first),
      address: SECOND_ADDRESS,
      offset: 0,
    });
    await first.result;

    const second = client.search(QUERY, 'random');

    // The same text twice is two searches with two random offsets, so the
    // second has to cross the boundary as the first did.
    expect(second.ids).toEqual([FIRST_REQUEST_ID + 1]);
    expect(worker.sent).toHaveLength(2);
    expect(cache.pageCount).toBe(0);
    expect(cache.titleCount).toBe(0);
  });

  it('accepts an offset of PAGE_LENGTH minus the query length, the last one it can have', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.search(QUERY, 'random');

    worker.reply({
      kind: 'found',
      id: onlyId(request),
      address: SECOND_ADDRESS,
      offset: LAST_OFFSET,
    });

    await expect(request.result).resolves.toEqual({
      address: SECOND_ADDRESS,
      offset: LAST_OFFSET,
    });
  });

  it('accepts offset 0 for a query of a whole page, the one offset it can have', async () => {
    const wholePage = 'а'.repeat(PAGE_LENGTH);
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.search(wholePage, 'random');

    worker.reply({
      kind: 'found',
      id: onlyId(request),
      address: SECOND_ADDRESS,
      offset: 0,
    });

    await expect(request.result).resolves.toEqual({
      address: SECOND_ADDRESS,
      offset: 0,
    });
  });

  it("found with an offset above PAGE_LENGTH minus the query's length is a malformed response", async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.search(QUERY, 'random');
    const id = onlyId(request);

    worker.reply({
      kind: 'found',
      id,
      address: SECOND_ADDRESS,
      offset: LAST_OFFSET + 1,
    });

    const error = await rejection(request.result);
    expect(error).toBeInstanceOf(MalformedResponseError);
    expect(error).toMatchObject({
      id,
      detail: `an offset of ${String(LAST_OFFSET + 1)}, and a query of ${String(QUERY_LENGTH)} code points starts at an integer from 0 to ${String(LAST_OFFSET)}`,
    });
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
  ])('refuses a found offset that is %s', async (_description, offset) => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.search(QUERY, 'random');

    worker.reply({
      kind: 'found',
      id: onlyId(request),
      address: SECOND_ADDRESS,
      offset,
    });

    const error = await rejection(request.result);
    expect(error).toBeInstanceOf(MalformedResponseError);
    expect(error).toMatchObject({
      detail: expect.stringContaining(`an offset of ${String(offset)},`),
    });
  });

  it('refuses a found offset that is not a number by its type, never echoing it', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.search(QUERY, 'random');
    const offset = 'the offset a skewed worker sent';

    worker.reply({
      kind: 'found',
      id: onlyId(request),
      address: SECOND_ADDRESS,
      offset,
    });

    const error = await rejection(request.result);
    expect(error).toBeInstanceOf(MalformedResponseError);
    expect(error).toMatchObject({
      detail: "'offset' must be a number, received string",
    });
    expect(String(error)).not.toContain(offset);
  });

  it('measures the query in code points, not in UTF-16 units', async () => {
    // Two astral characters are four units and two code points. The worker
    // would refuse them, but the bound is the client's, and counting units
    // would refuse the last two offsets a two-symbol query can have.
    const astral = '\u{1F600}\u{1F600}';
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.search(astral, 'random');

    worker.reply({
      kind: 'found',
      id: onlyId(request),
      address: SECOND_ADDRESS,
      offset: PAGE_LENGTH - 2,
    });

    await expect(request.result).resolves.toMatchObject({ offset: PAGE_LENGTH - 2 });
  });

  it('refuses a hit for a query longer than a page without printing a range', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.search('а'.repeat(PAGE_LENGTH + 1), 'random');

    worker.reply({
      kind: 'found',
      id: onlyId(request),
      address: SECOND_ADDRESS,
      offset: 0,
    });

    const error = await rejection(request.result);
    expect(error).toBeInstanceOf(MalformedResponseError);
    expect(error).toMatchObject({
      detail: `a hit for a query of ${String(PAGE_LENGTH + 1)} code points, and a page holds ${String(PAGE_LENGTH)}`,
    });
  });

  it('refuses a located address where a search was asked for', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.search(QUERY, 'random');

    worker.reply({ kind: 'located', id: onlyId(request), address: SECOND_ADDRESS });

    expect(await rejection(request.result)).toMatchObject({
      detail: expect.stringContaining("expected a 'found'"),
    });
  });

  it("a cancelled search's error names its kind and length and not its query", async () => {
    const client = new GenerationClient(new ScriptedWorker());
    const request = client.search(QUERY, 'random');

    request.cancel();

    const error = await rejection(request.result);
    expect(error).toBeInstanceOf(CancelledRequestError);
    expect(error).toMatchObject({
      message: expect.stringContaining(
        `a search for a query of ${String(QUERY_LENGTH)} code points`
      ),
    });
    expect(String(error)).not.toContain('вавилон');
  });
});

describe('warm-up', () => {
  it('generates one page and discards it rather than caching it', async () => {
    const cache = new GenerationCache();
    const worker = new LoopbackWorker();
    const client = new GenerationClient(worker, cache);

    await client.warmUp();

    expect(cache.pageCount).toBe(0);
    expect(client.pendingCount).toBe(0);
  });

  it('asks for exactly one page', () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);

    void client.warmUp();

    expect(worker.sent).toHaveLength(WARM_UP_PAGE_COUNT);
  });

  it('uses the same fixed address every time, so its cost is reproducible', () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);

    void client.warmUp();
    void client.warmUp();

    expect(worker.sent).toEqual([
      { kind: 'page', id: FIRST_REQUEST_ID, address: WARM_UP_ADDRESS },
      { kind: 'page', id: FIRST_REQUEST_ID + 1, address: WARM_UP_ADDRESS },
    ]);
  });

  it('warms up at an address with a full-width room, not the first in the library', () => {
    // The point of warming up is to pay the JIT's and the allocator's entry
    // fee at the operand size the real work uses. `room 0` is a single limb
    // and a one-digit cache key, so it would not.
    expect(WARM_UP_ADDRESS.room).toBeGreaterThan(ROOM_COUNT / 1000n);
    expect(WARM_UP_ADDRESS.room).toBeLessThan(ROOM_COUNT);
  });
});

describe('reporting that nothing is in flight', () => {
  /** Whether a promise has settled, without waiting on anything. */
  async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
    const pending = Symbol('pending');
    // One turn of the microtask queue is enough: every resolution in this
    // client is a microtask, so nothing here waits on a duration.
    return (await Promise.race([promise, Promise.resolve(pending)])) !== pending;
  }

  it('is quiet before anything has been asked of it', async () => {
    const client = new GenerationClient(new ScriptedWorker());

    expect(client.isQuiet).toBe(true);
    expect(await hasSettled(client.whenQuiet())).toBe(true);
  });

  it('is not quiet while a request is in flight', async () => {
    const client = new GenerationClient(new ScriptedWorker());

    const request = client.page(FIRST_ADDRESS);

    expect(client.isQuiet).toBe(false);
    expect(await hasSettled(client.whenQuiet())).toBe(false);
    expect(request.ids).toHaveLength(1);
  });

  it('reports quiet once the last reply has arrived', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.page(FIRST_ADDRESS);
    const quiet = client.whenQuiet();

    worker.reply({
      kind: 'page',
      id: onlyId(request),
      text: getPage(FIRST_ADDRESS),
    });

    await quiet;
    expect(client.isQuiet).toBe(true);
  });

  it('waits for the whole of a shelf, not for its first title', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const shelf = client.shelfTitles(FIRST_SHELF);
    const quiet = client.whenQuiet();

    for (const [volume, id] of shelf.ids.entries()) {
      if (volume === BOOKS_PER_SHELF - 1) {
        break;
      }
      worker.reply({ kind: 'title', id, title: getTitle({ ...FIRST_SHELF, volume }) });
    }

    expect(await hasSettled(quiet)).toBe(false);
    expect(client.pendingCount).toBe(1);
  });

  it('reports quiet when a request is cancelled rather than answered', async () => {
    const client = new GenerationClient(new ScriptedWorker());
    const request = client.page(FIRST_ADDRESS);
    const quiet = client.whenQuiet();

    request.cancel();

    await quiet;
    expect(client.isQuiet).toBe(true);
    await expect(request.result).rejects.toBeInstanceOf(CancelledRequestError);
  });

  it('reports quiet when the worker dies with requests in flight', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.page(FIRST_ADDRESS);
    const quiet = client.whenQuiet();

    worker.breakDown();

    await quiet;
    expect(client.isQuiet).toBe(true);
    await expect(request.result).rejects.toBeInstanceOf(WorkerFailureError);
  });

  it('reports quiet when a reply is too malformed to attribute', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.page(FIRST_ADDRESS);
    const quiet = client.whenQuiet();

    worker.reply({ kind: 'page', id: onlyId(request) });

    await quiet;
    expect(client.isQuiet).toBe(true);
    await expect(request.result).rejects.toBeInstanceOf(MalformedResponseError);
  });

  it('becomes busy again after it has been quiet, and reports it', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const first = client.page(FIRST_ADDRESS);
    worker.reply({ kind: 'page', id: onlyId(first), text: getPage(FIRST_ADDRESS) });
    await client.whenQuiet();

    client.page(SECOND_ADDRESS);

    expect(client.isQuiet).toBe(false);
    expect(await hasSettled(client.whenQuiet())).toBe(false);
  });
});

describe('a request the worker refuses or cannot answer', () => {
  it('rejects with GenerationFailedError carrying the name core threw', async () => {
    const client = new GenerationClient(new LoopbackWorker());

    const error = await rejection(client.page(REJECTED_ADDRESS).result);

    expect(error).toBeInstanceOf(GenerationFailedError);
    expect(error).toMatchObject({ thrown: { name: 'InvalidAddressError' } });
  });

  it('rejects with StaleRequestError when the worker has already answered that id', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.page(FIRST_ADDRESS);
    const id = onlyId(request);

    worker.reply({ kind: 'stale', id, highestIdSeen: id + 7 });

    const error = await rejection(request.result);
    expect(error).toBeInstanceOf(StaleRequestError);
    expect(error).toMatchObject({ id, highestIdSeen: id + 7 });
  });

  it('rejects with ProtocolViolationError when the worker could not read the message', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.page(FIRST_ADDRESS);
    const id = onlyId(request);

    worker.reply({
      kind: 'protocol-error',
      id,
      fault: 'malformed-address',
      detail: "'address.room' must be a bigint, received number",
    });

    const error = await rejection(request.result);
    expect(error).toBeInstanceOf(ProtocolViolationError);
    expect(error).toMatchObject({ id, fault: 'malformed-address' });
  });

  it('rejects with MalformedResponseError when the message is not a response at all', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.page(FIRST_ADDRESS);
    const id = onlyId(request);

    worker.reply({ kind: 'page', id, text: 42 });

    const error = await rejection(request.result);
    expect(error).toBeInstanceOf(MalformedResponseError);
    expect(error).toMatchObject({ id });
  });

  it('rejects with MalformedResponseError when the result is of the wrong kind', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.page(FIRST_ADDRESS);
    const id = onlyId(request);

    worker.reply({ kind: 'title', id, title: getTitle(FIRST_BOOK) });

    const error = await rejection(request.result);
    expect(error).toBeInstanceOf(MalformedResponseError);
    expect(error).toMatchObject({
      detail: expect.stringContaining("expected a 'page'"),
    });
  });

  it('does not cache a result the worker attached to the wrong kind of request', async () => {
    const cache = new GenerationCache();
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker, cache);
    const request = client.page(FIRST_ADDRESS);

    worker.reply({ kind: 'title', id: onlyId(request), title: getTitle(FIRST_BOOK) });
    await rejection(request.result);

    expect(cache.pageCount).toBe(0);
  });

  it('ignores a malformed message naming an id that has already settled', async () => {
    const cache = new GenerationCache();
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker, cache);
    const request = client.page(FIRST_ADDRESS);
    const id = onlyId(request);

    request.cancel();
    // A late reply that is also misshapen. There is nothing left to reject, so
    // it is dropped exactly as a well-formed late reply would be — the rule is
    // the id, not the shape.
    worker.reply({ kind: 'page', id, text: null });

    expect(await rejection(request.result)).toBeInstanceOf(CancelledRequestError);
    expect(cache.pageCount).toBe(0);
  });

  it('ignores a message naming no request in flight, leaving the rest alone', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.page(FIRST_ADDRESS);
    const id = onlyId(request);

    worker.reply({ kind: 'page', id: id + 100, text: getPage(FIRST_ADDRESS) });
    worker.reply('not a message at all');
    worker.reply({
      kind: 'protocol-error',
      id: null,
      fault: 'not-an-object',
      detail: 'x',
    });
    worker.reply({ kind: 'page', id, text: getPage(FIRST_ADDRESS) });

    await expect(request.result).resolves.toBe(getPage(FIRST_ADDRESS));
  });

  it('rejects everything in flight when the worker reports an error', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const shelf = client.shelfTitles(FIRST_SHELF);

    worker.breakDown();

    expect(await rejection(shelf.result)).toBeInstanceOf(WorkerFailureError);
    expect(client.pendingCount).toBe(0);
  });

  it('rejects everything in flight when it is terminated, and stops the worker', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.page(FIRST_ADDRESS);

    client.terminate();

    const error = await rejection(request.result);
    expect(error).toBeInstanceOf(WorkerFailureError);
    expect(error).toMatchObject({ detail: 'the worker was terminated' });
    expect(worker.terminated).toBe(true);
  });
});

describe('branches that only a worker disagreeing with the client can reach', () => {
  it('rejects with CancelledRequestError if the worker drops an id still held here', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.page(FIRST_ADDRESS);
    const id = onlyId(request);

    // Unreachable through this client, which rejects and forgets an id at the
    // moment it cancels it — so a `dropped` always arrives for an id that is
    // no longer pending. Answered anyway, because leaving a promise pending on
    // a disagreement between the two ends is the hang ADR-0016 forbids.
    worker.reply({
      kind: 'dropped',
      id,
      request: { kind: 'page', id, address: FIRST_ADDRESS },
    });

    expect(await rejection(request.result)).toBeInstanceOf(CancelledRequestError);
  });

  it('refuses a page where a title was asked for', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.title(FIRST_BOOK);

    worker.reply({ kind: 'page', id: onlyId(request), text: getPage(FIRST_ADDRESS) });

    expect(await rejection(request.result)).toMatchObject({
      detail: expect.stringContaining("expected a 'title'"),
    });
  });

  it('refuses a page that is not 3200 characters, and caches nothing', async () => {
    // The cache is written in a `then` on the result, so a reply admitted here
    // would be served for that address for the rest of the session, and the
    // reader would refuse it every time with no way back.
    const cache = new GenerationCache();
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker, cache);
    const request = client.page(FIRST_ADDRESS);

    worker.reply({
      kind: 'page',
      id: onlyId(request),
      text: getPage(FIRST_ADDRESS).slice(1),
    });

    const error = await rejection(request.result);
    expect(error).toBeInstanceOf(MalformedResponseError);
    expect(error).toMatchObject({
      detail: expect.stringContaining('a page of 3199 characters, and a page is 3200'),
    });
    expect(cache.getPage(FIRST_ADDRESS)).toBeUndefined();
    expect(cache.pageCount).toBe(0);
  });

  it('refuses a page with a character too many', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.page(FIRST_ADDRESS);

    worker.reply({
      kind: 'page',
      id: onlyId(request),
      text: `${getPage(FIRST_ADDRESS)} `,
    });

    expect(await rejection(request.result)).toBeInstanceOf(MalformedResponseError);
  });

  it('refuses a title where an address was asked for', async () => {
    const worker = new ScriptedWorker();
    const client = new GenerationClient(worker);
    const request = client.locate(getPage(FIRST_ADDRESS));

    worker.reply({ kind: 'title', id: onlyId(request), title: getTitle(FIRST_BOOK) });

    expect(await rejection(request.result)).toMatchObject({
      detail: expect.stringContaining("expected a 'located'"),
    });
  });

  it('names what a cancelled locate asked for without rendering the page it carried', async () => {
    const client = new GenerationClient(new ScriptedWorker());
    const page = getPage(FIRST_ADDRESS);
    const request = client.locate(page);

    request.cancel();

    const error = await rejection(request.result);
    expect(error).toBeInstanceOf(CancelledRequestError);
    // A `locate` carries 3200 characters and a shelf rejects 32 promises at
    // once; the request is a field, not something the message prints.
    expect(error).toMatchObject({
      message: expect.stringContaining("a page's address"),
    });
    expect(String(error)).not.toContain(page.slice(0, 64));
  });
});
