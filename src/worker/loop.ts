import { defaultRandomSource } from '@core/index';
import type { RandomSource } from '@core/index';
import { createProtocolHandlerState, handleProtocolMessage } from './handler';
import type { ProtocolHandlerState } from './handler';
import { WorkerScopeUnavailableError } from './errors';
import type { ProtocolResponse } from './protocol';

/**
 * The worker's message loop: what turns the pure handler into a thread that
 * answers messages, and the one place in this milestone where cancellation
 * stops being a type and starts being a behaviour.
 *
 * ## Why there is a queue here at all
 *
 * The naive loop is `onmessage = (event) => post(handle(event.data))`. It
 * passes every test the handler has and the feature it implements does
 * nothing. Fan a shelf out and 32 request messages are queued as 32 tasks; the
 * worker runs them back to back, ~1 ms apiece; the `cancel` the client posts
 * 5 ms later is queued *behind* the 27 requests it was trying to prevent and
 * is read ~27 ms after the last title it could have saved. Every title is
 * computed. The handler then answers each cancel `reply-in-flight`, truthfully,
 * and the client correctly discards 27 results it paid for in full. The camera
 * has long since left the shelf. Nothing is red, and cancellation is
 * decorative.
 *
 * So the loop takes delivery of messages and the computation separately:
 *
 * 1. `accept` **answers a cancel on arrival** — the handler's answer to one is
 *    a set membership test and a comparison, no `core` call — and **queues
 *    everything else**, which is O(1).
 * 2. The drain **hands the event loop back before computing anything**, so a
 *    burst of messages already delivered to the thread lands in this queue
 *    whole rather than one message per drain.
 * 3. It then takes the queue in order, answers one message per turn, and
 *    **yields to the event loop** again once a slice's worth of compute has
 *    gone by.
 *
 * Step 2 is what makes step 1 worth anything, and leaving it out is the
 * subtle way to rebuild the naive loop out of the right parts. Without it the
 * first `accept` drains the single message it just queued, synchronously,
 * inside its own task — so the queue holds at most one request, the other 31
 * are still in the event loop's queue, and the cancel is the 33rd task behind
 * them exactly as before. The queue only overtakes work that is actually in
 * it.
 *
 * With both steps, what `protocol.ts` calls a channel that overtakes the
 * queue is one queue and one `postMessage`, not a second `MessagePort`. A port
 * would not have helped: both ports' deliveries land in the same task queue in
 * arrival order, so a cancel posted after 32 requests is the 33rd task either
 * way. What makes it overtake is that by then the work is no longer in the
 * queue it has to overtake.
 *
 * ## Why the yield has to be a macrotask
 *
 * `queueMicrotask` and a bare `await` drain the microtask queue and return to
 * the same task. No `message` event is delivered in between, so a loop that
 * yielded that way would read no cancellation and the paragraph above would
 * apply unchanged. Only returning to the event loop lets a message in.
 *
 * ## What it costs
 *
 * One extra task-queue turn before a burst is answered — microseconds against
 * the 1.0 to 1.35 ms of the first page in it — and one more per slice. In
 * exchange, a shelf abandoned after 5 ms stops after about 5 ms of compute
 * instead of running all 32 titles to completion.
 */

/**
 * The most uninterrupted compute the worker takes between cancellation checks,
 * in milliseconds.
 *
 * This is the one figure in this module that does not vary with the machine,
 * which is why it is the one that is fixed. A title costs 0.46 ms on the
 * fastest machine measured and 0.98 ms on the slowest (ADR-0005), so a 4 ms
 * slice is three to eight titles — and the cost of a yield is a task-queue
 * turn, microseconds, so a slice three to eight requests long spends well
 * under 1% of the thread on yielding.
 *
 * Both directions have a cost and neither is free. A slice of 1 ms would check
 * for cancellation between every title and spend a few percent of the thread
 * doing it; a slice of 32 ms would be the naive loop with extra steps, reading
 * a cancel only once a shelf had finished. 4 ms is the knee: fine enough that
 * abandoning a shelf abandons most of it, coarse enough that the yields are
 * not measurable against generation.
 */
export const REQUEST_SLICE_MS = 4;

/** The message loop, as the entry point and the tests both use it. */
export interface WorkerLoop {
  /**
   * Take one payload delivered to the worker.
   *
   * A payload claiming to be a `cancel` is answered before this returns;
   * anything else is queued and answered by the drain. Either way exactly one
   * response is posted for it, eventually — never zero (ADR-0016) and never
   * two.
   */
  accept(payload: unknown): void;

  /**
   * Resolves when every payload accepted so far has been answered.
   *
   * Not merely a test affordance: `testing.md` §7 specifies a
   * `waitForIdle()` on the debug hook that resolves when "the worker queue is
   * empty", so that an end-to-end test never has to sleep on a fixed
   * duration. This is the half of it that lives on this side of the boundary.
   */
  whenIdle(): Promise<void>;
}

/** What the loop needs in order to run. */
export interface WorkerLoopOptions {
  /** Send one response back to whoever posted the payload. */
  readonly post: (response: ProtocolResponse) => void;

  /**
   * Return to the event loop so queued messages can be delivered.
   *
   * Defaults to `yieldToMacrotask`. Injectable so that a test can place the
   * yield boundary exactly where it wants it, and so that the drain's slice
   * arithmetic can be exercised without a timer.
   */
  readonly yieldToEventLoop?: () => Promise<void>;

  /**
   * The monotonic clock the slice is measured against. Defaults to
   * `performance.now()`.
   *
   * Injectable for the same reason: with a fake clock a test can make the
   * slice expire after a known number of requests and assert where the loop
   * yielded, which no amount of real waiting could do deterministically.
   *
   * It is a clock and not a counter because the budget is 4 ms of compute, and
   * how many requests fit in 4 ms is exactly what varies by a factor of two
   * between the machines in ADR-0005.
   */
  readonly now?: () => number;
}

/**
 * Yield to the event loop by posting a message to ourselves.
 *
 * A `MessageChannel` round trip rather than `setTimeout(0)`: a browser clamps
 * nested timers to 4 ms after five levels of nesting, and the drain's timers
 * *are* nested — each one is scheduled from inside the previous one's
 * callback. That would add a 4 ms sleep to every 4 ms slice and halve the rate
 * at which a shelf is generated, for no benefit. A message has no such clamp.
 *
 * The channel is created per yield and both ports are closed again rather than
 * being kept in a module-level singleton. A singleton would be one allocation
 * instead of one per slice — about eight per shelf, against 25 to 33 ms of
 * `bigint` arithmetic, so the saving is not measurable — and an open port with
 * a listener keeps its host's event loop referenced, which is a test process
 * that never exits.
 */
export function yieldToMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (): void => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * A payload that claims to be a cancel.
 *
 * Deliberately only a claim: this decides *when* a payload is answered, never
 * *how*. The handler still narrows it in full, so a `cancel` with a fractional
 * id is refused exactly as it would have been from the queue — refusing it
 * sooner is the same answer. What the check must not do is be expensive or be
 * wrong about a request: reading one own property is neither.
 */
function claimsToBeCancel(payload: unknown): boolean {
  return isRecord(payload) && payload.kind === 'cancel';
}

/** An array is an object by `typeof` and is never a message. See `handler.ts`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class QueuedMessageLoop implements WorkerLoop {
  private state: ProtocolHandlerState = createProtocolHandlerState();

  /**
   * The bytes a `search` is placed and padded with (ADR-0033).
   *
   * Owned here and handed to the handler, so that the handler stays a function
   * of its arguments and its tests can pin the bytes. `core`'s default is
   * `Math.random`-backed, and that is a choice rather than a constraint on this
   * thread: these bytes choose which book a reader is shown, not a key, so
   * being unpredictable to an attacker is not required of them (ADR-0011).
   */
  private readonly random: RandomSource = defaultRandomSource;

  /** Payloads accepted but not yet answered, in arrival order. */
  private readonly queue: unknown[] = [];

  /**
   * Whether a drain is in progress, and the promise for it.
   *
   * Two fields rather than one nullable promise, because a drain that never
   * reaches a yield runs to completion *inside* the call that starts it: the
   * flag is cleared before the promise is even assigned, so a promise read as
   * "a drain is running" would latch on forever and the queue would never be
   * drained again.
   */
  private isDraining = false;
  private drainInFlight: Promise<void> = Promise.resolve();

  private readonly post: (response: ProtocolResponse) => void;
  private readonly yieldToEventLoop: () => Promise<void>;
  private readonly now: () => number;

  constructor(options: WorkerLoopOptions) {
    this.post = options.post;
    this.yieldToEventLoop = options.yieldToEventLoop ?? yieldToMacrotask;
    this.now = options.now ?? ((): number => performance.now());
  }

  accept(payload: unknown): void {
    if (claimsToBeCancel(payload)) {
      this.answer(payload);
      return;
    }
    this.queue.push(payload);
    if (this.isDraining) {
      return;
    }
    this.isDraining = true;
    this.drainInFlight = this.drain();
  }

  async whenIdle(): Promise<void> {
    while (this.isDraining) {
      await this.drainInFlight;
    }
  }

  /**
   * Answer the queue, yielding once a slice of compute has gone by.
   *
   * It yields **before** the first answer as well as between slices. That
   * leading yield is not symmetry: it is what lets the queue fill. `accept` is
   * called from a `message` task, and a drain that started computing inside
   * that task would answer the one payload it had just been handed while the
   * rest of the burst was still in the event loop's queue, where a cancel
   * cannot overtake it. See this module's header.
   *
   * The slice is measured from the last yield rather than per request, so a
   * `locate` that costs 1.4 ms and a `protocol-error` that costs nothing both
   * count toward the same budget — which is what makes the budget a bound on
   * how long the thread can go without reading a cancel, rather than a bound
   * on any one request.
   *
   * The check comes *after* answering rather than before, so the loop always
   * makes progress: a slice budget of zero would otherwise yield forever
   * without answering anything. And it does not yield into an *empty* queue:
   * a drain always begins with a yield and never ends with one, which is both
   * one macrotask cheaper and what makes the leading yield load-bearing. A
   * trailing yield would let the queue fill one request late and so paper over
   * a missing leading one — measured, and in the pull request.
   */
  private async drain(): Promise<void> {
    try {
      await this.yieldToEventLoop();
      let sliceStarted = this.now();
      while (this.queue.length > 0) {
        this.answer(this.queue.shift());
        if (this.queue.length === 0 || this.now() - sliceStarted < REQUEST_SLICE_MS) {
          continue;
        }
        // Everything that makes cancellation work happens in this `await`:
        // the task queue gets its turn, a `cancel` posted while the slice was
        // running is delivered and answered by `accept`, and the ids it names
        // are in `this.state` before the loop looks at the next request.
        await this.yieldToEventLoop();
        sliceStarted = this.now();
      }
    } finally {
      this.isDraining = false;
    }
  }

  /** One payload in, one response out, state carried forward. */
  private answer(payload: unknown): void {
    const outcome = handleProtocolMessage(payload, this.state, this.random);
    this.state = outcome.state;
    this.post(outcome.response);
  }
}

/** Build a message loop. The state it carries between messages is its own. */
export function createWorkerLoop(options: WorkerLoopOptions): WorkerLoop {
  return new QueuedMessageLoop(options);
}

/**
 * The two members of a worker's global scope this entry point uses.
 *
 * Narrowed structurally rather than typed as `DedicatedWorkerGlobalScope`,
 * which this project's `tsconfig` does not have: the `WebWorker` lib
 * redeclares much of `DOM`, and adding it would make every other module
 * compile against a scope it does not run in. A structural narrowing is also
 * what `code-style.md` §1 asks for at a boundary — `globalThis` in a worker is
 * exactly as unchecked as a message is.
 */
export interface WorkerScopeLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: { readonly data: unknown }) => void
  ): void;
}

/**
 * Run a message loop over a worker global scope.
 *
 * Takes the scope as `unknown` and narrows it, so the entry module is one
 * expression with nothing in it to get wrong, and so that loading the entry
 * anywhere but a worker throws instead of quietly installing a `message`
 * listener on a window — where it would answer any `postMessage` the page
 * received, from any origin.
 */
export function attachWorkerLoop(scope: unknown): WorkerLoop {
  if (!isWorkerScope(scope)) {
    throw new WorkerScopeUnavailableError(
      'the scope has no postMessage and addEventListener pair to answer messages with'
    );
  }
  const loop = createWorkerLoop({
    post: (response): void => {
      scope.postMessage(response);
    },
  });
  scope.addEventListener('message', (event) => {
    loop.accept(event.data);
  });
  return loop;
}

function isWorkerScope(value: unknown): value is WorkerScopeLike {
  return (
    isRecord(value) &&
    typeof value.postMessage === 'function' &&
    typeof value.addEventListener === 'function'
  );
}
