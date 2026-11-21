import type { Address } from '@core/address';
import { AddressBeyondLibraryError, InvalidAddressError } from '@core/errors';
// Type only: the generation surface stays in the worker (ADR-0029).
import type { PadMode } from '@core/library';
import { NonIntegerComponentError } from '@state/errors';
import { atPageAddress, eventsTo } from '@state/navigation';
import type { Navigation, NavigationEvent } from '@state/navigation';
import type { GenerationRequest } from '@worker/client';
import type { Highlight, Hit } from './highlight';
import { judgeQuery } from './query';
import type { QueryRefusal } from './query';

/**
 * The search session: one search at a time, from a submitted input to the
 * machine flying to the page that holds it.
 *
 * DOM-free, so that its rules are unit-tested whole; `./search.ts` is the form
 * that drives it and shows its status. The rules are ADR-0032's applied to a
 * request rather than to a page (ADR-0033):
 *
 * 1. **Every submit supersedes the search in flight, accepted or refused.** The
 *    pending request is cancelled before the new input is judged, so a refused
 *    submit leaves nothing in flight, and the user reading a refusal is not
 *    flown away by the reply to the query before it.
 * 2. **A reply acts only if its request is still the current one**, compared by
 *    identity and never by the query's text: two submits of the same text are
 *    two searches with two random offsets. Unlike the reader's `accept`, a hit
 *    has no "right text" that would make a superseded reply acceptable, so any
 *    superseded reply, success or failure, is a non-event.
 * 3. **A navigation event the session did not dispatch supersedes the search.**
 *    The latest intent wins, as in ADR-0030: a spine clicked while a search is
 *    in flight is not undone by its reply.
 * 4. **On a hit**, the route is computed, then the highlight is set, then the
 *    route is dispatched with `dispatchAll`, one notification.
 * 5. **The highlight is a pure function of the machine's address and the last
 *    hit** (`./highlight.ts`).
 * 6. **A failure is reported as a kind, never as an error's message.** A `core`
 *    error can carry the raw characters it refused, and the panel shows a
 *    fixed string from its own `TEXT` table.
 * 7. **Every search promise is handled**, superseded or not: both branches are
 *    attached at issue, so a superseded rejection is a non-event rather than
 *    an unhandled rejection. The identity check, not the error's class, decides
 *    what a settlement means, so a superseded request that failed is as silent
 *    as a cancelled one.
 * 8. **A hit the machine refuses ends in the failure status, and nothing else
 *    is caught.** See `takeHit`.
 */

/** Where the worker placed a query: what `GenerationClient.search` resolves to. */
export interface SearchHit {
  readonly address: Address;
  readonly offset: number;
}

/**
 * What the session needs of `@worker/client`'s `GenerationClient`, which
 * satisfies it structurally, as the reader takes `BookSource`.
 */
export interface SearchSource {
  search(query: string, mode: PadMode): GenerationRequest<SearchHit>;
}

/** What the panel shows. */
export type SearchStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'searching' }
  | { readonly kind: 'refused'; readonly refusal: QueryRefusal }
  | { readonly kind: 'found'; readonly hit: Hit }
  | { readonly kind: 'failed' };

export interface SearchSessionOptions {
  /** The machine a hit is dispatched to, and watched for events it did not cause. */
  readonly navigation: Navigation;
  /** Where searches go. */
  readonly source: SearchSource;
  /** Where the last hit is kept for the reader, shared with it. */
  readonly highlight: Highlight;
}

export interface SearchSession {
  readonly status: SearchStatus;
  /**
   * Judge `input` and, if it is accepted, search for it under `mode`.
   *
   * Resolves once the search has been dealt with, including when it was
   * refused, failed or superseded. It **rejects** only when something outside
   * the session's rules threw while the hit was handled: a listener of the
   * machine, or a route computation failing in a way no address can. That is
   * a bug, and the promise is left for the caller to let reach the console.
   */
  submit(input: string, mode: PadMode): Promise<void>;
  /** Watch the status. Returns the function that stops watching. */
  subscribe(listener: (status: SearchStatus) => void): () => void;
  /** Whether no search is in flight. */
  isIdle(): boolean;
  /** Resolves the next time no search is in flight. */
  whenIdle(): Promise<void>;
  /** Stop watching the machine and abandon the search in flight. */
  dispose(): void;
}

export function createSearchSession(options: SearchSessionOptions): SearchSession {
  const { navigation, source, highlight } = options;

  let status: SearchStatus = { kind: 'idle' };
  let pending: GenerationRequest<SearchHit> | null = null;
  const listeners = new Set<(status: SearchStatus) => void>();
  const idleWaiters: (() => void)[] = [];

  // Rule 3. The session's own dispatch reaches this listener too, and passes
  // through it: `takeHit` has already let go of its request by then, so there
  // is nothing pending for it to cancel.
  const unsubscribe = navigation.subscribe(() => {
    if (pending !== null) {
      supersede();
      show({ kind: 'idle' });
    }
  });

  const session: SearchSession = {
    get status(): SearchStatus {
      return status;
    },

    submit(input: string, mode: PadMode): Promise<void> {
      supersede();
      const verdict = judgeQuery(input);
      if (!verdict.isAccepted) {
        show({ kind: 'refused', refusal: verdict.refusal });
        return Promise.resolve();
      }
      const query = verdict.query;
      const request = source.search(query, mode);
      pending = request;
      show({ kind: 'searching' });
      return request.result.then(
        (hit) => {
          takeHit(request, query, hit);
        },
        () => {
          takeFailure(request);
        }
      );
    },

    subscribe(listener: (status: SearchStatus) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    isIdle(): boolean {
      return pending === null;
    },

    whenIdle(): Promise<void> {
      if (session.isIdle()) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },

    dispose(): void {
      unsubscribe();
      supersede();
      listeners.clear();
    },
  };

  return session;

  /**
   * Act on a hit, if its request is still the current one.
   *
   * **Two steps, and only the first is inside the `try`** (rule 8). The worker
   * narrows a `found` address by shape and not by range, as it does for
   * `located`, so a divergent worker could answer with a room past the end of
   * the library; the route computation is where that surfaces, as one of
   * `core`'s or `state`'s address errors, and those three classes, and only
   * those, end in the failure status. Anything else from the route is a bug
   * and is rethrown.
   *
   * The highlight and the dispatch are outside it on purpose. `dispatchAll`
   * commits the state and then runs every listener synchronously, so a `catch`
   * around it would report a listener's bug as "search failed" with the
   * machine already moved, skip the listeners after it, and keep the error off
   * the console. It propagates instead, through the promise `submit` returned.
   */
  function takeHit(
    from: GenerationRequest<SearchHit>,
    query: string,
    found: SearchHit
  ): void {
    if (pending !== from) {
      return;
    }
    settle();
    let route: readonly NavigationEvent[];
    try {
      route = eventsTo(navigation.state, atPageAddress(found.address));
    } catch (error: unknown) {
      if (!isRefusedAddress(error)) {
        throw error;
      }
      show({ kind: 'failed' });
      return;
    }
    const hit: Hit = {
      address: found.address,
      offset: found.offset,
      length: Array.from(query).length,
    };
    highlight.set(hit);
    show({ kind: 'found', hit });
    navigation.dispatchAll(route);
  }

  /** A search that did not arrive, if it is still the current one. */
  function takeFailure(from: GenerationRequest<SearchHit>): void {
    if (pending !== from) {
      return;
    }
    settle();
    show({ kind: 'failed' });
  }

  /** Abandon the search in flight, if there is one (rules 1 and 3). */
  function supersede(): void {
    const abandoned = pending;
    if (abandoned === null) {
      return;
    }
    // Let go of it first, so its rejection, whenever it runs, is superseded.
    settle();
    abandoned.cancel();
  }

  /** Nothing is in flight any more. */
  function settle(): void {
    pending = null;
    for (const resolve of idleWaiters.splice(0)) {
      resolve();
    }
  }

  function show(next: SearchStatus): void {
    status = next;
    for (const listener of listeners) {
      listener(next);
    }
  }
}

/** The address errors a refused hit surfaces as, and nothing else (rule 8). */
function isRefusedAddress(error: unknown): boolean {
  return (
    error instanceof InvalidAddressError ||
    error instanceof AddressBeyondLibraryError ||
    error instanceof NonIntegerComponentError
  );
}
