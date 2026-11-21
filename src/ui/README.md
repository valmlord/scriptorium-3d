# @ui

DOM overlays and interface. Reads `@state`, emits navigation events.

## What belongs here

- DOM element creation and management
- Text and button rendering
- Search input handling
- Address display and formatting
- Responsive layout and styling

## What is here now

- `page-grid.ts` — the reader's grid as arithmetic: 3200 characters cut into 80 lines of 40, and each
  line cut into the runs inside and outside the phrase a search marks. Pure, and in its own module so
  that it can be unit-tested without a browser (`testing.md` section 1).
- `reader.ts` — the reader overlay. The page the navigation machine says is open, as 80 line
  elements of real DOM text: selectable, copyable and readable by a screen reader, which a texture
  is not. It is a projection of `@state` and holds no record of its own, and a page is written to
  the DOM only while the machine still has that page open, which is what makes an interrupted turn
  safe (ADR-0032). The generation client is injected rather than imported, because `@app` owns it
  and the title resolver shares one cache with the reader. It marks the phrase a search found with a
  `<mark>` per line the phrase crosses, only while the machine has the hit's page open.
- `reader.css` — its styles. Two rules are load-bearing rather than decorative: the monospace stack,
  without which the grid is 80 ragged rows, and `white-space: pre`, without which a line of the
  alphabet's symbol 0 renders as nothing and a copied selection is not the page.
- `query.ts` — what the user typed, judged: an accepted query or a refusal that says what is wrong
  and where. The raw length is bounded at 6400 UTF-16 units, and a run of more than one combining
  mark is refused before `normalize` runs. Unknown symbols are reported before emptiness, so a lone
  tab is named rather than called empty (ADR-0035). A refused character is named by the cluster
  typed at its one-based position, by code point, and by its glyph only when that is printable. The
  message is a list of segments, data rather than markup. Pure.
- `search-session.ts` — one search at a time, from a submitted input to the machine flying to the
  page that holds it. Every submit cancels the search in flight before the new input is judged, a
  reply acts only while its request is still the current one, compared by identity, and a navigation
  event the session did not dispatch supersedes the search (ADR-0033). A failure is shown as a fixed
  string, never as an error's message. DOM-free, so its rules are unit-tested whole.
- `highlight.ts` — the last search hit, which the reader marks while the machine has its page open.
  The one holder of the hit, and not a second record of where the user is.
- `search.ts` — the search panel: a `<form role="search">` with a labelled `<textarea>`, the pad mode
  as two radios, a `role="status"` line for the result and a `role="alert"` for a refusal. A view of
  the session and nothing more. Typed and generated text reaches the DOM as text only. Reached only
  from Playwright.
- `search.css` — its styles.
- `room-name.ts` — a room's name bounded for a line a person reads, the panel's status line and the
  console line `src/main.ts` writes for a refused shelf, because the last room's name is 3197
  characters. Pure.
- `errors.ts` — the one refusal this layer owns: a page that arrives from the worker without being
  `PAGE_LENGTH` characters long.

`query.ts`, `search-session.ts`, `highlight.ts`, `page-grid.ts` and `room-name.ts` each have a coverage
floor of their own (`testing.md` section 8). Still to come: the i18n dictionary and language switch
(M10). The chrome is in English until then; the library's own text is always Cyrillic (SPEC section
8).

## What cannot be imported

- `three` — the UI does not reach into the scene. Type-only imports of it are allowed
- `gsap` — timelines belong to `@motion` (ADR-0004). A page turn is therefore not an animation here;
  if it ever becomes one it is a `@motion` timeline driven from `@app` (ADR-0032)
- `@core`'s generation surface — `prf`, `feistel`, `library` and the `index` barrel (ADR-0029)
- Everything in `@worker` except `client.ts`: the protocol, the handler, the message loop, the cache
  and the barrel that re-exports them are the thread's own business. `errors.ts` is among them, which
  is why the reader tells a cancelled request from a failed one by asking whether the machine still
  wants that page rather than by inspecting an error class
- `@engine/*`, `@motion/*`, `@app/*` at runtime

## Imports allowed

- `@state/*` at runtime, for FSM queries and event emission
- `@worker/client` at runtime, for pages, titles and search results
- `@core`'s address model at runtime, for formatting and validating an address, for `normalize`, and
  for the address errors the search session catches by class
- Type-only imports from any layer

## What calls @ui

- `@app` for setup and lifecycle

`@state` does not call in. The FSM is the source of truth and the overlays are a projection of it
(architecture §4), so `@ui` reads `@state` and never the other way round.
