import { describe, it, expect, vi } from 'vitest';

/**
 * One case the handler must survive that `core` cannot be persuaded to produce.
 *
 * `core` throws named `Error` subclasses for every domain situation it knows
 * about, so the branch that handles a thrown *non*-`Error` is reachable only
 * from a bug — and it exists because `throw 'oops'` is legal JavaScript and an
 * id left unanswered is the hang ADR-0016 is about. Reaching it means replacing
 * `core` for the duration of one file.
 *
 * This is a stub of a collaborator, not of the subject: the handler is what is
 * under test and it is the real one. testing.md §9's rule — never mock the
 * thing under test — is intact. The stub lives in its own file because
 * `vi.mock` is hoisted to the top of the module it appears in, and the rest of
 * the handler's tests must run against the real bijection.
 */
/* eslint-disable @typescript-eslint/only-throw-error --
   Throwing values that are not `Error`s is the entire subject of this file.
   The rule is right everywhere else in the codebase, which is why it stays on
   everywhere else; here it would forbid writing down the one thing being
   tested. */
vi.mock('@core/index', () => ({
  getPage: (): string => {
    throw 'a bare string, which is not an Error';
  },
  getTitle: (): string => {
    throw { code: 42 };
  },
  locate: (): never => {
    throw undefined;
  },
}));
/* eslint-enable @typescript-eslint/only-throw-error */

const { createProtocolHandlerState, handleProtocolMessage } =
  await import('../handler');

const SOME_ADDRESS = { room: 0n, wall: 0, shelf: 0, volume: 0, page: 0 };
const SOME_BOOK = { room: 0n, wall: 0, shelf: 0, volume: 0 };

/** Only a `search` reads the source, and no case here sends one. */
const neverRead = (byteLength: number): Uint8Array => new Uint8Array(byteLength);

function answer(payload: unknown) {
  return handleProtocolMessage(payload, createProtocolHandlerState(), neverRead)
    .response;
}

describe('a core call that throws something other than an Error', () => {
  it('answers the request rather than letting the throw escape onmessage', () => {
    const response = answer({ kind: 'page', id: 1, address: SOME_ADDRESS });

    expect(response.kind).toBe('failed');
    expect(response.id).toBe(1);
  });

  it('names the failure, so it is visible instead of swallowed', () => {
    const response = answer({ kind: 'title', id: 2, book: SOME_BOOK });

    expect(response.kind === 'failed' && response.error.name).toBe('NonErrorThrown');
    expect(response.kind === 'failed' && response.error.message).toContain('object');
  });

  it('answers a thrown undefined, which carries no name of its own at all', () => {
    const response = answer({ kind: 'locate', id: 3, page: 'anything' });

    expect(response.kind === 'failed' && response.error.name).toBe('NonErrorThrown');
    expect(response.kind === 'failed' && response.error.message).toContain('undefined');
  });
});
