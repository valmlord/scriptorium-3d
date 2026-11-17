# @ui

DOM overlays and interface. Reads `@state`, emits navigation events.

## What belongs here

- DOM element creation and management
- Text and button rendering
- Search input handling
- Address display and formatting
- Responsive layout and styling

## What is here now

- `page-grid.ts` — the reader's grid as arithmetic: 3200 characters cut into 80 lines of 40. Pure,
  and in its own module because it is the one part of this layer that can be unit-tested without a
  browser (`testing.md` section 1).
- `reader.ts` — the reader overlay. The page the navigation machine says is open, as 80 line
  elements of real DOM text: selectable, copyable and readable by a screen reader, which a texture
  is not. It is a projection of `@state` and holds no record of its own, and a page is written to
  the DOM only while the machine still has that page open, which is what makes an interrupted turn
  safe (ADR-0031). The generation client is injected rather than imported, because `@app` owns it
  and the title resolver shares one cache with the reader.
- `reader.css` — its styles. Two rules are load-bearing rather than decorative: the monospace stack,
  without which the grid is 80 ragged rows, and `white-space: pre`, without which a line of the
  alphabet's symbol 0 renders as nothing and a copied selection is not the page.
- `errors.ts` — the one refusal this layer owns: a page that arrives from the worker without being
  `PAGE_LENGTH` characters long.

Still to come: the search panel (M7) and the i18n dictionary and language switch (M10). The reader's
chrome is in English until then; the library's own text is always Cyrillic (SPEC section 8).

## What cannot be imported

- `three` — the UI does not reach into the scene. Type-only imports of it are allowed
- `gsap` — timelines belong to `@motion` (ADR-0004). A page turn is therefore not an animation here;
  if it ever becomes one it is a `@motion` timeline driven from `@app` (ADR-0031)
- `@core`'s generation surface — `prf`, `feistel`, `library` and the `index` barrel (ADR-0029)
- Everything in `@worker` except `client.ts`: the protocol, the handler, the message loop, the cache
  and the barrel that re-exports them are the thread's own business. `errors.ts` is among them, which
  is why the reader tells a cancelled request from a failed one by asking whether the machine still
  wants that page rather than by inspecting an error class
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
