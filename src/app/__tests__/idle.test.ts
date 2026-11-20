import { describe, expect, it } from 'vitest';
import { areAllIdle, whenAllIdle } from '@app/idle';
import type { IdleSource } from '@app/idle';

/**
 * What `waitForIdle()` rests on, and the one property that is easy to get
 * wrong: settling one source can make another busy, so a single pass over the
 * list is not an answer (`docs/testing.md` §7).
 *
 * Nothing here waits on a duration. Every settlement in the application is a
 * microtask, so a few turns of the microtask queue is what "has it settled
 * yet" means, and `hasSettled` below is the whole of the apparatus.
 */

/** A source a test can make busy and settle again. */
interface Controllable {
  readonly source: IdleSource;
  busy(): void;
  settle(): void;
}

function controllable(): Controllable {
  let idle = true;
  const waiters: (() => void)[] = [];

  return {
    source: {
      isIdle: () => idle,
      whenIdle: () =>
        idle
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              waiters.push(resolve);
            }),
    },
    busy(): void {
      idle = false;
    },
    settle(): void {
      idle = true;
      for (const resolve of waiters.splice(0)) {
        resolve();
      }
    },
  };
}

/** Whether `promise` has settled, after letting the microtask queue drain. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
  return settled;
}

describe('whether everything is idle', () => {
  it('is true when there is nothing that can be busy', () => {
    expect(areAllIdle([])).toBe(true);
  });

  it('is false while any one source is busy', () => {
    const quiet = controllable();
    const working = controllable();
    working.busy();

    expect(areAllIdle([quiet.source, working.source])).toBe(false);
    expect(areAllIdle([quiet.source])).toBe(true);
  });
});

describe('waiting for everything to be idle', () => {
  it('resolves at once when nothing is busy', async () => {
    const one = controllable();
    const other = controllable();

    expect(await hasSettled(whenAllIdle([one.source, other.source]))).toBe(true);
  });

  it('waits for every busy source, not the first of them', async () => {
    const one = controllable();
    const other = controllable();
    one.busy();
    other.busy();

    const idle = whenAllIdle([one.source, other.source]);

    one.settle();
    expect(await hasSettled(idle)).toBe(false);
    other.settle();
    await idle;
  });

  it('reads the list again after a settlement, because one can start another', async () => {
    // This is the case the loop exists for: the reader starts writing when the
    // worker client goes quiet, and the title resolver starts asking when the
    // camera arrives. A single pass would report idle in the middle of both.
    const first = controllable();
    const second = controllable();
    first.busy();

    const idle = whenAllIdle([first.source, second.source]);

    second.busy();
    first.settle();

    expect(await hasSettled(idle)).toBe(false);
    second.settle();
    await idle;
  });

  it('resolves once a source that went busy and idle again is idle', async () => {
    const source = controllable();
    source.busy();
    const idle = whenAllIdle([source.source]);

    source.settle();
    await idle;
    source.busy();

    expect(await hasSettled(whenAllIdle([source.source]))).toBe(false);
  });
});
