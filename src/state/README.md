# @state

Navigation finite state machine. The single source of truth for where the user is.

## What belongs here

- FSM definition and transitions
- URL parsing and generation
- Session state (current room, current page, etc.)
- Validation of navigation requests

## What cannot be imported

- `three`
- `gsap`
- Direct DOM manipulation (use `@ui` for interface updates)

## Imports allowed

- `@core/*` for address validation and search
- `@worker/*` for data fetching (optional, for search results)
- Type-only imports from any layer

## What calls @state

- `@app` for initialization and event handling
- `@engine` for camera/scene updates (reads FSM state)
- `@ui` for interface updates (reads FSM state and emits events)
- `@motion` for transition animations
