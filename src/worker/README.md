# @worker

Worker client. The thread boundary: calls `@core` at runtime and sends/receives messages with the worker.

## What belongs here

- Initialization and message passing
- Marshalling data for the worker
- Request/response handling

## What is here now

- `protocol.ts` — the message format: four request kinds (a page, a title, `locate` and `search`), a
  cancellation, and the responses that answer them. Types and constants only, no behaviour. A
  `search` carries a query and a pad mode and no offset; the worker places the query and answers
  `found` with the address and the offset (ADR-0033).
- `handler.ts` — the worker-side protocol handler as a pure function. One payload, one state and a
  random source in, one response and the next state out. It narrows the payload from `unknown`,
  answers every shape it can take, and calls `@core` once per message so the message loop can yield
  between requests. The random source is read only by a `search`, so the same payload, state and
  bytes always give the same answer. A search that sends an `offset` is refused by name.
- `cache.ts` — the LRU cache the client reads through, on the main thread in front of the worker.
  Pages and titles are separate stores with separate ceilings **in bytes**, keyed by
  `<room>:<index within the room>` in base 36, with a two-entry memo of room names so that a shelf
  renders its room once (ADR-0034). Recency is the order of use, never a clock.
- `errors.ts` — the named domain errors a request can end with instead of a result: cancelled,
  failed in `@core`, refused as stale or malformed, or unanswerable because the thread is gone.
  `@core`'s own classes do not survive `postMessage`, so the name travels as data and is rebuilt
  here. A search is described by its query's length, never by its text.
- `response.ts` — the other direction of the wire narrowed from `unknown`. A message from the worker
  is untrusted data crossing a boundary just as a payload to it is. A `found` address is narrowed by
  shape, as a `located` one is, and its offset only to a number.
- `loop.ts` — the message loop that runs the handler on the thread. It queues requests, answers a
  cancellation on arrival, and **yields to the event loop** between slices of about 4 ms, which is
  what lets a cancellation be read at all. It owns the random source a search is placed and padded
  with, `core`'s `defaultRandomSource`, and hands it to the handler. Transport-agnostic:
  `attachWorkerLoop` narrows a worker scope and wires it up.
- `entry.ts` — the module `new Worker(...)` loads. One expression. **Not exported from
  `index.ts`**, because importing it runs it.
- `client.ts` — the client that owns the `Worker`. Issues the monotonic request ids, reads through
  `GenerationCache` before the boundary rather than behind it, fans a shelf out over 32
  single-address requests and aggregates them, rejects a cancelled request with
  `CancelledRequestError` and ignores the reply that was already in flight (ADR-0016), and warms up
  on one throwaway page at a fixed address. `search` is never cached, and its offset is bounded
  against the request it answers: a query of `n` code points starts at an integer from `0` to
  `PAGE_LENGTH - n`.

## What cannot be imported

- `three`
- `gsap`
- `@engine`, `@motion`, `@state`, `@ui`, `@app` — the worker client does not reach into the scene,
  the interface or the composition root

Nothing here reaches for a main-thread frame API: no `requestAnimationFrame`, no reading the
renderer's timings, nothing that belongs to the loop this layer exists to keep clear.
`loop.ts` does read `performance.now()`, and that is the one deliberate exception: it is the
worker's own monotonic clock, used for nothing but bounding how long the thread may compute before
handing the event loop back, and the alternative — counting requests instead of milliseconds —
would be a budget that varied by a factor of two between the machines in ADR-0005.

## Imports allowed

- All of `@core` at runtime, the generation surface included. This is the only layer that may
  generate a page (ADR-0005, ADR-0029); every other layer reaches one through `client.ts`.
- Type-only imports from anywhere

## What calls @worker

- `@ui`, through `client.ts` and nothing else, for pages, titles and search results
- `@app`, when it wires the client to the rest

Every other layer sees this one as types only. The client is where the thread boundary is crossed,
so there is one place to look when a request goes missing.
