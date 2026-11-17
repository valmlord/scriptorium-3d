# @app

Application root. The layer allowed to import every other one, and the place where integration happens.

## What belongs here

- Main initialization
- Wiring all layers together
- Event handling and coordination
- Error handling at the boundary
- The URL codec in `url.ts`: the SPEC §7 fragment to an `Address` and back, as a pure pair of
  functions. It touches no browser global — `architecture.md` §4 gives the URL to the navigation FSM
  and nothing else may read `location`.

## What cannot be imported

- `@core`'s generation surface — `prf`, `feistel`, `library` and the `index` barrel. `@app` runs on
  the main thread, which is exactly what ADR-0005 keeps generation off; a page arrives through
  `@worker/client` (ADR-0029). This is the layer's one restriction, and `src/main.ts` carries it too

## Imports allowed

- Everything else: `@core`'s address model, `@worker`, `@engine`, `@motion`, `@state`, `@ui`,
  `three`, `gsap`

## Responsibilities

- Create the Three.js renderer and canvas
- Initialize the FSM and listen for state changes
- Wire up the UI to emit events to the FSM
- Pass scene updates from the FSM to the engine
- Pass animation requests from the state to motion
- Serialise and parse the shareable URL, and refuse a fragment that is not this format's
