# @worker

Worker client. The thread boundary: calls `@core` at runtime and sends/receives messages with the worker.

## What belongs here

- Initialization and message passing
- Marshalling data for the worker
- Request/response handling

## What is here now

- `protocol.ts` — the message format: three request kinds, a cancellation, and the responses that
  answer them. Types and constants only, no behaviour.
- `handler.ts` — the worker-side protocol handler as a pure function. One payload and one state in,
  one response and the next state out. It narrows the payload from `unknown`, answers every shape it
  can take, and calls `@core` once per message so the message loop can yield between requests.
- `cache.ts` — the LRU cache the client reads through, on the main thread in front of the worker.
  Pages and titles are separate stores with separate ceilings **in bytes**, keyed by the linear
  address rendered as a string. Recency is the order of use, never a clock.

Still to come in M3: the client that owns the `Worker`, issues the monotonic request ids, fans a
shelf out over 32 single-address requests, reads through the cache and rejects a cancelled request
with a named domain error (ADR-0016).

## What cannot be imported

- `three`
- `gsap`
- `window.performance` and other frame-critical APIs
- `@engine`, `@motion`, `@state`, `@ui` — the worker client does not reach into the scene or UI

## Imports allowed

- `@core/*` at runtime (this is the only layer that may)
- Type-only imports from anywhere

## What calls @worker

- `@state` for data fetching
- `@engine` or `@ui` for integration with the scene and interface
