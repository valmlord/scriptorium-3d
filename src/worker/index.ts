// Worker layer exports — the thread boundary (SPEC §6).
// M3: the message format, the protocol handler that answers it, the cache the
// client reads through, the message loop that runs the handler on the thread,
// and the client that owns the `Worker` and the request ids.
//
// `./entry.ts` is deliberately absent: it is the module `new Worker(...)`
// loads, and importing it runs it — it narrows `globalThis` to a worker scope
// and installs a `message` listener. `createGenerationWorker` in `./client`
// is how the rest of the app reaches it.

export * from './protocol';
export * from './handler';
export * from './cache';
export * from './errors';
export * from './response';
export * from './loop';
export * from './client';
