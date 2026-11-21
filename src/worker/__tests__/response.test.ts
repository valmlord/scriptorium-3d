import { describe, it, expect } from 'vitest';
import { getPage, getTitle } from '@core/index';
import type { Address, BookAddress } from '@core/index';
import { FIRST_REQUEST_ID } from '../protocol';
import { parseProtocolResponse } from '../response';

/**
 * The worker's own messages, narrowed at the boundary.
 *
 * `code-style.md` §1 makes data crossing a boundary untrusted whichever
 * direction it crosses in, and "the worker is our own code" is a promise to
 * the compiler rather than to the thing delivering the message — a worker
 * bundle served from an HTTP cache after a format change is one real way the
 * two ends disagree. What each case below is really asserting is that a
 * misshapen message is *refused under its id* rather than acted on or
 * silently dropped: refused, the client rejects that promise; dropped, the
 * promise hangs, which is what ADR-0016 exists to prevent.
 */

const ID = FIRST_REQUEST_ID;
const ADDRESS: Address = { room: 7n, wall: 1, shelf: 2, volume: 3, page: 4 };
const BOOK: BookAddress = { room: 0n, wall: 0, shelf: 0, volume: 0 };

describe('a well-formed response', () => {
  it('narrows a page to its text', () => {
    const text = getPage({ room: 0n, wall: 0, shelf: 0, volume: 0, page: 0 });

    const parsed = parseProtocolResponse({ kind: 'page', id: ID, text });

    expect(parsed).toEqual({ ok: true, response: { kind: 'page', id: ID, text } });
  });

  it('narrows a title to its title', () => {
    const title = getTitle(BOOK);

    const parsed = parseProtocolResponse({ kind: 'title', id: ID, title });

    expect(parsed).toEqual({ ok: true, response: { kind: 'title', id: ID, title } });
  });

  it('narrows a located address, keeping the room a bigint', () => {
    const parsed = parseProtocolResponse({ kind: 'located', id: ID, address: ADDRESS });

    expect(parsed).toEqual({
      ok: true,
      response: { kind: 'located', id: ID, address: ADDRESS },
    });
  });

  it('narrows a found address and offset, keeping the room a bigint', () => {
    const parsed = parseProtocolResponse({
      kind: 'found',
      id: ID,
      address: ADDRESS,
      offset: 17,
    });

    expect(parsed).toEqual({
      ok: true,
      response: { kind: 'found', id: ID, address: ADDRESS, offset: 17 },
    });
  });

  it('leaves the bound of a found offset to the client, which holds the query', () => {
    // A query of n code points starts at 0 to PAGE_LENGTH - n, and only the
    // request knows n; `takeFound` in `client.ts` refuses this one.
    const parsed = parseProtocolResponse({
      kind: 'found',
      id: ID,
      address: ADDRESS,
      offset: -1,
    });

    expect(parsed).toMatchObject({ ok: true });
  });

  it('narrows a protocol error refusing a misshapen search', () => {
    const parsed = parseProtocolResponse({
      kind: 'protocol-error',
      id: ID,
      fault: 'malformed-search',
      detail: "'query' must be a string, received number",
    });

    expect(parsed).toMatchObject({
      ok: true,
      response: { id: ID, fault: 'malformed-search' },
    });
  });

  it.each(['pre-emptive', 'already-cancelled', 'reply-in-flight'])(
    'narrows a cancel acknowledged as %s',
    (disposition) => {
      const parsed = parseProtocolResponse({ kind: 'cancel-ack', id: ID, disposition });

      expect(parsed).toEqual({
        ok: true,
        response: { kind: 'cancel-ack', id: ID, disposition },
      });
    }
  );

  it('narrows a dropped response to its id, discarding the request it echoes', () => {
    const parsed = parseProtocolResponse({
      kind: 'dropped',
      id: ID,
      request: { kind: 'page', id: ID, address: ADDRESS },
    });

    // The protocol echoes the whole request so that a client which no longer
    // holds it can still name the address. This one does hold it.
    expect(parsed).toEqual({ ok: true, response: { kind: 'dropped', id: ID } });
  });

  it('narrows a stale response to the watermark it reports', () => {
    const parsed = parseProtocolResponse({ kind: 'stale', id: ID, highestIdSeen: 9 });

    expect(parsed).toEqual({
      ok: true,
      response: { kind: 'stale', id: ID, highestIdSeen: 9 },
    });
  });

  it('narrows a failure to the name and message core threw', () => {
    const error = { name: 'InvalidAddressError', message: 'out of range' };

    const parsed = parseProtocolResponse({ kind: 'failed', id: ID, error });

    expect(parsed).toEqual({ ok: true, response: { kind: 'failed', id: ID, error } });
  });

  it('narrows a protocol error that names no id, because it could not read one', () => {
    const parsed = parseProtocolResponse({
      kind: 'protocol-error',
      id: null,
      fault: 'invalid-id',
      detail: "'id' must be an integer >= 1",
    });

    expect(parsed).toMatchObject({
      ok: true,
      response: { id: null, fault: 'invalid-id' },
    });
  });
});

describe('a payload that is not a response', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'page'],
    ['a number', 1],
  ])(
    'refuses %s, naming no id because there is none to name',
    (_description, payload) => {
      expect(parseProtocolResponse(payload)).toMatchObject({ ok: false, id: null });
    }
  );

  it('refuses an array, which is an object by typeof but never a response', () => {
    expect(parseProtocolResponse([{ kind: 'page', id: ID, text: '' }])).toMatchObject({
      ok: false,
      id: null,
    });
  });

  it('refuses a kind this protocol does not define', () => {
    expect(parseProtocolResponse({ kind: 'pages', id: ID, text: '' })).toMatchObject({
      ok: false,
      id: ID,
    });
  });

  it('refuses a kind that is not a string', () => {
    expect(parseProtocolResponse({ kind: 7, id: ID })).toMatchObject({
      ok: false,
      id: ID,
    });
  });

  it('refuses a kind inherited from Object.prototype rather than owned', () => {
    expect(parseProtocolResponse({ kind: 'constructor', id: ID })).toMatchObject({
      ok: false,
      id: ID,
    });
  });
});

describe('a response whose id is unusable', () => {
  it.each([
    ['absent', undefined],
    ['zero, below the first id a client may issue', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['not a number', '1'],
    ['NaN', Number.NaN],
    ['past the safe integer range', Number.MAX_SAFE_INTEGER + 2],
  ])('refuses a result whose id is %s', (_description, id) => {
    expect(parseProtocolResponse({ kind: 'page', id, text: '' })).toMatchObject({
      ok: false,
      id: null,
    });
  });
});

describe('a response whose body is unusable', () => {
  it('refuses a page whose text is not a string', () => {
    expect(parseProtocolResponse({ kind: 'page', id: ID, text: 3200 })).toMatchObject({
      ok: false,
      id: ID,
    });
  });

  it('refuses a title whose title is absent', () => {
    expect(parseProtocolResponse({ kind: 'title', id: ID })).toMatchObject({
      ok: false,
      id: ID,
    });
  });

  it('refuses a located response carrying no address', () => {
    expect(parseProtocolResponse({ kind: 'located', id: ID })).toMatchObject({
      ok: false,
      id: ID,
    });
  });

  it('refuses a room that is a number rather than a bigint', () => {
    const parsed = parseProtocolResponse({
      kind: 'located',
      id: ID,
      address: { ...ADDRESS, room: 7 },
    });

    // Not pedantry: `Number(room)` on a 4975-digit value is `Infinity`, so a
    // room that arrived as a number has already lost the address.
    expect(parsed).toMatchObject({ ok: false, id: ID });
  });

  it.each(['wall', 'shelf', 'volume', 'page'])(
    'refuses an address whose %s is not an integer',
    (component) => {
      const parsed = parseProtocolResponse({
        kind: 'located',
        id: ID,
        address: { ...ADDRESS, [component]: 1.5 },
      });

      expect(parsed).toMatchObject({ ok: false, id: ID });
    }
  );

  it('refuses a found response carrying no address', () => {
    expect(parseProtocolResponse({ kind: 'found', id: ID, offset: 0 })).toMatchObject({
      ok: false,
      id: ID,
      detail: expect.stringContaining("'address'"),
    });
  });

  it('refuses a found room that is a number, exactly as for a located one', () => {
    const parsed = parseProtocolResponse({
      kind: 'found',
      id: ID,
      address: { ...ADDRESS, room: 7 },
      offset: 0,
    });

    expect(parsed).toMatchObject({
      ok: false,
      id: ID,
      detail: expect.stringContaining("'address.room'"),
    });
  });

  it('refuses a found offset that is not a number, naming its type and not its value', () => {
    const value = 'the offset a skewed worker sent';

    const parsed = parseProtocolResponse({
      kind: 'found',
      id: ID,
      address: ADDRESS,
      offset: value,
    });

    expect(parsed).toMatchObject({
      ok: false,
      id: ID,
      detail: "'offset' must be a number, received string",
    });
    expect(JSON.stringify(parsed)).not.toContain(value);
  });

  it('refuses a disposition that is none of the three', () => {
    expect(
      parseProtocolResponse({ kind: 'cancel-ack', id: ID, disposition: 'maybe' })
    ).toMatchObject({ ok: false, id: ID });
  });

  it('refuses a stale response whose watermark is not a request id', () => {
    expect(
      parseProtocolResponse({ kind: 'stale', id: ID, highestIdSeen: 'lots' })
    ).toMatchObject({ ok: false, id: ID });
  });

  it('refuses a failure whose error is not an object', () => {
    expect(
      parseProtocolResponse({ kind: 'failed', id: ID, error: 'it broke' })
    ).toMatchObject({ ok: false, id: ID });
  });

  it.each(['name', 'message'])(
    'refuses a failure whose error.%s is not a string',
    (field) => {
      const error = { name: 'E', message: 'm', [field]: 7 };

      expect(parseProtocolResponse({ kind: 'failed', id: ID, error })).toMatchObject({
        ok: false,
        id: ID,
      });
    }
  );

  it('refuses a protocol error naming a fault this protocol does not define', () => {
    expect(
      parseProtocolResponse({
        kind: 'protocol-error',
        id: ID,
        fault: 'oops',
        detail: 'x',
      })
    ).toMatchObject({ ok: false, id: ID });
  });

  it('refuses a protocol error whose detail is not a string', () => {
    expect(
      parseProtocolResponse({
        kind: 'protocol-error',
        id: ID,
        fault: 'invalid-id',
        detail: null,
      })
    ).toMatchObject({ ok: false, id: ID });
  });
});

describe('what a refusal says', () => {
  it('names the offending field so a caller can fix the call', () => {
    const parsed = parseProtocolResponse({ kind: 'page', id: ID, text: null });

    expect(parsed).toMatchObject({ detail: expect.stringContaining("'text'") });
  });

  it('does not echo the offending value, which is untrusted and can be huge', () => {
    const parsed = parseProtocolResponse({
      kind: 'page',
      id: ID,
      text: 'x'.repeat(5000),
    });

    expect(parsed).toMatchObject({ ok: true });
  });

  it('ignores an unknown extra property, so an added field is not a breaking change', () => {
    const parsed = parseProtocolResponse({
      kind: 'title',
      id: ID,
      title: getTitle(BOOK),
      generatedAt: 'a field from a newer worker',
    });

    expect(parsed).toMatchObject({ ok: true });
  });
});
