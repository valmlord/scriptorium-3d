import { getPage, getTitle, locate } from '@core/index';
import type { BookAddress } from '@core/index';
import { FIRST_REQUEST_ID } from './protocol';
import type {
  CancelDisposition,
  CancelRequest,
  MessageKind,
  ProtocolFault,
  ProtocolMessage,
  ProtocolRequest,
  ProtocolResponse,
  RequestId,
  SerializedError,
} from './protocol';

/**
 * The worker's protocol handler: one `postMessage` payload in, one response and
 * the next handler state out.
 *
 * It is a **pure function**. Nothing is posted, nothing is mutated — not the
 * payload, not the state passed in — and no clock or random source is read, so
 * the same payload against the same state always produces the same outcome.
 * That is what lets every case below be a unit test instead of an assertion
 * about a thread, and it is why the state is an argument rather than a
 * module-level variable: the thing that owns the `MessagePort` owns the state,
 * and the handler only computes.
 *
 * **Totality.** The payload arrives as `unknown`. It is untrusted data crossing
 * a boundary, so it is narrowed at runtime rather than declared
 * (`code-style.md` §1): no `as`, no `any`. Every shape it can take is answered
 * explicitly, never silently ignored (`architecture.md` §4) — malformed
 * payloads become a `protocol-error`, unrecognised kinds become
 * `unknown-kind`, cancelled ids become `dropped`, and replayed ids become
 * `stale`. The one case §4 would have thrown for, an unhandled kind, cannot
 * reach the runtime at all: the dispatch switches are exhaustive over the
 * message union with no `default`, so adding a kind without handling it fails
 * to compile. A `throw` here would be worse than useless — it escapes
 * `onmessage` with no id attached, leaving the client's promise with nothing to
 * settle it, which is exactly the hang ADR-0016 exists to prevent.
 *
 * **Order.** Ids are client-owned and monotonic, so the handler needs only a
 * watermark and the set of ids cancelled ahead of their request, both in
 * `ProtocolHandlerState`. It does not keep a record of every id it has ever
 * answered: that set grows for as long as the camera moves, and cancellation
 * exists here precisely because the camera never stops.
 */

/** The watermark's value before any request has been seen. */
const NO_ID_SEEN = 0;

/**
 * What the handler must remember between messages.
 *
 * Invariant, maintained by every transition below: **every id in
 * `cancelledIds` is strictly greater than `highestIdSeen`.** A cancel is only
 * recorded for an id above the watermark, and advancing the watermark drops
 * every cancelled id it passes. That is what bounds the set — it holds at most
 * one entry per request still in flight toward the worker — and it is why
 * advancing the watermark is always a strict increase.
 */
export interface ProtocolHandlerState {
  /** The highest request id answered so far; `0` before the first one. */
  readonly highestIdSeen: RequestId;
  /** Ids cancelled before their request arrived, so it can be dropped. */
  readonly cancelledIds: ReadonlySet<RequestId>;
}

/** Exactly one response, and the state the next message should be handled in. */
export interface ProtocolHandlerOutcome {
  readonly state: ProtocolHandlerState;
  readonly response: ProtocolResponse;
}

/**
 * The state a worker starts in.
 *
 * A function rather than a frozen constant: the state holds a `Set`, and a
 * shared instance would be one object two tests could disagree about even
 * though neither of them writes to it.
 */
export function createProtocolHandlerState(): ProtocolHandlerState {
  return { highestIdSeen: NO_ID_SEEN, cancelledIds: new Set() };
}

/**
 * Answer one payload.
 *
 * The payload is whatever `postMessage` delivered. The returned state replaces
 * the one passed in; the one passed in is left untouched.
 */
export function handleProtocolMessage(
  payload: unknown,
  state: ProtocolHandlerState
): ProtocolHandlerOutcome {
  const parsed = parseProtocolMessage(payload);
  if (!parsed.ok) {
    return {
      state,
      response: {
        kind: 'protocol-error',
        id: parsed.id,
        fault: parsed.fault,
        detail: parsed.detail,
      },
    };
  }
  // Narrowing `cancel` away leaves `ProtocolRequest`. If a kind is ever added
  // to `ProtocolMessage` without being added to one of the two unions, this
  // call stops type-checking — the exhaustiveness gate, paid for at compile
  // time rather than as an unreachable `throw` nobody can test.
  if (parsed.message.kind === 'cancel') {
    return handleCancel(parsed.message, state);
  }
  return handleRequest(parsed.message, state);
}

/**
 * A cancel meets the id in one of exactly three states, and says which.
 *
 * The third is the race: by the time a cancel is posted, the reply it is trying
 * to prevent has usually already been computed and sent. The handler cannot
 * unsend it, so it says so — `reply-in-flight` is what makes a late reply to a
 * cancelled id expressible, and therefore ignorable by the client (ADR-0016).
 */
function handleCancel(
  message: CancelRequest,
  state: ProtocolHandlerState
): ProtocolHandlerOutcome {
  const { id } = message;
  if (state.cancelledIds.has(id)) {
    return { state, response: cancelAck(id, 'already-cancelled') };
  }
  if (id <= state.highestIdSeen) {
    return { state, response: cancelAck(id, 'reply-in-flight') };
  }
  // The request has not arrived. The watermark deliberately does not move: it
  // marks what has been answered, and nothing has been answered for this id.
  const cancelledIds = new Set(state.cancelledIds);
  cancelledIds.add(id);
  return {
    state: { highestIdSeen: state.highestIdSeen, cancelledIds },
    response: cancelAck(id, 'pre-emptive'),
  };
}

/** A request is dropped, refused as stale, or computed. */
function handleRequest(
  message: ProtocolRequest,
  state: ProtocolHandlerState
): ProtocolHandlerOutcome {
  const { id } = message;
  // These two branches cannot both apply: the state invariant keeps every
  // cancelled id above the watermark, so an id is at most one of cancelled and
  // stale. Swapping them changes no behaviour — verified by swapping them and
  // watching the suite stay green — so the order is for the reader, and the
  // case the protocol exists for comes first.
  if (state.cancelledIds.has(id)) {
    return {
      state: advance(state, id),
      response: { kind: 'dropped', id, request: message },
    };
  }
  if (id <= state.highestIdSeen) {
    return {
      state,
      response: { kind: 'stale', id, highestIdSeen: state.highestIdSeen },
    };
  }
  return { state: advance(state, id), response: computeResponse(message) };
}

/**
 * Move the watermark to `id` and forget every cancelled id it passes.
 *
 * `id` is strictly greater than `highestIdSeen` on both paths that call this —
 * one checks it, the other has it from the state invariant — so this never
 * walks the watermark backwards. A cancelled id at or below the new watermark
 * can no longer be met by a request, because such a request would now be
 * `stale`, so keeping it would only grow the set.
 */
function advance(state: ProtocolHandlerState, id: RequestId): ProtocolHandlerState {
  const cancelledIds = new Set<RequestId>();
  for (const cancelled of state.cancelledIds) {
    if (cancelled > id) {
      cancelledIds.add(cancelled);
    }
  }
  return { highestIdSeen: id, cancelledIds };
}

/**
 * Call `core` and shape the answer.
 *
 * Every throw becomes a `failed` response rather than escaping: the client has
 * a promise pending on this id, and the only way to settle it is to answer.
 * The error's own name is carried through, so a genuine bug in `core` arrives
 * at the call site as the `TypeError` it was rather than being flattened into
 * something indistinguishable from an out-of-range address.
 *
 * The switch has no `default`: it is exhaustive over `ProtocolRequest`, and a
 * fourth request kind would make this function stop returning on every path,
 * which is a compile error rather than a silently unanswered message.
 */
function computeResponse(message: ProtocolRequest): ProtocolResponse {
  try {
    switch (message.kind) {
      case 'page':
        return { kind: 'page', id: message.id, text: getPage(message.address) };
      case 'title':
        return { kind: 'title', id: message.id, title: getTitle(message.book) };
      case 'locate':
        return { kind: 'located', id: message.id, address: locate(message.page) };
    }
  } catch (thrown: unknown) {
    return { kind: 'failed', id: message.id, error: serializeThrown(thrown) };
  }
}

function cancelAck(id: RequestId, disposition: CancelDisposition): ProtocolResponse {
  return { kind: 'cancel-ack', id, disposition };
}

/**
 * Flatten a thrown value for the wire.
 *
 * `core`'s named error classes do not survive structured clone — it reduces a
 * subclass to a plain `Error` and drops its own fields — so the name travels as
 * data. A non-`Error` throw is still answered, because `throw 'oops'` is legal
 * JavaScript and an unanswered id is a hang.
 */
function serializeThrown(thrown: unknown): SerializedError {
  if (thrown instanceof Error) {
    return { name: thrown.name, message: thrown.message };
  }
  return {
    name: 'NonErrorThrown',
    message: `A value of type ${typeof thrown} was thrown`,
  };
}

/** A payload successfully narrowed to a message, or the reason it was not. */
type ParseResult =
  | { readonly ok: true; readonly message: ProtocolMessage }
  | {
      readonly ok: false;
      readonly id: RequestId | null;
      readonly fault: ProtocolFault;
      readonly detail: string;
    };

/**
 * Narrow an arbitrary payload to a message of this protocol.
 *
 * Unknown *extra* properties are ignored on purpose: rejecting them would make
 * adding an optional field to any message a breaking change for every older
 * client. The one exception is `book.page` — not an unknown field but a known
 * one in the wrong message, which means the sender has the wrong idea of what a
 * title is, and ignoring that would be the silent acceptance
 * `architecture.md` §4 rules out.
 */
function parseProtocolMessage(payload: unknown): ParseResult {
  if (Array.isArray(payload)) {
    return failure(null, 'array-payload', 'an array is not a message');
  }
  if (!isRecord(payload)) {
    return failure(
      null,
      'not-an-object',
      `a message must be an object, received ${describe(payload)}`
    );
  }
  // The id is narrowed independently of everything else, so that a payload
  // whose id is sound but whose body is not still names the promise it leaves
  // the client holding. Without it, every fault below would be a hang.
  const id = knownId(payload.id);
  const kind: unknown = payload.kind;
  if (typeof kind !== 'string') {
    return failure(
      id,
      'missing-kind',
      `'kind' must be a string, received ${describe(kind)}`
    );
  }
  if (!isMessageKind(kind)) {
    return failure(id, 'unknown-kind', `'kind' names no message of this protocol`);
  }
  if (id === null) {
    return failure(
      null,
      'invalid-id',
      `'id' must be an integer >= ${String(FIRST_REQUEST_ID)}, received ${describe(payload.id)}`
    );
  }
  switch (kind) {
    case 'cancel':
      return { ok: true, message: { kind: 'cancel', id } };
    case 'page':
      return parsePageRequest(id, payload.address);
    case 'title':
      return parseTitleRequest(id, payload.book);
    case 'locate':
      return parseLocateRequest(id, payload.page);
  }
}

function parsePageRequest(id: RequestId, address: unknown): ParseResult {
  if (!isRecord(address)) {
    return failure(id, 'malformed-address', notAnObject('address', address));
  }
  const book = parseBookAddress(address, 'address');
  if (!book.ok) {
    return failure(id, 'malformed-address', book.detail);
  }
  const page: unknown = address.page;
  if (!isAddressComponent(page)) {
    return failure(
      id,
      'malformed-address',
      `'address.page' must be an integer, received ${describe(page)}`
    );
  }
  return { ok: true, message: { kind: 'page', id, address: { ...book.book, page } } };
}

function parseTitleRequest(id: RequestId, book: unknown): ParseResult {
  if (!isRecord(book)) {
    return failure(id, 'malformed-address', notAnObject('book', book));
  }
  if (Object.hasOwn(book, 'page')) {
    return failure(
      id,
      'unexpected-field',
      `'book.page' is not part of a title: a title is the opening of page 0`
    );
  }
  const parsed = parseBookAddress(book, 'book');
  if (!parsed.ok) {
    return failure(id, 'malformed-address', parsed.detail);
  }
  return { ok: true, message: { kind: 'title', id, book: parsed.book } };
}

function parseLocateRequest(id: RequestId, page: unknown): ParseResult {
  if (typeof page !== 'string') {
    return failure(
      id,
      'malformed-page',
      `'page' must be a string, received ${describe(page)}`
    );
  }
  return { ok: true, message: { kind: 'locate', id, page } };
}

type BookParse =
  | { readonly ok: true; readonly book: BookAddress }
  | { readonly ok: false; readonly detail: string };

/**
 * Narrow the four components a volume is identified by.
 *
 * Shape only: `room` is a `bigint` and the rest are integers, and nothing here
 * checks a range. Ranges belong to `core` — `assertValidAddress` owns them and
 * reports which component and which bound with an `InvalidAddressError`
 * (SPEC §3). Repeating those bounds here would be a second copy of the SPEC to
 * keep in step, and it would turn a domain answer the client can show a user
 * into a protocol complaint about a well-formed message.
 */
function parseBookAddress(value: Record<string, unknown>, field: string): BookParse {
  const { room, wall, shelf, volume } = value;
  if (typeof room !== 'bigint') {
    return {
      ok: false,
      detail: `'${field}.room' must be a bigint, received ${describe(room)}`,
    };
  }
  if (!isAddressComponent(wall)) {
    return {
      ok: false,
      detail: `'${field}.wall' must be an integer, received ${describe(wall)}`,
    };
  }
  if (!isAddressComponent(shelf)) {
    return {
      ok: false,
      detail: `'${field}.shelf' must be an integer, received ${describe(shelf)}`,
    };
  }
  if (!isAddressComponent(volume)) {
    return {
      ok: false,
      detail: `'${field}.volume' must be an integer, received ${describe(volume)}`,
    };
  }
  return { ok: true, book: { room, wall, shelf, volume } };
}

/**
 * The kinds this protocol recognises.
 *
 * Keyed by `MessageKind` so the table cannot drift from the union: adding a
 * message without listing it here does not compile.
 */
const KNOWN_KINDS: Record<MessageKind, true> = {
  page: true,
  title: true,
  locate: true,
  cancel: true,
};

/**
 * `Object.hasOwn` rather than `in` or a truthiness read: `'constructor'` and
 * `'__proto__'` are reachable through the prototype chain and are not kinds.
 */
function isMessageKind(value: string): value is MessageKind {
  return Object.hasOwn(KNOWN_KINDS, value);
}

/**
 * A request id, or `null` when the payload does not carry one.
 *
 * `Number.isSafeInteger` is the whole check: it rejects `NaN`, both
 * infinities, a fraction, and an integer past 2^53 where `+ 1` stops being
 * distinguishable — which would silently break the monotonicity the protocol
 * is ordered by.
 */
function knownId(value: unknown): RequestId | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return null;
  }
  return value >= FIRST_REQUEST_ID ? value : null;
}

function isAddressComponent(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** An array is an object by `typeof` and is never a message. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Name a value's type for an error message. The value itself is never echoed:
 * it is untrusted, it can be arbitrarily large, and the type is what tells the
 * caller what to fix.
 */
function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return typeof value;
}

function notAnObject(field: string, value: unknown): string {
  return `'${field}' must be an object, received ${describe(value)}`;
}

function failure(
  id: RequestId | null,
  fault: ProtocolFault,
  detail: string
): ParseResult {
  return { ok: false, id, fault, detail };
}
