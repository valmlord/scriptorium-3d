// Worker layer exports — the thread boundary (SPEC §6).
// M3: the message format, the protocol handler that answers it, the cache the
// client reads through, and the message loop that runs the handler on the
// thread. The client that owns the `Worker` and the request ids follows.
//
// `./entry.ts` is deliberately absent: it is the module `new Worker(...)`
// loads, and importing it runs it — it narrows `globalThis` to a worker scope
// and installs a `message` listener.

export * from './protocol';
export * from './handler';
export * from './cache';
export * from './errors';
export * from './loop';
