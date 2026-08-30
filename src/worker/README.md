# @worker

Worker client. The thread boundary: calls `@core` at runtime and sends/receives messages with the worker.

## What belongs here

- Initialization and message passing
- Marshalling data for the worker
- Request/response handling
- Worker-side counterpart lives in the worker thread (out of scope for this layer)

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
