import type { Address, BookAddress } from '@core/address';
import type { PadMode } from '@core/library';

/**
 * The wire format between the worker client and the worker (SPEC §6).
 *
 * This module is types and constants only: no behaviour, so that the format can
 * be read in one sitting and reviewed against the protocol it claims to be. The
 * handler that answers these messages is `./handler.ts`.
 *
 * Two properties shape everything below.
 *
 * **One address per request.** A request names exactly one page, title, page
 * text or search query. The shelf-level call that fans out over 32 titles
 * belongs to the client, not to the format: flying past a shelf must abandon
 * the titles not yet computed, and a batch message cannot express the
 * cancellation of part of itself without inventing a second addressing scheme
 * inside the payload. One address per request also means one `core` call per
 * message, which is what lets the worker's message loop yield between them — a
 * worker that computes a whole shelf in one blocking loop cannot read a
 * cancellation at all.
 *
 * **Every message earns exactly one response.** Not zero, which leaves a
 * pending promise with nothing to settle it (ADR-0016), and not two, which
 * makes the client's bookkeeping ambiguous. Malformed payloads and cancelled
 * ids are answered rather than dropped, and that is the whole reason the
 * response union below is wider than the four results a caller actually wants.
 */

/**
 * A request id: an integer the client owns and increments.
 *
 * Monotonic and client-owned, never a timestamp and never random.
 * `architecture.md` §5 keeps `Date.now()` and `Math.random()` off the
 * generation path, and the boundary does not end that constraint — a protocol
 * keyed by timestamps is one whose test suite cannot replay a session, and two
 * requests issued inside the same millisecond would collide.
 *
 * The alias carries no nominal typing: a `number` is what crosses
 * `postMessage`, and pretending otherwise would need an assertion to construct.
 * The contract is enforced at runtime by `isRequestId` in `./handler.ts`
 * instead, which is where untrusted data is narrowed anyway.
 */
export type RequestId = number;

/**
 * The smallest id a client may issue.
 *
 * Ids start at 1 so that 0 can mean "no id has been seen yet" in the handler's
 * watermark without a second field to distinguish the two, and so that a
 * payload carrying an uninitialised numeric field is rejected rather than
 * silently treated as the first request of the session.
 */
export const FIRST_REQUEST_ID = 1;

/** The text of one page at one address. */
export interface PageRequest {
  kind: 'page';
  id: RequestId;
  address: Address;
}

/** The title of one volume: the first 25 characters of its page 0 (SPEC §5). */
export interface TitleRequest {
  kind: 'title';
  id: RequestId;
  book: BookAddress;
}

/** The address of a page of text — the inverse direction of the bijection. */
export interface LocateRequest {
  kind: 'locate';
  id: RequestId;
  page: string;
}

/**
 * Find a page that holds `query`, padded under `mode` (SPEC §5, ADR-0033).
 *
 * There is deliberately no `offset`. No caller chooses one, so the worker
 * draws it from its own random source, and a payload that sends one is
 * refused by name in `./handler.ts` rather than silently ignored: its sender
 * believes the offset will be honoured.
 */
export interface SearchRequest {
  kind: 'search';
  id: RequestId;
  query: string;
  mode: PadMode;
}

/**
 * Abandon the request with this id.
 *
 * It names an id rather than an address because the client cancels what it
 * issued, and the same address may be in flight under two ids while a camera
 * passes a shelf twice.
 *
 * A cancel may legitimately arrive *before* the request it names. A client that
 * posts cancels down the same channel as requests has queued them behind the
 * work it is trying to abandon — 32 titles is about 122 ms of computation, so
 * the cancel would land long after the last title it was meant to prevent.
 * Giving cancels a channel that overtakes the queue is the design that makes
 * cancellation worth having, and it is what makes the out-of-order cases in the
 * handler ordinary rather than theoretical.
 */
export interface CancelRequest {
  kind: 'cancel';
  id: RequestId;
}

/** A message that asks for work. */
export type ProtocolRequest =
  PageRequest | TitleRequest | LocateRequest | SearchRequest;

/** Everything the worker accepts. */
export type ProtocolMessage = ProtocolRequest | CancelRequest;

/** The discriminant of `ProtocolMessage`, derived so the two cannot drift. */
export type MessageKind = ProtocolMessage['kind'];

/** The page text for a `PageRequest`: always exactly `PAGE_LENGTH` characters. */
export interface PageResponse {
  kind: 'page';
  id: RequestId;
  text: string;
}

/** The title for a `TitleRequest`: always exactly `TITLE_LENGTH` characters. */
export interface TitleResponse {
  kind: 'title';
  id: RequestId;
  title: string;
}

/**
 * The address for a `LocateRequest`.
 *
 * `address.room` is a `bigint`, and it crosses `postMessage` as one:
 * structured clone carries `bigint` natively, which is the only reason this
 * protocol can name a room at all. `Number(room)` on a 4975-digit value is
 * `Infinity` (`code-style.md` §1), so there is no number-shaped fallback.
 */
export interface LocatedResponse {
  kind: 'located';
  id: RequestId;
  address: Address;
}

/**
 * Where a `SearchRequest`'s query was placed: the address of the page, and the
 * code-point index into it where the query starts.
 *
 * `offset` is narrowed by the client against the request it answers, not
 * against the page alone: a query of `n` code points can only start at
 * `0` to `PAGE_LENGTH - n` (`takeFound` in `./client.ts`).
 */
export interface FoundResponse {
  kind: 'found';
  id: RequestId;
  address: Address;
  offset: number;
}

/**
 * What a `cancel` met when it arrived. Total over the three states an id can be
 * in when it is cancelled, so the client never has to guess.
 *
 * - `pre-emptive` — the request has not reached the worker yet. It will be
 *   answered with `dropped` when it arrives, and no `core` call will run for it.
 * - `already-cancelled` — a second cancel for an id already cancelled
 *   pre-emptively. Idempotent, and said out loud rather than ignored.
 * - `reply-in-flight` — **the cancellation race.** The one response this id
 *   will ever get was already produced; it is in flight or already delivered.
 *   The client must reject its pending promise per ADR-0016 and ignore the
 *   result when it lands, rather than caching it. The honest assumption is that
 *   the reply is already on its way whenever a cancel is posted, so this is the
 *   normal case for a shelf that is only half computed, not an edge case.
 */
export type CancelDisposition = 'pre-emptive' | 'already-cancelled' | 'reply-in-flight';

/** The answer to a `cancel`. */
export interface CancelAckResponse {
  kind: 'cancel-ack';
  id: RequestId;
  disposition: CancelDisposition;
}

/**
 * A request whose id had already been cancelled, refused without calling
 * `core`.
 *
 * It carries the whole request rather than just the id so the client has the
 * address — or the page text, for a `locate` — that ADR-0016 requires its
 * rejection to name, without having to still hold the request it cancelled.
 */
export interface DroppedResponse {
  kind: 'dropped';
  id: RequestId;
  request: ProtocolRequest;
}

/**
 * A request whose id is not greater than the highest one the handler has
 * already seen: a replay, or a client that broke its own monotonicity.
 *
 * It is refused rather than computed, because the one response for that id has
 * already gone out and the client has nothing left pending to receive a second.
 * `highestIdSeen` is reported so the client can see how far behind the message
 * was instead of inferring it.
 */
export interface StaleResponse {
  kind: 'stale';
  id: RequestId;
  highestIdSeen: RequestId;
}

/**
 * A domain error from `core`, flattened for the wire.
 *
 * `core`'s errors are named classes carrying context (`code-style.md` §4), and
 * none of that survives `postMessage`: structured clone reduces an `Error`
 * subclass to a plain `Error` and drops its own properties, so an
 * `InvalidAddressError` would arrive as an `Error` with no `component`. The
 * name is therefore carried as data and the client reconstructs its own error
 * from it.
 */
export interface SerializedError {
  name: string;
  message: string;
}

/** A well-formed request whose `core` call threw. */
export interface FailedResponse {
  kind: 'failed';
  id: RequestId;
  error: SerializedError;
}

/**
 * Why a payload is not a message. Named cases rather than one "invalid input",
 * because each is a different mistake at the call site and a client that cannot
 * tell them apart cannot report which (`code-style.md` §4).
 *
 * - `not-an-object` — `null`, `undefined`, a primitive or a function.
 * - `array-payload` — an array. An object by `typeof`, never a message.
 * - `missing-kind` — no `kind` property, or a `kind` that is not a string.
 * - `unknown-kind` — a string `kind` that names none of the five messages.
 * - `invalid-id` — no `id`, or an `id` that is not an integer `>= 1`.
 * - `malformed-address` — the `address` or `book` is absent or misshapen.
 * - `malformed-page` — a `locate` whose `page` is absent or not a string.
 * - `malformed-search` — a `search` whose `query` is not a string, or whose
 *   `mode` names neither of the two pad modes.
 * - `unexpected-field` — a field the message must not carry, which means the
 *   sender has the wrong idea of what the message is.
 */
export type ProtocolFault =
  | 'not-an-object'
  | 'array-payload'
  | 'missing-kind'
  | 'unknown-kind'
  | 'invalid-id'
  | 'malformed-address'
  | 'malformed-page'
  | 'malformed-search'
  | 'unexpected-field';

/**
 * A payload that is not a message of this protocol.
 *
 * `id` is the request id when it could be narrowed and `null` when it could
 * not. It is reported even when the fault lies elsewhere — a client that sent a
 * misshapen `address` under a perfectly good id still has a promise pending on
 * that id, and leaving it unnamed here would be the hang ADR-0016 exists to
 * prevent.
 *
 * `detail` names the offending field and what was wrong with it. The offending
 * value itself is not echoed back: it is untrusted, it can be arbitrarily
 * large, and the field name is what a caller needs in order to fix the call.
 */
export interface ProtocolErrorResponse {
  kind: 'protocol-error';
  id: RequestId | null;
  fault: ProtocolFault;
  detail: string;
}

/** Everything the worker sends. */
export type ProtocolResponse =
  | PageResponse
  | TitleResponse
  | LocatedResponse
  | FoundResponse
  | CancelAckResponse
  | DroppedResponse
  | StaleResponse
  | FailedResponse
  | ProtocolErrorResponse;

/** The discriminant of `ProtocolResponse`, derived so the two cannot drift. */
export type ResponseKind = ProtocolResponse['kind'];
