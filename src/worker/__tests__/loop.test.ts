import { describe, it, expect } from 'vitest';
import { getTitle } from '@core/index';
import type { BookAddress } from '@core/index';
import { WorkerScopeUnavailableError } from '../errors';
import {
  REQUEST_SLICE_MS,
  attachWorkerLoop,
  createWorkerLoop,
  yieldToMacrotask,
} from '../loop';
import type { WorkerLoop, WorkerScopeLike } from '../loop';
import type { ProtocolResponse, RequestId, TitleRequest } from '../protocol';

/**
 * The message loop is what makes cancellation a behaviour rather than a type.
 * The handler's cancelled-id cases are already unit-tested as pure functions
 * of their arguments (`handler.test.ts`), and every one of them passes against
 * a loop that never yields — which is exactly the loop that cannot observe a
 * cancellation at all. So what is asserted here is not what the handler
 * answers but **when the loop asks it**: that a burst of requests is queued
 * whole before any of it is computed, that a cancel is answered ahead of that
 * queue, and that a cancel arriving during a yield is in the handler's state
 * before the next request is looked at.
 *
 * None of it needs a timer. The clock the slice is measured against is
 * injected, so a test places the yield boundary exactly where it wants it, and
 * the yield itself is injected, so a test can make a cancel arrive *inside*
 * one. The two together are what let "the worker reads a cancellation
 * mid-shelf" be asserted by outcome.
 *
 * Addresses that `core` refuses are used wherever the test is about ordering
 * rather than text: a `failed` response proves `core` was called just as well
 * as a `title` does, and it costs microseconds instead of a millisecond
 * apiece.
 */

/** A volume `core` refuses before it reaches the Feistel network. */
const REJECTED_BOOK: BookAddress = { room: -1n, wall: 0, shelf: 0, volume: 0 };

/** The first volume in the library, for the one test that wants real text. */
const FIRST_BOOK: BookAddress = { room: 0n, wall: 0, shelf: 0, volume: 0 };

/**
 * A clock that advances by a fixed step on every reading.
 *
 * The step is derived from `REQUEST_SLICE_MS` rather than written as a number,
 * so these tests say "four requests to a slice" and keep saying it if the
 * slice is ever retuned.
 */
const REQUESTS_PER_SLICE = 4;

function steppedClock(): () => number {
  let reading = 0;
  return (): number => {
    const now = reading;
    reading += REQUEST_SLICE_MS / REQUESTS_PER_SLICE;
    return now;
  };
}

/** What the loop did, in order: a response posted, or a yield taken. */
type TraceEntry = { readonly posted: ProtocolResponse } | { readonly yielded: true };

interface Harness {
  readonly loop: WorkerLoop;
  readonly trace: readonly TraceEntry[];
  /** The responses alone, in the order they were posted. */
  readonly responses: () => readonly ProtocolResponse[];
  /** How many times the loop handed the event loop back. */
  readonly yieldCount: () => number;
}

/**
 * A loop wired to a recorder, a stepped clock and a yield that resolves on a
 * real macrotask.
 *
 * @param duringYield Called on each yield, with its 1-based number, before the
 * yield resolves — the hook that lets a test deliver a cancellation into the
 * exact window the loop opens for one.
 */
function harness(duringYield?: (yieldNumber: number) => void): Harness {
  const trace: TraceEntry[] = [];
  let yields = 0;
  const loop = createWorkerLoop({
    post: (posted): void => {
      trace.push({ posted });
    },
    now: steppedClock(),
    yieldToEventLoop: async (): Promise<void> => {
      yields += 1;
      trace.push({ yielded: true });
      duringYield?.(yields);
      await yieldToMacrotask();
    },
  });
  return {
    loop,
    trace,
    responses: (): readonly ProtocolResponse[] =>
      trace.flatMap((entry) => ('posted' in entry ? [entry.posted] : [])),
    yieldCount: (): number => yields,
  };
}

/** `count` title requests for a volume `core` refuses, under ids 1..count. */
function titleRequests(
  count: number,
  book: BookAddress = REJECTED_BOOK
): TitleRequest[] {
  return Array.from({ length: count }, (_unused, index) => ({
    kind: 'title' as const,
    id: index + 1,
    book,
  }));
}

function idsOf(responses: readonly ProtocolResponse[]): (RequestId | null)[] {
  return responses.map((response) => response.id);
}

/**
 * The kind of the response that answered the *request* under this id.
 *
 * A cancelled id carries two messages — one acknowledging the cancel, one
 * answering the request — and only the second says whether `core` was called,
 * which is what every assertion below is about. Which of the two comes first
 * depends on whether the cancel won the race, so the ack is excluded by kind
 * rather than by position.
 */
function answerTo(
  responses: readonly ProtocolResponse[],
  id: RequestId
): string | undefined {
  return responses.find(
    (response) => response.id === id && response.kind !== 'cancel-ack'
  )?.kind;
}

/** The disposition each cancel for these ids was acknowledged with. */
function dispositions(
  responses: readonly ProtocolResponse[]
): readonly (string | undefined)[] {
  return responses.flatMap((response) =>
    response.kind === 'cancel-ack' ? [response.disposition] : []
  );
}

describe('the loop and the handler together', () => {
  it('answers a title request with the title core generates for that volume', async () => {
    const { loop, responses } = harness();

    loop.accept({ kind: 'title', id: 1, book: FIRST_BOOK });
    await loop.whenIdle();

    expect(responses()).toEqual([
      { kind: 'title', id: 1, title: getTitle(FIRST_BOOK) },
    ]);
  });

  it('answers every queued payload exactly once, in arrival order', async () => {
    const { loop, responses } = harness();

    for (const request of titleRequests(5)) {
      loop.accept(request);
    }
    await loop.whenIdle();

    expect(idsOf(responses())).toEqual([1, 2, 3, 4, 5]);
  });

  it('carries the handler state between messages, refusing a replayed id as stale', async () => {
    const { loop, responses } = harness();

    loop.accept({ kind: 'title', id: 7, book: REJECTED_BOOK });
    loop.accept({ kind: 'title', id: 7, book: REJECTED_BOOK });
    await loop.whenIdle();

    expect(responses().map((response) => response.kind)).toEqual(['failed', 'stale']);
  });
});

describe('taking delivery of a burst', () => {
  it('answers nothing before it has handed the event loop back', async () => {
    const { loop, trace, responses } = harness();

    loop.accept(titleRequests(1)[0]);

    // The whole point: `accept` is called from a `message` task, and a drain
    // that computed inside that task would answer this one request while the
    // other 31 of its burst were still in the event loop's queue — where a
    // cancel cannot overtake them.
    expect(responses()).toEqual([]);
    // The drain has started and has already handed the event loop back; what
    // it has not done is answer anything.
    expect(trace).toEqual([{ yielded: true }]);

    await loop.whenIdle();
    expect(responses()).toHaveLength(1);
  });

  it('queues a whole burst before computing any of it, however many arrive', async () => {
    const { loop, responses } = harness();

    for (const request of titleRequests(32)) {
      loop.accept(request);
    }

    expect(responses()).toEqual([]);

    await loop.whenIdle();
    expect(idsOf(responses())).toHaveLength(32);
  });

  it('starts draining again for a payload accepted after the queue emptied', async () => {
    const { loop, responses } = harness();

    loop.accept({ kind: 'title', id: 1, book: REJECTED_BOOK });
    await loop.whenIdle();
    loop.accept({ kind: 'title', id: 2, book: REJECTED_BOOK });
    await loop.whenIdle();

    expect(idsOf(responses())).toEqual([1, 2]);
  });

  it('resolves whenIdle immediately when nothing has been accepted', async () => {
    const { loop, responses } = harness();

    await loop.whenIdle();

    expect(responses()).toEqual([]);
  });
});

describe('yielding between requests', () => {
  it('takes one slice of compute between yields, not one request', async () => {
    const { loop, trace } = harness();
    const requests = REQUESTS_PER_SLICE * 3;

    for (const request of titleRequests(requests)) {
      loop.accept(request);
    }
    await loop.whenIdle();

    // Three slices, each a yield followed by four answers: a drain begins
    // with a yield and never ends with one.
    expect(trace.map((entry) => ('yielded' in entry ? 'yield' : 'answer'))).toEqual(
      Array.from({ length: 3 }, () => [
        'yield',
        ...Array.from({ length: REQUESTS_PER_SLICE }, () => 'answer'),
      ]).flat()
    );
  });

  it('answers a single request without spending more than the leading yield on it', async () => {
    const { loop, yieldCount } = harness();

    loop.accept(titleRequests(1)[0]);
    await loop.whenIdle();

    expect(yieldCount()).toBe(1);
  });
});

describe('a cancel that overtakes the queue', () => {
  it('is answered on arrival, ahead of the requests already queued', async () => {
    const { loop, responses } = harness();

    for (const request of titleRequests(3)) {
      loop.accept(request);
    }
    loop.accept({ kind: 'cancel', id: 3 });

    // Posted before the drain has answered anything at all, which is what
    // "overtakes the queue" means here.
    expect(responses()).toEqual([
      { kind: 'cancel-ack', id: 3, disposition: 'pre-emptive' },
    ]);

    await loop.whenIdle();
    expect(answerTo(responses(), 3)).toBe('dropped');
  });

  it('is answered on arrival even while a drain is in progress', async () => {
    const requests = REQUESTS_PER_SLICE * 2;
    const lastId = requests;
    const { loop, responses } = harness((yieldNumber) => {
      // The second yield is the one after the first full slice of compute: the
      // window a real cancel arrives in while a shelf is half generated.
      if (yieldNumber === 2) {
        loop.accept({ kind: 'cancel', id: lastId });
      }
    });

    for (const request of titleRequests(requests)) {
      loop.accept(request);
    }
    await loop.whenIdle();

    expect(answerTo(responses(), lastId)).toBe('dropped');
  });

  it('drops only the requests still queued when it arrived', async () => {
    const requests = REQUESTS_PER_SLICE * 2;
    const { loop, responses } = harness((yieldNumber) => {
      if (yieldNumber === 2) {
        // Every id, including the ones already answered in the first slice.
        for (const { id } of titleRequests(requests)) {
          loop.accept({ kind: 'cancel', id });
        }
      }
    });

    for (const request of titleRequests(requests)) {
      loop.accept(request);
    }
    await loop.whenIdle();

    const kinds = titleRequests(requests).map(({ id }) => answerTo(responses(), id));
    // The first slice was computed before the cancel could be read; the second
    // was dropped without calling `core`. A loop that never yielded would show
    // eight `failed` and no `dropped` at all.
    expect(kinds).toEqual([
      ...Array.from({ length: REQUESTS_PER_SLICE }, () => 'failed'),
      ...Array.from({ length: REQUESTS_PER_SLICE }, () => 'dropped'),
    ]);
  });

  it('acknowledges the cancels it lost the race to as reply-in-flight', async () => {
    const requests = REQUESTS_PER_SLICE * 2;
    const { loop, responses } = harness((yieldNumber) => {
      if (yieldNumber === 2) {
        for (const { id } of titleRequests(requests)) {
          loop.accept({ kind: 'cancel', id });
        }
      }
    });

    for (const request of titleRequests(requests)) {
      loop.accept(request);
    }
    await loop.whenIdle();

    // The first slice had already been answered when the cancels arrived, so
    // its replies were in flight; the second slice had not. The client has to
    // ignore the first four results, which is ADR-0016's third assertion.
    expect(dispositions(responses())).toEqual([
      ...Array.from({ length: REQUESTS_PER_SLICE }, () => 'reply-in-flight'),
      ...Array.from({ length: REQUESTS_PER_SLICE }, () => 'pre-emptive'),
    ]);
  });

  it('refuses a payload that only claims to be a cancel, without computing it', () => {
    const { loop, responses } = harness();

    loop.accept({ kind: 'cancel', id: 0 });

    // Answered on arrival because it claims to be a cancel, and refused
    // because the handler narrows it properly: the claim decides *when* a
    // payload is answered, never *how*.
    expect(responses()).toEqual([
      {
        kind: 'protocol-error',
        id: null,
        fault: 'invalid-id',
        detail: expect.stringContaining("'id'"),
      },
    ]);
  });
});

describe('yieldToMacrotask', () => {
  it('returns to the event loop, so a message already queued is delivered first', async () => {
    const order: string[] = [];
    const channel = new MessageChannel();
    channel.port1.onmessage = (): void => {
      order.push('message');
    };

    channel.port2.postMessage(null);
    await yieldToMacrotask();
    order.push('after the yield');

    channel.port1.close();
    channel.port2.close();
    // A `queueMicrotask` or a bare `await` would have produced the reverse:
    // the microtask queue is drained without leaving the task, so no message
    // event is delivered in between.
    expect(order).toEqual(['message', 'after the yield']);
  });
});

describe('attaching to a worker scope', () => {
  interface FakeScope {
    readonly scope: WorkerScopeLike;
    readonly posted: readonly unknown[];
    readonly deliver: (data: unknown) => void;
  }

  function fakeScope(): FakeScope {
    const posted: unknown[] = [];
    let listener: ((event: { readonly data: unknown }) => void) | null = null;
    return {
      posted,
      deliver: (data): void => {
        listener?.({ data });
      },
      scope: {
        postMessage: (message): void => {
          posted.push(message);
        },
        // The signature admits only `'message'`, so there is nothing here to
        // dispatch on; `attachWorkerLoop` asking for any other event would
        // not compile.
        addEventListener: (_type, incoming): void => {
          listener = incoming;
        },
      },
    };
  }

  it('answers a message delivered to the scope by posting back through it', async () => {
    const { scope, posted, deliver } = fakeScope();
    const loop = attachWorkerLoop(scope);

    deliver({ kind: 'title', id: 1, book: FIRST_BOOK });
    await loop.whenIdle();

    expect(posted).toEqual([{ kind: 'title', id: 1, title: getTitle(FIRST_BOOK) }]);
  });

  it.each([
    ['null', null],
    ['a number', 42],
    ['an object with neither member', {}],
    ['an object that can post but not listen', { postMessage: (): void => undefined }],
  ])('refuses to attach to %s', (_description, scope) => {
    expect(() => attachWorkerLoop(scope)).toThrow(WorkerScopeUnavailableError);
  });
});
