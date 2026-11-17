# @ui

DOM overlays and interface. Reads `@state`, emits navigation events.

## What belongs here

- DOM element creation and management
- Text and button rendering
- Search input handling
- Address display and formatting
- Responsive layout and styling

## What cannot be imported

- `three` — the UI does not reach into the scene. Type-only imports of it are allowed
- `gsap` — timelines belong to `@motion` (ADR-0004)
- `@core`'s generation surface — `prf`, `feistel`, `library` and the `index` barrel (ADR-0029)
- Everything in `@worker` except `client.ts`: the protocol, the handler, the message loop, the cache
  and the barrel that re-exports them are the thread's own business
- `@engine/*`, `@motion/*`, `@app/*` at runtime

## Imports allowed

- `@state/*` at runtime, for FSM queries and event emission
- `@worker/client` at runtime, for pages, titles and search results
- `@core`'s address model at runtime, for formatting and validating an address
- Type-only imports from any layer

## What calls @ui

- `@app` for setup and lifecycle

`@state` does not call in. The FSM is the source of truth and the overlays are a projection of it
(architecture §4), so `@ui` reads `@state` and never the other way round.
