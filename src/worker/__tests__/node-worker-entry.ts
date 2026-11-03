import { parentPort } from 'node:worker_threads';

/**
 * The module the integration test spawns as a real worker thread.
 *
 * It is not a second entry point. Its whole job is to give `../entry.ts` the
 * two members of a `DedicatedWorkerGlobalScope` that entry narrows for —
 * `postMessage` and `addEventListener('message', …)` — on top of Node's
 * `parentPort`, and then import the production entry module so that the
 * integration test runs the real one rather than a copy of it.
 *
 * **Why a shim rather than a browser `Worker`.** Vitest runs this suite in the
 * `node` environment, where there is no `Worker` global and no
 * `DedicatedWorkerGlobalScope`; a browser one would mean a Playwright test,
 * which belongs to the milestone that has a page to load (`testing.md` §1 and
 * §6). What a Node worker thread does give is the thing the integration test
 * is for: a separate thread with a real event loop, real `postMessage`
 * delivery and real structured cloning — "the thread is where the flakes
 * are". What it cannot prove is that a browser's own worker scope satisfies
 * the same two-member contract. That is specified rather than measured, and
 * the one line in `../entry.ts` is where it is assumed.
 *
 * This file is not a `*.test.ts`, so Vitest does not collect it; it is built
 * to JavaScript by the integration test and spawned from there.
 */
if (parentPort === null) {
  throw new Error(
    'This module must be loaded as a worker thread, not on the main thread'
  );
}

const port = parentPort;

Object.defineProperties(globalThis, {
  postMessage: {
    configurable: true,
    value: (message: unknown): void => {
      port.postMessage(message);
    },
  },
  addEventListener: {
    configurable: true,
    value: (
      type: string,
      listener: (event: { readonly data: unknown }) => void
    ): void => {
      if (type !== 'message') {
        return;
      }
      port.on('message', (data: unknown) => {
        listener({ data });
      });
    },
  },
});

await import('../entry');
