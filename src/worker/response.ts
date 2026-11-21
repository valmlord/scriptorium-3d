import { FIRST_REQUEST_ID } from './protocol';
import type {
  CancelAckResponse,
  CancelDisposition,
  DroppedResponse,
  FailedResponse,
  FoundResponse,
  LocatedResponse,
  PageResponse,
  ProtocolErrorResponse,
  ProtocolFault,
  RequestId,
  ResponseKind,
  SerializedError,
  StaleResponse,
  TitleResponse,
} from './protocol';
import type { Address } from '@core/address';

/**
 * Narrowing the other direction of the wire: a payload the worker posted, made
 * into something the client may act on.
 *
 * **Why this exists at all.** A message arriving from the worker is untrusted
 * data crossing a boundary and is validated at runtime, not declared
 * (`code-style.md` §1) — the same rule that makes `handler.ts` narrow its
 * payload from `unknown`. "The worker is our own code" is a promise to the
 * compiler, and the compiler is not what delivers the message: a stale worker
 * bundle served from an HTTP cache after a format change is one real way the
 * two ends disagree, and a `page` response whose `text` is `undefined` would
 * otherwise be cached as a page and rendered as the string `"undefined"`.
 *
 * **Its guards are its own, not `handler.ts`'s.** The handler's equivalents are
 * private, deliberately: the two directions of the format are reviewed
 * separately, and a shared guard module would couple them through something
 * neither owns. The duplication is four predicates of one line each.
 *
 * The narrowed view keeps only the fields the client reads, which is why every
 * member below is a `Pick` of the protocol's own interface rather than a shape
 * written out again. A renamed field or an added response kind stops this
 * module type-checking instead of being silently dropped on arrival.
 */

/**
 * A worker message narrowed to what the client acts on.
 *
 * `dropped` keeps only its id: the protocol carries the whole request so that
 * a client which no longer holds it can still name the address, and this
 * client does still hold it — every request in flight is in its pending table
 * until it settles.
 */
export type IncomingResponse =
  | Pick<PageResponse, 'kind' | 'id' | 'text'>
  | Pick<TitleResponse, 'kind' | 'id' | 'title'>
  | Pick<LocatedResponse, 'kind' | 'id' | 'address'>
  | Pick<FoundResponse, 'kind' | 'id' | 'address' | 'offset'>
  | Pick<CancelAckResponse, 'kind' | 'id' | 'disposition'>
  | Pick<DroppedResponse, 'kind' | 'id'>
  | Pick<StaleResponse, 'kind' | 'id' | 'highestIdSeen'>
  | Pick<FailedResponse, 'kind' | 'id' | 'error'>
  | Pick<ProtocolErrorResponse, 'kind' | 'id' | 'fault' | 'detail'>;

/**
 * A narrowed message, or the reason it could not be narrowed.
 *
 * `id` is reported on failure whenever it could be read, for the same reason
 * `handler.ts` reports it: a malformed message under a sound id still names a
 * promise the client is holding, and leaving it unnamed here would be the hang
 * ADR-0016 exists to prevent. `null` means the message cannot be attributed to
 * anything and there is nothing to settle.
 */
export type ResponseParse =
  | { readonly ok: true; readonly response: IncomingResponse }
  | { readonly ok: false; readonly id: RequestId | null; readonly detail: string };

/**
 * The response kinds this client recognises.
 *
 * Keyed by `ResponseKind` so the table cannot drift from the union: adding a
 * response to the protocol without narrowing it here does not compile.
 */
const KNOWN_RESPONSE_KINDS: Record<ResponseKind, true> = {
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

/** Keyed by `CancelDisposition`, so a fourth disposition does not compile. */
const KNOWN_DISPOSITIONS: Record<CancelDisposition, true> = {
  'pre-emptive': true,
  'already-cancelled': true,
  'reply-in-flight': true,
};

/** Keyed by `ProtocolFault`, so a tenth fault does not compile. */
const KNOWN_FAULTS: Record<ProtocolFault, true> = {
  'not-an-object': true,
  'array-payload': true,
  'missing-kind': true,
  'unknown-kind': true,
  'invalid-id': true,
  'malformed-address': true,
  'malformed-page': true,
  'malformed-search': true,
  'unexpected-field': true,
};

/**
 * Narrow one payload posted by the worker.
 *
 * `protocol-error` is split off before anything else, because it is the one
 * response that may carry no id — it answers a payload whose own id could not
 * be read. Every other kind must name the promise it settles, so the id is
 * narrowed once after that branch and the sub-parsers below take a
 * `RequestId` rather than re-checking it or asserting it away.
 *
 * The dispatch switch is exhaustive over what is left of `ResponseKind` with
 * no `default`, so the compile-time gate the kinds table opens is closed here:
 * a response kind added to the protocol makes this function stop returning on
 * every path.
 */
export function parseProtocolResponse(payload: unknown): ResponseParse {
  if (!isRecord(payload)) {
    return refuse(null, `a response must be an object, received ${describe(payload)}`);
  }
  const id = knownId(payload.id);
  const kind: unknown = payload.kind;
  if (typeof kind !== 'string' || !isResponseKind(kind)) {
    return refuse(id, `'kind' names no response of this protocol`);
  }
  if (kind === 'protocol-error') {
    return parseProtocolError(id, payload.fault, payload.detail);
  }
  if (id === null) {
    return refuse(
      null,
      `'id' must be an integer >= ${String(FIRST_REQUEST_ID)}, received ${describe(payload.id)}`
    );
  }
  switch (kind) {
    case 'page':
      return parseText(id, 'page', 'text', payload.text);
    case 'title':
      return parseText(id, 'title', 'title', payload.title);
    case 'located':
      return parseLocated(id, payload.address);
    case 'found':
      return parseFound(id, payload.address, payload.offset);
    case 'cancel-ack':
      return parseCancelAck(id, payload.disposition);
    case 'dropped':
      return accept({ kind: 'dropped', id });
    case 'stale':
      return parseStale(id, payload.highestIdSeen);
    case 'failed':
      return parseFailed(id, payload.error);
  }
}

/**
 * The `page` and `title` responses differ only in which string field carries
 * the text, so they are narrowed by one function rather than two that would
 * have to be kept in step.
 */
function parseText(
  id: RequestId,
  kind: 'page' | 'title',
  field: 'text' | 'title',
  value: unknown
): ResponseParse {
  if (typeof value !== 'string') {
    return refuse(id, `'${field}' must be a string, received ${describe(value)}`);
  }
  return accept(
    kind === 'page' ? { kind, id, text: value } : { kind, id, title: value }
  );
}

function parseLocated(id: RequestId, address: unknown): ResponseParse {
  const located = parseAddress(address);
  if (!located.ok) {
    return refuse(id, located.detail);
  }
  return accept({ kind: 'located', id, address: located.address });
}

/**
 * Narrow a search hit: the address exactly as for `located`, by shape and not
 * by range, and the offset only as far as being a number.
 *
 * Whether the offset can apply is a question about the request, not the
 * message: a query of `n` code points starts at `0` to `PAGE_LENGTH - n`, and
 * only the client holds the query. So `takeFound` in `./client.ts` bounds it,
 * and this checks no more than that the field is the type the protocol says.
 */
function parseFound(id: RequestId, address: unknown, offset: unknown): ResponseParse {
  const found = parseAddress(address);
  if (!found.ok) {
    return refuse(id, found.detail);
  }
  if (typeof offset !== 'number') {
    return refuse(id, `'offset' must be a number, received ${describe(offset)}`);
  }
  return accept({ kind: 'found', id, address: found.address, offset });
}

type AddressParse =
  | { readonly ok: true; readonly address: Address }
  | { readonly ok: false; readonly detail: string };

/**
 * Narrow the five components of an address, for `located` and `found` alike.
 *
 * Shape only, and no range is checked: ranges belong to `core`, which owns
 * them and reports which component and which bound (SPEC §3). Both responses
 * can only hold an address `core` itself returned, so a range check here would
 * be a second copy of the SPEC guarding against nothing.
 */
function parseAddress(address: unknown): AddressParse {
  if (!isRecord(address)) {
    return {
      ok: false,
      detail: `'address' must be an object, received ${describe(address)}`,
    };
  }
  const { room, wall, shelf, volume, page } = address;
  // A room is a `bigint` and crosses `postMessage` as one; structured clone
  // carries `bigint` natively, which is the only reason this protocol can name
  // a room at all. There is no number-shaped fallback to accept instead:
  // `Number(room)` on a 4975-digit value is `Infinity` (`code-style.md` §1).
  if (typeof room !== 'bigint') {
    return {
      ok: false,
      detail: `'address.room' must be a bigint, received ${describe(room)}`,
    };
  }
  if (!isAddressComponent(wall)) {
    return { ok: false, detail: component('wall', wall) };
  }
  if (!isAddressComponent(shelf)) {
    return { ok: false, detail: component('shelf', shelf) };
  }
  if (!isAddressComponent(volume)) {
    return { ok: false, detail: component('volume', volume) };
  }
  if (!isAddressComponent(page)) {
    return { ok: false, detail: component('page', page) };
  }
  return { ok: true, address: { room, wall, shelf, volume, page } };
}

function parseCancelAck(id: RequestId, disposition: unknown): ResponseParse {
  if (typeof disposition !== 'string' || !isDisposition(disposition)) {
    return refuse(
      id,
      `'disposition' names none of the three a cancel can have, received ${describe(disposition)}`
    );
  }
  return accept({ kind: 'cancel-ack', id, disposition });
}

function parseStale(id: RequestId, highestIdSeen: unknown): ResponseParse {
  const watermark = knownId(highestIdSeen);
  if (watermark === null) {
    return refuse(
      id,
      `'highestIdSeen' must be a request id, received ${describe(highestIdSeen)}`
    );
  }
  return accept({ kind: 'stale', id, highestIdSeen: watermark });
}

function parseFailed(id: RequestId, error: unknown): ResponseParse {
  if (!isRecord(error)) {
    return refuse(id, `'error' must be an object, received ${describe(error)}`);
  }
  const { name, message } = error;
  if (typeof name !== 'string') {
    return refuse(id, `'error.name' must be a string, received ${describe(name)}`);
  }
  if (typeof message !== 'string') {
    return refuse(
      id,
      `'error.message' must be a string, received ${describe(message)}`
    );
  }
  const thrown: SerializedError = { name, message };
  return accept({ kind: 'failed', id, error: thrown });
}

function parseProtocolError(
  id: RequestId | null,
  fault: unknown,
  detail: unknown
): ResponseParse {
  if (typeof fault !== 'string' || !isFault(fault)) {
    return refuse(id, `'fault' names no fault of this protocol`);
  }
  if (typeof detail !== 'string') {
    return refuse(id, `'detail' must be a string, received ${describe(detail)}`);
  }
  return accept({ kind: 'protocol-error', id, fault, detail });
}

function component(name: string, value: unknown): string {
  return `'address.${name}' must be an integer, received ${describe(value)}`;
}

function accept(response: IncomingResponse): ResponseParse {
  return { ok: true, response };
}

function refuse(id: RequestId | null, detail: string): ResponseParse {
  return { ok: false, id, detail };
}

function isResponseKind(value: string): value is ResponseKind {
  return Object.hasOwn(KNOWN_RESPONSE_KINDS, value);
}

function isDisposition(value: string): value is CancelDisposition {
  return Object.hasOwn(KNOWN_DISPOSITIONS, value);
}

function isFault(value: string): value is ProtocolFault {
  return Object.hasOwn(KNOWN_FAULTS, value);
}

/** A request id, or `null` when the value is not one. See `handler.ts`. */
function knownId(value: unknown): RequestId | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return null;
  }
  return value >= FIRST_REQUEST_ID ? value : null;
}

function isAddressComponent(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** An array is an object by `typeof` and is never a response. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Name a value's type for a message. The value itself is never echoed. */
function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return typeof value;
}
