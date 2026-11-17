import { BOOKS_PER_SHELF, LIBRARY_SIZE, fromLinear } from '@core/address';
import type { Address, BookAddress } from '@core/address';
import { GenerationCache } from './cache';
import {
  CancelledRequestError,
  GenerationFailedError,
  MalformedResponseError,
  ProtocolViolationError,
  StaleRequestError,
  WorkerFailureError,
} from './errors';
import { FIRST_REQUEST_ID } from './protocol';
import type { CancelRequest, ProtocolRequest, RequestId } from './protocol';
import { parseProtocolResponse } from './response';
import type { IncomingResponse } from './response';

/**
 * The worker client: the only thing in this codebase that calls `core` at
 * runtime (ADR-0005), seen from the main thread as promises.
 *
 * It owns four things, and each of them is a decision taken elsewhere:
 *
 * 1. **The request ids.** A monotonically increasing integer, owned here.
 *    Never a timestamp and never random (`architecture.md` §5): a protocol
 *    keyed by timestamps is one whose test suite cannot replay a session, and
 *    two requests issued inside the same millisecond would collide.
 * 2. **The cache**, read *before* the boundary. A hit does not cross it at all
 *    — not even to be served from inside the worker, which would still cost
 *    two `postMessage` hops and a task-queue turn. That is the whole reason
 *    `cache.ts` lives on this side (see its header).
 * 3. **The fan-out.** A shelf is 32 single-address requests aggregated here,
 *    not one batch message. Flying past a shelf must abandon the titles not
 *    yet computed, and a batch cannot express the cancellation of part of
 *    itself without inventing a second addressing scheme inside the payload
 *    (`protocol.ts`).
 * 4. **The cancellation race.** A cancelled request's promise rejects with
 *    `CancelledRequestError` (ADR-0016), and the reply that was already in
 *    flight when the cancel went out is ignored rather than cached or resolved
 *    on. The handler makes that race expressible; this is where it is actually
 *    ignored — see `receive` below.
 *
 * **Every request settles.** The protocol answers every message exactly once,
 * including the malformed and the already-cancelled, and every response kind
 * either resolves or rejects a promise here. A request that could never settle
 * is the hang ADR-0016 exists to prevent, so the two ways one could escape
 * that — a worker that dies and a response that cannot be narrowed — are
 * answered too.
 */

/**
 * A shelf: the 32 volumes sharing a room, wall and shelf index.
 *
 * Derived from `BookAddress` rather than written out, so it cannot drift from
 * the address model. There is no such type in `core` because nothing there
 * addresses a shelf — the bijection is over pages — and the shelf is a unit of
 * *rendering*: 32 spines resolved together when the camera gets close enough
 * to read them (`architecture.md` §3).
 */
export type ShelfAddress = Omit<BookAddress, 'volume'>;

/**
 * A call in flight, and the handle that can abandon it.
 *
 * `ids` is what was actually issued, which is not always one and not always
 * more than zero: a shelf issues up to `BOOKS_PER_SHELF`, and a call served
 * entirely from the cache issues none. A caller never has to ask which
 * happened — `cancel()` is meaningful either way.
 *
 * A handle rather than an `AbortSignal` the caller owns: ADR-0016 rejected
 * that for now because it moves the bookkeeping into `ui/` for a single call
 * site. A handle rather than a plain promise because cancellation names ids,
 * not addresses — the same address may be in flight under two ids while a
 * camera passes a shelf twice (`protocol.ts`).
 */
export interface GenerationRequest<T> {
  /** The ids this call issued, in issue order. Empty for a cache hit. */
  readonly ids: readonly RequestId[];

  /**
   * The result, or a rejection. `CancelledRequestError` if it was cancelled;
   * every other error here is a bug on one side of the boundary.
   */
  readonly result: Promise<T>;

  /**
   * Abandon whatever of this call has not already settled.
   *
   * Idempotent, and a no-op once the call has settled or if it never left the
   * main thread. Partially cancelling a shelf is the normal case: some of its
   * 32 titles have arrived, some are still queued in the worker.
   */
  cancel(): void;
}

/**
 * What this client needs of a `Worker`.
 *
 * A structural subset rather than the DOM `Worker` itself, for two reasons.
 * The client is then testable without a thread, which is where
 * `testing.md` §1 wants most of its assertions. And it documents exactly how
 * much of the platform object is load-bearing: two members to send and
 * receive, one to notice the thread dying, one to stop it.
 *
 * Setting `onmessage` rather than adding a listener is deliberate: this client
 * takes exclusive ownership of the worker it is given. Two clients sharing one
 * worker would share its monotonic id sequence, and the second one's first
 * request would be refused as stale.
 */
export interface GenerationWorkerLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  terminate(): void;
}

/**
 * The address warm-up generates a page at and throws away.
 *
 * Exported so that the figure has one home (ADR-0013): a test asserting that
 * warm-up is reproducible asserts against this, not against a second copy of
 * the expression.
 *
 * **Fixed, so that the warm-up cost is itself reproducible.** A random address
 * would make the one measurement that exists to absorb a cost vary by the
 * thing it is absorbing, and `architecture.md` §5 keeps `Math.random()` off
 * the generation path regardless.
 *
 * The midpoint of the library rather than its first address, because the first
 * one is `room 0` — a `bigint` of a single limb and a key of one digit, where
 * every address a reader actually reaches has a 3197-digit room name. Warm-up
 * exists to pay the JIT's and the allocator's entry fee at the operand size
 * the real work uses: the first `getPage` of a fresh process measured 7.0 to
 * 12.1 ms on the two CI runners against 1.0 to 1.35 ms warm, roughly eight
 * times (ADR-0005) — up to three quarters of a frame for a single page.
 */
export const WARM_UP_ADDRESS: Address = fromLinear(LIBRARY_SIZE / 2n);

/** The result responses: the three that carry what a caller asked for. */
type ResultResponse = Extract<IncomingResponse, { kind: 'page' | 'title' | 'located' }>;

/** A result pulled out of a response, or why it could not be. */
type Taken<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly detail: string };

/** A request issued and awaiting its one response. */
interface PendingRequest {
  /** Kept so every rejection can name what was asked for (`errors.ts`). */
  readonly request: ProtocolRequest;
  /** Accept a result response and resolve, or reject if it is the wrong one. */
  readonly fulfil: (response: ResultResponse) => void;
  /** Reject with a named error. */
  readonly fail: (error: Error) => void;
}

/** An id and the promise for its one response, before any derivation. */
interface IssuedRequest<T> {
  readonly id: RequestId;
  readonly result: Promise<T>;
}

export class GenerationClient {
  /**
   * The next id to issue. Monotonic, starting at `FIRST_REQUEST_ID` so that
   * the worker can use `0` for "nothing seen yet" (`protocol.ts`).
   */
  private nextId: RequestId = FIRST_REQUEST_ID;

  /**
   * Requests issued and not yet settled.
   *
   * An id leaves this table the moment it settles, whether by a response or by
   * cancellation — and that single rule is how the cancellation race is won.
   * `receive` ignores any response whose id is absent, so a reply computed
   * before the cancel reached the worker arrives, finds nothing to settle, and
   * changes nothing: it is not cached, nothing resolves on it, and no
   * bookkeeping of cancelled ids has to be kept to recognise it. Ids are
   * monotonic and never reused, so an absent id is unambiguous.
   */
  private readonly pending = new Map<RequestId, PendingRequest>();

  /**
   * Who is waiting for `pending` to empty (`whenQuiet`). Released by `forget`,
   * which is the one place an id leaves the table, so a waiter cannot be left
   * behind by a settlement path nobody thought of.
   */
  private readonly quietWaiters: (() => void)[] = [];

  /**
   * @param worker The worker to own. Its `onmessage` and `onerror` are
   * replaced.
   * @param cache The cache to read through. Injectable so that a caller can
   * share one across clients, and so a test can see what was admitted.
   */
  constructor(
    private readonly worker: GenerationWorkerLike,
    private readonly cache: GenerationCache = new GenerationCache()
  ) {
    worker.onmessage = (event): void => {
      this.receive(event.data);
    };
    // A dead worker answers nothing, and the protocol's "every message earns
    // exactly one response" is a promise only the worker can keep. `onerror`
    // is the only notice the platform gives that it cannot: a worker script
    // that fails to load fires it, and without this every request in flight
    // would hang. `messageerror` is not handled because nothing this protocol
    // sends can fail to clone — strings, `bigint`s and plain objects are all
    // structured-cloneable.
    worker.onerror = (): void => {
      this.failEveryPending('the worker reported an error');
    };
  }

  /** How many requests are issued and not yet settled. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Whether nothing at all is in flight. */
  get isQuiet(): boolean {
    return this.pending.size === 0;
  }

  /**
   * Resolves the next time nothing is in flight.
   *
   * This is the half of `waitForIdle()` that belongs to the thread
   * (`docs/testing.md` §7): the end-to-end suite may not sleep on a duration,
   * and `pendingCount` alone is a number a test would have to poll. Every
   * request settles exactly once (see the header), and every settlement goes
   * through `forget` below, so a table that empties is an event this client
   * can report rather than a condition anyone has to watch for.
   *
   * It says nothing about what the *caller* then does with a result. A page
   * arriving leaves this client quiet while the reader is still writing it to
   * the DOM, which is why the hook composes this with the reader's own
   * idleness instead of taking it for the whole answer (`src/app/idle.ts`).
   */
  whenQuiet(): Promise<void> {
    if (this.isQuiet) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.quietWaiters.push(resolve);
    });
  }

  /**
   * The text of one page: 3200 characters.
   *
   * Served from the cache without touching the worker when it is there, which
   * is the case a reader flipping back a page hits.
   */
  page(address: Address): GenerationRequest<string> {
    const cached = this.cache.getPage(address);
    if (cached !== undefined) {
      return this.handle([], Promise.resolve(cached));
    }
    const issued = this.issue((id) => ({ kind: 'page', id, address }), takePage);
    // Caching in a `then` rather than in the response handler is what keeps a
    // cancelled request's result out of the cache: cancellation rejects, so
    // this never runs for one, and a late reply to a cancelled id never
    // reaches a handler at all.
    const result = issued.result.then((text) => {
      this.cache.setPage(address, text);
      return text;
    });
    return this.handle([issued.id], result);
  }

  /** The title of one volume: the first 25 characters of its page 0. */
  title(book: BookAddress): GenerationRequest<string> {
    const cached = this.cache.getTitle(book);
    if (cached !== undefined) {
      return this.handle([], Promise.resolve(cached));
    }
    const issued = this.issue((id) => ({ kind: 'title', id, book }), takeTitle);
    const result = issued.result.then((title) => {
      this.cache.setTitle(book, title);
      return title;
    });
    return this.handle([issued.id], result);
  }

  /**
   * The address of a page of text — the inverse direction of the bijection.
   *
   * Not cached, and `cache.ts` has no store for it. The key would have to be
   * the 3200-character page itself, so an entry would cost 6.4 KB of key to
   * save the 1.0 to 1.4 ms of a `locate`; and nothing asks twice, because a
   * search query is typed once and the address it resolves to is what the
   * navigation state then holds.
   */
  locate(page: string): GenerationRequest<Address> {
    const issued = this.issue((id) => ({ kind: 'locate', id, page }), takeLocated);
    return this.handle([issued.id], issued.result);
  }

  /**
   * The 32 titles of one shelf, in volume order.
   *
   * Fanned out over `BOOKS_PER_SHELF` single-address requests and aggregated
   * here. Each one goes through `title` above, so a shelf half of which is
   * already cached issues only the requests it has to — and a shelf entirely
   * in the cache issues none and never touches the worker.
   *
   * `cancel()` on the returned handle abandons whichever of the 32 have not
   * arrived; the aggregate then rejects with the `CancelledRequestError` of
   * the first of them. That is the whole reason the fan-out is here and not in
   * the protocol.
   */
  shelfTitles(shelf: ShelfAddress): GenerationRequest<readonly string[]> {
    const ids: RequestId[] = [];
    const titles: Promise<string>[] = [];
    for (let volume = 0; volume < BOOKS_PER_SHELF; volume += 1) {
      const issued = this.title({ ...shelf, volume });
      ids.push(...issued.ids);
      titles.push(issued.result);
    }
    return this.handle(ids, Promise.all(titles));
  }

  /**
   * Generate one throwaway page at a fixed address and discard it.
   *
   * Called once on startup. It pays the cold-start cost — eight times a warm
   * page, up to 12.1 ms (ADR-0005) — on a page nobody is waiting for, so that
   * the first page a reader asks for is a warm one.
   *
   * The result is discarded rather than cached: caching it would retain 6.4 KB
   * for an address no reader will ask for, and reaching it later would then
   * measure a cache hit rather than the generation this exists to warm.
   */
  async warmUp(): Promise<void> {
    const issued = this.issue(
      (id) => ({ kind: 'page', id, address: WARM_UP_ADDRESS }),
      takePage
    );
    await issued.result;
  }

  /**
   * Abandon the given requests (ADR-0016).
   *
   * Each still-pending id is rejected with `CancelledRequestError` here and
   * now, and a `cancel` naming it is posted so the worker can refuse it if it
   * has not computed it yet. Rejecting before the acknowledgement arrives is
   * the honest order: the assumption is always that the reply is already in
   * flight, and waiting for the worker to confirm it would be waiting on the
   * very round trip the caller is trying to stop paying for.
   *
   * An id that has already settled is skipped rather than cancelled, so this
   * is idempotent and so the worker is not sent a cancel whose only possible
   * answer is `reply-in-flight`.
   */
  cancel(ids: readonly RequestId[]): void {
    for (const id of ids) {
      const pending = this.pending.get(id);
      if (pending === undefined) {
        continue;
      }
      this.forget(id);
      pending.fail(new CancelledRequestError(id, pending.request));
      const cancellation: CancelRequest = { kind: 'cancel', id };
      this.worker.postMessage(cancellation);
    }
  }

  /**
   * Stop the worker, rejecting everything still in flight.
   *
   * The rejections come first: once the thread is gone nothing will answer
   * those ids, and leaving them pending would be a hang with no cause left to
   * diagnose it from.
   */
  terminate(): void {
    this.failEveryPending('the worker was terminated');
    this.worker.terminate();
  }

  /** Issue one request under the next id and remember it until it settles. */
  private issue<T>(
    build: (id: RequestId) => ProtocolRequest,
    take: (response: ResultResponse) => Taken<T>
  ): IssuedRequest<T> {
    const id = this.nextId;
    this.nextId += 1;
    const request = build(id);
    // The executor runs synchronously, so the request is in `pending` before
    // it is posted — which matters for a worker fast enough to answer inside
    // the same task, and for a test that posts the answer itself.
    const result = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        request,
        fulfil: (response): void => {
          const taken = take(response);
          if (taken.ok) {
            resolve(taken.value);
            return;
          }
          reject(new MalformedResponseError(id, taken.detail));
        },
        fail: reject,
      });
    });
    this.worker.postMessage(request);
    return { id, result };
  }

  /** Wrap a result in the handle a caller gets back. */
  private handle<T>(
    ids: readonly RequestId[],
    result: Promise<T>
  ): GenerationRequest<T> {
    return {
      ids,
      result,
      cancel: (): void => {
        this.cancel(ids);
      },
    };
  }

  /**
   * Take one message from the worker.
   *
   * The payload is untrusted data crossing a boundary and is narrowed at
   * runtime (`code-style.md` §1) — "it is our own code on the other end" is a
   * promise to the compiler, and the compiler is not what delivers the
   * message.
   *
   * **A response for an id that is not pending is ignored, and that is the
   * whole of ADR-0016's third assertion.** Such a response is a reply the
   * worker had already computed when the cancel was posted: the id left
   * `pending` at the moment it was cancelled, so there is nothing to resolve,
   * nothing is written to the cache, and the result is simply dropped.
   */
  private receive(payload: unknown): void {
    const parsed = parseProtocolResponse(payload);
    if (!parsed.ok) {
      // A message that names no id in flight cannot be attributed to anything
      // and there is nothing to settle; one that does must not be left
      // pending, whatever is wrong with it.
      this.failIfPending(
        parsed.id,
        (id) => new MalformedResponseError(id, parsed.detail)
      );
      return;
    }
    const response = parsed.response;
    if (response.kind === 'cancel-ack') {
      // Nothing to do, for any of the three dispositions, and that is a
      // consequence of `cancel` rejecting on the spot rather than an oversight.
      // `pre-emptive` means a `dropped` will follow; `reply-in-flight` means a
      // result will follow; `already-cancelled` means neither. All three name
      // an id that is no longer pending, so all three are answered by the rule
      // above — the reply, when it comes, is ignored.
      return;
    }
    const id = response.id;
    if (id === null) {
      // Only a `protocol-error` can arrive without an id: the worker could not
      // read one off the payload. There is no promise to settle.
      return;
    }
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.forget(id);
    switch (response.kind) {
      case 'page':
      case 'title':
      case 'located':
        pending.fulfil(response);
        return;
      case 'dropped':
        pending.fail(new CancelledRequestError(id, pending.request));
        return;
      case 'failed':
        pending.fail(new GenerationFailedError(id, pending.request, response.error));
        return;
      case 'stale':
        pending.fail(
          new StaleRequestError(id, pending.request, response.highestIdSeen)
        );
        return;
      case 'protocol-error':
        pending.fail(
          new ProtocolViolationError(
            id,
            pending.request,
            response.fault,
            response.detail
          )
        );
        return;
    }
  }

  /**
   * Drop `id` from the table, which is what "settled" means here, and release
   * anything waiting for the table to empty.
   */
  private forget(id: RequestId): void {
    this.pending.delete(id);
    this.releaseQuietWaiters();
  }

  /** Release the `whenQuiet` waiters, if there is now nothing in flight. */
  private releaseQuietWaiters(): void {
    if (!this.isQuiet) {
      return;
    }
    for (const resolve of this.quietWaiters.splice(0)) {
      resolve();
    }
  }

  /** Reject one pending request, if that id is pending at all. */
  private failIfPending(id: RequestId | null, error: (id: RequestId) => Error): void {
    if (id === null) {
      return;
    }
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.forget(id);
    pending.fail(error(id));
  }

  /** Reject everything in flight, for a worker that will answer no more. */
  private failEveryPending(detail: string): void {
    const abandoned = [...this.pending];
    // Cleared before any rejection runs, so a handler reacting to one of them
    // cannot observe a table that still claims those ids are in flight.
    this.pending.clear();
    this.releaseQuietWaiters();
    for (const [id, pending] of abandoned) {
      pending.fail(new WorkerFailureError(id, pending.request, detail));
    }
  }
}

/**
 * Create the worker this client drives, on the platform the application runs
 * on.
 *
 * The `new Worker(new URL(...), { type: 'module' })` form is what Vite
 * recognises in order to build `./entry.ts` as a separate module graph
 * (`vite.config.ts` sets `worker.format: 'es'`). It is a function rather than
 * something the client does for itself so that the client stays constructible
 * without a `Worker` global, which is how `testing.md` §1 gets to test the
 * client without the thread.
 *
 * **It hands back an adapter rather than the `Worker` itself**, for the reason
 * `GenerationWorkerLike` exists: a `Worker`'s `onmessage` takes a
 * `MessageEvent`, which carries two dozen members this client never reads, and
 * a handler written for the one member it does read is not assignable to it.
 * The mapping is three lines because `postMessage` and the `message` event are
 * the same two concepts on every platform the worker runs on — the Node thread
 * in `__tests__/worker-thread.integration.test.ts` is adapted the same way.
 */
export function createGenerationWorker(): GenerationWorkerLike {
  return new BrowserWorkerAdapter(
    new Worker(new URL('./entry.ts', import.meta.url), { type: 'module' })
  );
}

/** A `GenerationWorkerLike` over the platform's own `Worker`. */
class BrowserWorkerAdapter implements GenerationWorkerLike {
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(private readonly worker: Worker) {
    worker.onmessage = (event: MessageEvent): void => {
      this.onmessage?.({ data: event.data });
    };
    worker.onerror = (event: unknown): void => {
      this.onerror?.(event);
    };
  }

  postMessage(message: unknown): void {
    this.worker.postMessage(message);
  }

  terminate(): void {
    this.worker.terminate();
  }
}

function takePage(response: ResultResponse): Taken<string> {
  if (response.kind !== 'page') {
    return wrongKind('page', response.kind);
  }
  return { ok: true, value: response.text };
}

function takeTitle(response: ResultResponse): Taken<string> {
  if (response.kind !== 'title') {
    return wrongKind('title', response.kind);
  }
  return { ok: true, value: response.title };
}

function takeLocated(response: ResultResponse): Taken<Address> {
  if (response.kind !== 'located') {
    return wrongKind('located', response.kind);
  }
  return { ok: true, value: response.address };
}

/**
 * The worker answered a request with a result of another kind.
 *
 * Impossible from `handler.ts`, which derives the response kind from the
 * request kind in one switch — which is exactly why it is worth refusing
 * rather than coercing: if it ever happens, something between the two ends is
 * not the handler, and caching a title as a page would corrupt the cache
 * invisibly.
 */
function wrongKind(expected: string, received: string): Taken<never> {
  return {
    ok: false,
    detail: `expected a '${expected}' result and received '${received}'`,
  };
}
