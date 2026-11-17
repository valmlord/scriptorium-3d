# @state

Navigation finite state machine. The single source of truth for where the user is.

## What belongs here

- FSM definition and transitions
- Session state (current room, current page, etc.)
- Validation of navigation requests

## What cannot be imported

- `three`
- `gsap`
- `@core`'s generation surface — `prf`, `feistel`, `library` and the `index` barrel (ADR-0029)
- `@worker/*`, `@engine/*`, `@motion/*`, `@ui/*`, `@app/*` at runtime
- Direct DOM manipulation (use `@ui` for interface updates)

## Imports allowed

- `@core`'s address model at runtime — `@core/address` and the four modules beside it — for
  validating and moving between addresses
- Type-only imports from any layer

The FSM is the source of truth for **where** the user is, not for the text at that address, so it
does not fetch: a page is asked for by whatever renders it, through `@worker/client`. If a milestone
finds otherwise, the table in `docs/architecture.md` §1 and the block in `eslint.config.js` change
together in one pull request (ADR-0029).

## What calls @state

- `@ui` for interface updates: it reads FSM state and emits events back
- `@app` for initialization and event handling

`@engine` and `@motion` see this layer as types only; `@app` reads the FSM and hands them the values
they need.
