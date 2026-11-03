import { attachWorkerLoop } from './loop';

/**
 * The worker's entry point: the module `new Worker(...)` loads.
 *
 * One expression, deliberately. Everything it could get wrong lives in
 * `./loop.ts`, where it is reachable from a test without a thread —
 * `attachWorkerLoop` narrows the scope, installs the `message` listener and
 * owns the queue, the slice and the handler state. What is left here is the
 * one line that cannot be tested without being a worker, and it is the line
 * the integration test runs a real worker thread in order to run.
 *
 * `globalThis` rather than `self`: `self` is typed as a `Window` under this
 * project's `DOM` lib, and the `WebWorker` lib that would type it correctly
 * redeclares much of `DOM`, so adding it would make every other module compile
 * against a scope it does not run in. `attachWorkerLoop` takes the scope as
 * `unknown` and narrows it structurally instead, which is what
 * `code-style.md` §1 asks for at a boundary anyway — and it means loading this
 * module outside a worker throws `WorkerScopeUnavailableError` rather than
 * installing a `message` listener on a window, where it would answer any
 * `postMessage` the page received from any origin.
 *
 * This module is not re-exported from `./index.ts`: importing it *runs* it.
 */
attachWorkerLoop(globalThis);
