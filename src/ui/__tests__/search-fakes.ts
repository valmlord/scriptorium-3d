import type { PadMode } from '@core/library';
import { GenerationClient } from '@worker/client';
import type { GenerationRequest, GenerationWorkerLike } from '@worker/client';
import type { SearchHit, SearchSource } from '@ui/search-session';

/**
 * The search session's three fakes, which differ only in what a cancelled
 * request does next, and the real errors they settle with.
 *
 * - The **rejecting** fake: `cancel()` rejects the result with a
 *   `CancelledRequestError` on a later microtask, as ADR-0016 requires.
 * - The **late** fake: the result resolves even after `cancel()`, as a cache
 *   hit or a reply already in flight does (ADR-0032). Nothing happens on
 *   cancel; the test settles it whenever it likes.
 * - The **failing** fake: after `cancel()` the result rejects with a
 *   `GenerationFailedError`, a reply that was a failure already in flight.
 *
 * **The errors are the worker client's own**, made by driving a real
 * `GenerationClient` over a worker that only records what it is sent. `@ui`
 * may call `@worker/client` and nothing else in `@worker`, so the classes in
 * `@worker/errors` cannot be constructed here, and a look-alike class with the
 * same name would test the session against the fake's idea of an error rather
 * than the client's. The session never asks an error's class (its rule 7); what
 * these instances make possible is a mutant that does ask, by name, being red.
 */

/** One search the fake was asked for, with the handles to settle it. */
export interface IssuedSearch {
  readonly query: string;
  readonly mode: PadMode;
  readonly request: GenerationRequest<SearchHit>;
  /** How many times `cancel()` was called on it. */
  readonly cancels: number;
  resolve(hit: SearchHit): void;
  reject(error: unknown): void;
}

export interface FakeSearchSource {
  readonly source: SearchSource;
  /** Every search issued, in order. */
  readonly issued: readonly IssuedSearch[];
  /** The last search issued; throws if there is none. */
  last(): IssuedSearch;
}

/** Errors produced by the real client, one of each kind the fakes settle with. */
export interface WorkerErrors {
  readonly cancelled: Error;
  readonly failed: Error;
}

/**
 * A query the client's failure message will carry, so a test can see that the
 * session never shows it.
 */
export const FAILED_QUERY_TEXT = 'the refused query мир';

export async function workerErrors(): Promise<WorkerErrors> {
  const worker: GenerationWorkerLike = {
    postMessage: () => undefined,
    onmessage: null,
    onerror: null,
    terminate: () => undefined,
  };
  const client = new GenerationClient(worker);

  const abandoned = client.search('мир', 'random');
  abandoned.cancel();
  const cancelled = await rejectionOf(abandoned.result);

  const refused = client.search('мир', 'random');
  worker.onmessage?.({
    data: {
      kind: 'failed',
      id: refused.ids[0],
      error: { name: 'InvalidSearchQueryError', message: FAILED_QUERY_TEXT },
    },
  });
  const failed = await rejectionOf(refused.result);

  return { cancelled, failed };
}

/** The rejecting fake. */
export function rejectingSource(errors: WorkerErrors): FakeSearchSource {
  return fakeSource((issued) => {
    queueMicrotask(() => {
      issued.reject(errors.cancelled);
    });
  });
}

/** The late fake. */
export function lateSource(): FakeSearchSource {
  return fakeSource(() => undefined);
}

/** The failing fake. */
export function failingSource(errors: WorkerErrors): FakeSearchSource {
  return fakeSource((issued) => {
    queueMicrotask(() => {
      issued.reject(errors.failed);
    });
  });
}

/**
 * Let every queued microtask run: the fakes' rejections, the session's
 * handlers, and the promises derived from them. A bounded count of turns
 * rather than a timer, so it waits for nothing that is not already queued.
 */
export async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
}

function fakeSource(onCancel: (issued: IssuedSearch) => void): FakeSearchSource {
  const issued: IssuedSearch[] = [];
  const source: SearchSource = {
    search(query: string, mode: PadMode): GenerationRequest<SearchHit> {
      let resolve: (hit: SearchHit) => void = () => undefined;
      let reject: (error: unknown) => void = () => undefined;
      const result = new Promise<SearchHit>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
      });
      let cancels = 0;
      const entry: IssuedSearch = {
        query,
        mode,
        request: {
          ids: [issued.length + 1],
          result,
          cancel: () => {
            cancels += 1;
            onCancel(entry);
          },
        },
        get cancels(): number {
          return cancels;
        },
        resolve: (hit) => {
          resolve(hit);
        },
        reject: (error) => {
          reject(error);
        },
      };
      issued.push(entry);
      return entry.request;
    },
  };
  return {
    source,
    issued,
    last(): IssuedSearch {
      const entry = issued.at(-1);
      if (entry === undefined) {
        throw new Error('the fake source was asked for no search');
      }
      return entry;
    },
  };
}

async function rejectionOf(result: Promise<unknown>): Promise<Error> {
  try {
    await result;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(`the client rejected with a non-error: ${String(error)}`, {
      cause: error,
    });
  }
  throw new Error('the client resolved a request it was expected to reject');
}
