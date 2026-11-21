import type {
  ProtocolFault,
  ProtocolRequest,
  RequestId,
  SerializedError,
} from './protocol';

/**
 * Dedicated error types for the ways a generation request can end without a
 * result, in the pattern of `src/core/errors.ts`: a named class per domain
 * situation, each carrying the fields a caller needs to act on it
 * (`code-style.md` §4).
 *
 * **Why the client has errors of its own at all.** `core`'s named classes do
 * not survive `postMessage` — structured clone reduces an `Error` subclass to
 * a plain `Error` and drops its own properties — so the protocol carries the
 * name as data (`SerializedError`) and the client rebuilds a typed failure on
 * this side of the boundary. And three of the situations below have no `core`
 * equivalent at all: a request can be cancelled, refused as stale, or refused
 * as malformed without `core` ever being called.
 *
 * **Why none of them renders the address into the message.** `code-style.md`
 * §4 asks an error message to carry context, and every one of these carries
 * the whole request as a field. What they do not do is print it: a room is a
 * `bigint` of up to `PAGE_LENGTH` base-36 digits, and the `page` of a `locate`
 * is 3200 characters. A cancelled shelf rejects 32 promises at once, so
 * rendering each one's address would turn abandoning a shelf into 100 000
 * characters of string building — on the thread whose frame budget is the
 * reason the worker exists. The `request` field holds all of it, losslessly,
 * for whatever actually wants to display it.
 *
 * These are flat classes rather than a family under one base. A caller
 * distinguishes them by `instanceof` on the one it cares about —
 * `CancelledRequestError` is the only expected outcome among them, the rest
 * being bugs on one side of the boundary or the other — and a shared base
 * class would invite a single `catch` that treats a cancelled shelf and a
 * broken protocol as the same event.
 */

/**
 * The request was cancelled before its result was used (ADR-0016).
 *
 * This is the one error here that is not a bug: flying past a shelf abandons
 * the titles not yet computed, and that is what cancellation is for. It
 * rejects rather than leaving the promise unsettled, because a promise that
 * never settles is a retained continuation per cancellation on a camera that
 * never stops — and it cannot be awaited in a test without a timeout, which is
 * how "asserted by outcome" quietly becomes a sleep.
 *
 * The result of a cancelled request never reaches the cache, whether the
 * worker dropped it before computing it or had already sent it when the cancel
 * arrived.
 */
export class CancelledRequestError extends Error {
  readonly id: RequestId;
  readonly request: ProtocolRequest;

  constructor(id: RequestId, request: ProtocolRequest) {
    super(
      `Generation request ${String(id)} for ${describeRequest(request)} was cancelled`
    );
    this.name = 'CancelledRequestError';
    this.id = id;
    this.request = request;
  }
}

/**
 * `core` threw for a well-formed request: an address past the end of the
 * library, a page of the wrong length, a symbol outside the alphabet.
 *
 * The thrown value's own name and message are carried through rather than
 * flattened, so a genuine bug in `core` arrives here as the `TypeError` it was
 * instead of being indistinguishable from an out-of-range address. `cause` is
 * the standard `Error` field for exactly this and is set as well as being
 * exposed under its own name, so a caller that already walks `cause` chains
 * finds it there.
 */
export class GenerationFailedError extends Error {
  readonly id: RequestId;
  readonly request: ProtocolRequest;
  readonly thrown: SerializedError;

  constructor(id: RequestId, request: ProtocolRequest, thrown: SerializedError) {
    super(
      `Generation request ${String(id)} for ${describeRequest(request)} failed in core: ${thrown.name}: ${thrown.message}`,
      { cause: thrown }
    );
    this.name = 'GenerationFailedError';
    this.id = id;
    this.request = request;
    this.thrown = thrown;
  }
}

/**
 * The worker refused a request whose id was not above the highest it had
 * already answered.
 *
 * A bug on this side: ids are client-owned and monotonic (`architecture.md`
 * §5), so the client is the only thing that can produce a stale one. It is an
 * error rather than a retry because the id's one response has already gone
 * out, and reissuing the same id would be refused the same way. `highestIdSeen`
 * is carried so a report says how far behind the request was rather than
 * leaving it to be inferred.
 */
export class StaleRequestError extends Error {
  readonly id: RequestId;
  readonly request: ProtocolRequest;
  readonly highestIdSeen: RequestId;

  constructor(id: RequestId, request: ProtocolRequest, highestIdSeen: RequestId) {
    super(
      `Generation request ${String(id)} for ${describeRequest(request)} was refused as stale: the worker has already answered id ${String(highestIdSeen)}`
    );
    this.name = 'StaleRequestError';
    this.id = id;
    this.request = request;
    this.highestIdSeen = highestIdSeen;
  }
}

/**
 * The worker did not recognise the payload as a message of this protocol.
 *
 * Also a bug on this side, and a louder one: the client builds every request
 * it sends from a typed object, so a `protocol-error` means the two modules
 * disagree about the format — a stale worker bundle served from a cache, most
 * plausibly. `fault` and `detail` are the worker's own words for what was
 * wrong, which name the offending field.
 */
export class ProtocolViolationError extends Error {
  readonly id: RequestId;
  readonly request: ProtocolRequest;
  readonly fault: ProtocolFault;
  readonly detail: string;

  constructor(
    id: RequestId,
    request: ProtocolRequest,
    fault: ProtocolFault,
    detail: string
  ) {
    super(
      `Generation request ${String(id)} for ${describeRequest(request)} was refused as ${fault}: ${detail}`
    );
    this.name = 'ProtocolViolationError';
    this.id = id;
    this.request = request;
    this.fault = fault;
    this.detail = detail;
  }
}

/**
 * A message arrived from the worker that is not a response this protocol
 * defines, or is a response of the wrong kind for the request it names — a
 * `title` answering a `page`, for instance.
 *
 * The worker's messages are untrusted data crossing a boundary and are
 * narrowed at runtime rather than declared (`code-style.md` §1). A message
 * that cannot be attributed to a request in flight has nothing to settle and
 * is ignored; this error is what happens when it *can* be attributed, because
 * leaving that promise pending would be the hang ADR-0016 exists to prevent.
 */
export class MalformedResponseError extends Error {
  readonly id: RequestId;
  readonly detail: string;

  constructor(id: RequestId, detail: string) {
    super(`The worker's answer to request ${String(id)} is unusable: ${detail}`);
    this.name = 'MalformedResponseError';
    this.id = id;
    this.detail = detail;
  }
}

/**
 * The worker will not answer: it reported an `error` event, or it was
 * terminated while requests were still in flight.
 *
 * Every request pending at that moment is rejected with one of these, because
 * the protocol's "every message earns exactly one response" is a promise only
 * the worker can keep, and a dead worker keeps nothing. `detail` says which of
 * the two happened.
 */
export class WorkerFailureError extends Error {
  readonly id: RequestId;
  readonly request: ProtocolRequest;
  readonly detail: string;

  constructor(id: RequestId, request: ProtocolRequest, detail: string) {
    super(
      `Generation request ${String(id)} for ${describeRequest(request)} cannot be answered: ${detail}`
    );
    this.name = 'WorkerFailureError';
    this.id = id;
    this.request = request;
    this.detail = detail;
  }
}

/**
 * The worker entry point was loaded somewhere that is not a worker scope.
 *
 * It narrows `globalThis` at runtime instead of declaring it, so that the
 * entry module type-checks under this project's DOM lib without a `lib`
 * reference that would redeclare half of it — and so that importing the entry
 * on the main thread fails loudly instead of installing a message listener on
 * the window.
 */
export class WorkerScopeUnavailableError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`The worker entry point was loaded outside a worker scope: ${detail}`);
    this.name = 'WorkerScopeUnavailableError';
    this.detail = detail;
  }
}

/**
 * Name what a request asked for, for an error message.
 *
 * The address is deliberately not rendered — see this module's header. The
 * switch is exhaustive over `ProtocolRequest` with no `default`, so a fifth
 * request kind stops this function returning on every path, which is a compile
 * error rather than an error message that silently says `undefined`.
 *
 * A search is named by its query's length and never by its text. The query is
 * what the user typed, up to `PAGE_LENGTH` symbols of it, and an error message
 * ends up on a console and in a bug report; the `request` field still holds
 * the text for anything that has a reason to show it.
 */
function describeRequest(request: ProtocolRequest): string {
  switch (request.kind) {
    case 'page':
      return 'a page';
    case 'title':
      return 'a title';
    case 'locate':
      return "a page's address";
    case 'search':
      return `a search for a query of ${String(Array.from(request.query).length)} code points`;
  }
}
