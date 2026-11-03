import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { build } from 'vite';
import { Worker } from 'node:worker_threads';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BOOKS_PER_SHELF, LIBRARY_SIZE, fromLinear, getTitle } from '@core/index';
import type { BookAddress } from '@core/index';
import { GenerationCache } from '../cache';
import { GenerationClient } from '../client';
import type { GenerationWorkerLike, ShelfAddress } from '../client';
import { CancelledRequestError } from '../errors';
import { getViteConfig } from '../../../vite.aliases';
import type { ProtocolResponse, RequestId } from '../protocol';

/**
 * The one integration test M3 asks for: the real entry point, on a real
 * thread, answering real messages.
 *
 * `testing.md` §1 splits the worker's tests deliberately — "the handler is
 * where the bugs are; the thread is where the flakes are. Test them
 * separately." Everything that can be asserted without a thread already is:
 * the handler as a pure function, the loop against an injected clock and an
 * injected yield, the client against a scripted worker. What is left is what
 * only a thread can show, and there are two such things.
 *
 * The first is that the pieces actually fit: `entry.ts` narrows a scope,
 * `postMessage` carries a `bigint` through structured cloning, and a shelf of
 * 32 titles comes back as the 32 titles `core` computes.
 *
 * The second is the one that carries the milestone. **A cancel posted while a
 * shelf is being generated has to be read before the shelf finishes**, and
 * nothing in process can prove that: the loop's own tests inject the yield, so
 * they prove the loop re-reads its state *around* a yield, not that a real
 * event loop delivers a real message into one. Here the message is real and
 * the assertion is by outcome — `dropped` responses, which the worker can only
 * produce for a request it refused *before* calling `core`. A loop that
 * computed the shelf in one uninterrupted stretch would answer all 32 and
 * produce not one of them.
 *
 * ## What this harness does and does not prove
 *
 * Vitest runs in the `node` environment, so the thread is a
 * `node:worker_threads` worker and `__tests__/node-worker-entry.ts` installs
 * the two members of a worker scope that `entry.ts` narrows for over Node's
 * `parentPort`, then imports `entry.ts` itself. So the production entry module
 * is what runs. What is assumed rather than measured is that a browser's
 * `DedicatedWorkerGlobalScope` offers the same two members — which is the
 * platform's specification, and is also what the Playwright suite will
 * exercise once there is a page that loads the worker (`testing.md` §6).
 *
 * The module graph is bundled with Vite once in `beforeAll`, because the
 * source imports `@core/index` and a raw Node thread resolves no aliases. It
 * costs about half a second; the thread itself costs tens of milliseconds, so
 * each test gets its own.
 */
// No `vi.setConfig` here. A `testTimeout: 60_000` and a `hookTimeout: 120_000`
// stood on this line while Vitest's unexamined 5 s default was the alternative.
// Measured over twelve `ubuntu-latest` runs on three CPU models (ADR-0028),
// the slowest test in this file is 610 ms and the `beforeAll` build is 45 to
// 94 ms, so against the chosen ceilings in `vite.config.ts` — 25 s and 50 s —
// those figures were 41x and 530x anything this file has been observed to do.
// A number that large is not a budget, it is decoration, and this repository
// has removed ten of those. The config's ceilings govern this file.

/** Where the bundled worker entry is written. Inside `node_modules`, as Stryker's is. */
const BUILD_DIR = resolve('node_modules/.worker-integration-build');

const FIRST_SHELF: ShelfAddress = { room: 0n, wall: 0, shelf: 0 };

/** The 32 volumes of `FIRST_SHELF`, in the order the client fans them out. */
const SHELF_VOLUMES: readonly BookAddress[] = Array.from(
  { length: BOOKS_PER_SHELF },
  (_unused, volume) => ({ ...FIRST_SHELF, volume })
);

let workerEntryUrl: URL;
const spawned: Worker[] = [];

beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: getViteConfig() },
    build: {
      write: true,
      outDir: BUILD_DIR,
      emptyOutDir: true,
      target: 'node22',
      minify: false,
      lib: {
        entry: resolve('src/worker/__tests__/node-worker-entry.ts'),
        formats: ['es'],
        fileName: 'node-worker-entry',
      },
      // Node builtins stay imports; everything else is bundled, so the output
      // does not depend on where it is written or on module resolution from
      // there.
      rollupOptions: { external: [/^node:/] },
    },
  });
  workerEntryUrl = pathToFileURL(resolve(BUILD_DIR, entryFileName(result)));
});

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((worker) => worker.terminate()));
});

afterAll(async () => {
  await rm(BUILD_DIR, { recursive: true, force: true });
});

/**
 * The name of the entry chunk the build produced.
 *
 * Read off the result rather than assumed: whether Vite writes `.js` or
 * `.mjs` for an ES library depends on the package's `type`, and a hard-coded
 * name would be a test that breaks on a Vite upgrade for no reason worth
 * reading about. Narrowed from `unknown` because Rollup's output type is a
 * union of three shapes and only one of them has chunks.
 */
function entryFileName(result: unknown): string {
  const bundles: readonly unknown[] = Array.isArray(result) ? result : [result];
  for (const bundle of bundles) {
    if (!isRecord(bundle) || !Array.isArray(bundle.output)) {
      continue;
    }
    for (const chunk of bundle.output) {
      if (
        isRecord(chunk) &&
        chunk.isEntry === true &&
        typeof chunk.fileName === 'string'
      ) {
        return chunk.fileName;
      }
    }
  }
  throw new Error('The worker build produced no entry chunk to spawn');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * One volume of `FIRST_SHELF`, refused rather than coerced if it is not there.
 *
 * `noUncheckedIndexedAccess` makes an index read `BookAddress | undefined`,
 * and a `!` would be the one place in this file where a wrong index produced
 * an unreadable failure instead of a named one.
 */
function volumeAt(index: number): BookAddress {
  const book = SHELF_VOLUMES[index];
  if (book === undefined) {
    throw new Error(`Volume ${String(index)} is not on this shelf`);
  }
  return book;
}

/** A real worker thread running the real entry point. */
function spawnWorker(): Worker {
  const worker = new Worker(workerEntryUrl);
  spawned.push(worker);
  return worker;
}

/**
 * A `GenerationWorkerLike` over a Node worker thread.
 *
 * The client needs four members of a `Worker`, which is the point of it
 * naming them structurally rather than taking the DOM class — and the mapping
 * is this short because `postMessage` and the `message` event are the same
 * concepts on both platforms.
 */
class NodeWorkerAdapter implements GenerationWorkerLike {
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(private readonly worker: Worker) {
    worker.on('message', (data: unknown) => {
      this.onmessage?.({ data });
    });
    worker.on('error', (error: unknown) => {
      this.onerror?.(error);
    });
  }

  postMessage(message: unknown): void {
    this.worker.postMessage(message);
  }

  terminate(): void {
    void this.worker.terminate();
  }
}

/**
 * Resolves once the thread has posted `count` messages.
 *
 * A count rather than a duration: `testing.md` §7 rejects a test that sleeps
 * on a fixed duration, and the count here is exact — the protocol answers
 * every message exactly once, so 32 requests and 32 cancels are 64 messages
 * and no more.
 */
function messagesPosted(worker: Worker, count: number): Promise<void> {
  let seen = 0;
  return new Promise((resolve) => {
    worker.on('message', () => {
      seen += 1;
      if (seen === count) {
        resolve();
      }
    });
  });
}

/** Collect responses from a raw thread until `done` says to stop. */
function collectResponses(
  worker: Worker,
  done: (responses: readonly ProtocolResponse[]) => boolean,
  onEach?: (response: ProtocolResponse, responses: readonly ProtocolResponse[]) => void
): Promise<readonly ProtocolResponse[]> {
  const responses: ProtocolResponse[] = [];
  return new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', (response: ProtocolResponse) => {
      responses.push(response);
      onEach?.(response, responses);
      if (done(responses)) {
        resolve(responses);
      }
    });
  });
}

function countOfKind(responses: readonly ProtocolResponse[], kind: string): number {
  return responses.filter((response) => response.kind === kind).length;
}

describe('a real worker thread', () => {
  it('answers a shelf of 32 titles with the titles core computes, in volume order', async () => {
    const client = new GenerationClient(new NodeWorkerAdapter(spawnWorker()));

    const titles = await client.shelfTitles(FIRST_SHELF).result;

    expect(titles).toEqual(SHELF_VOLUMES.map((book) => getTitle(book)));
  });

  it('carries a room across the boundary as a bigint, not a widened number', async () => {
    const client = new GenerationClient(new NodeWorkerAdapter(spawnWorker()));
    const address = fromLinear(LIBRARY_SIZE / 3n);

    const page = await client.page(address).result;
    const located = await client.locate(page).result;

    // `Number(room)` on a 4975-digit value is `Infinity` (`code-style.md` §1),
    // so this is the assertion that structured cloning carried the address at
    // all rather than something that merely looks like one.
    expect(typeof located.room).toBe('bigint');
    expect(located).toEqual(address);
  });

  it('warms up through the thread without caching the page it threw away', async () => {
    const cache = new GenerationCache();
    const client = new GenerationClient(new NodeWorkerAdapter(spawnWorker()), cache);

    await client.warmUp();

    expect(cache.pageCount).toBe(0);
  });

  it('answers a payload that is not a message rather than dying on it', async () => {
    const worker = spawnWorker();
    const responses = collectResponses(worker, (seen) => seen.length === 2);

    worker.postMessage('not a message');
    worker.postMessage({ kind: 'title', id: 1, book: volumeAt(0) });

    expect(await responses).toEqual([
      {
        kind: 'protocol-error',
        id: null,
        fault: 'not-an-object',
        detail: expect.any(String),
      },
      { kind: 'title', id: 1, title: getTitle(volumeAt(0)) },
    ]);
  });
});

describe('cancelling a shelf that a real thread is part way through', () => {
  it('refuses the requests it has not reached, which a worker that never yielded could not', async () => {
    const worker = spawnWorker();
    const ids: readonly RequestId[] = SHELF_VOLUMES.map((_unused, index) => index + 1);
    const abandoned = ids.slice(BOOKS_PER_SHELF / 2);
    // One message per request, and one acknowledgement per cancel.
    const expected = ids.length + abandoned.length;

    const responses = collectResponses(
      worker,
      (seen) => seen.length === expected,
      (response, seen) => {
        // The first answer proves the worker has started generating. Posting
        // the cancels now is the real timing a camera has: a shelf has about
        // 28 ms of work left at this point (ADR-0005).
        if (seen.length === 1 && response.kind === 'title') {
          for (const id of abandoned) {
            worker.postMessage({ kind: 'cancel', id });
          }
        }
      }
    );
    for (const id of ids) {
      worker.postMessage({ kind: 'title', id, book: volumeAt(id - 1) });
    }
    const seen = await responses;

    // Every request got exactly one answer, and some of them were refused
    // before `core` was called. A loop that answered the whole burst in one
    // uninterrupted stretch would have produced 32 titles and no `dropped`
    // at all — it would not have read a single one of these cancels until
    // after the last title it could have saved.
    expect(seen).toHaveLength(expected);
    expect(countOfKind(seen, 'title')).toBeGreaterThan(0);
    expect(countOfKind(seen, 'dropped')).toBeGreaterThan(0);
    expect(countOfKind(seen, 'title') + countOfKind(seen, 'dropped')).toBe(ids.length);
  });

  it('rejects the aggregate with CancelledRequestError and caches none of it', async () => {
    const cache = new GenerationCache();
    const worker = spawnWorker();
    const client = new GenerationClient(new NodeWorkerAdapter(worker), cache);

    // One answer per request plus one acknowledgement per cancel: everything
    // the thread will ever say about this shelf.
    const quiet = messagesPosted(worker, BOOKS_PER_SHELF * 2);
    const shelf = client.shelfTitles(FIRST_SHELF);
    shelf.cancel();
    const error = await shelf.result.then(
      () => {
        throw new Error('the cancelled shelf resolved');
      },
      (reason: unknown) => reason
    );

    expect(error).toBeInstanceOf(CancelledRequestError);
    // Then let the thread finish saying whatever it was going to say, so the
    // assertion covers the replies that were already in flight as well as the
    // ones the worker refused in time. Neither reaches the cache.
    await quiet;
    expect(cache.titleCount).toBe(0);
    expect(client.pendingCount).toBe(0);
  });
});
