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
- The choreography in `choreography.ts`: the navigation machine, the engine's camera poses and
  the flight, joined. It has no three.js and no DOM in it, which is what lets an interrupted
  flight be tested without a WebGL context.
- The controls in `controls.ts`: the pointer and the keyboard turned into navigation events. The
  only part of M5 that touches the DOM.
- The debug hook in `debug.ts`: `window.__scriptorium` as `testing.md` section 7 specifies it,
  installed from `src/main.ts` in development and test builds only.
- What idleness is made of, in `idle.ts`: the camera, the worker client's request table, the reader
  and the title resolver, re-read after every settlement because settling one of them can make
  another busy. `waitForIdle()` is composed from this and the hook holds no opinion of its own.
- The title resolver in `titles.ts`: one shelf of 32 titles requested as the machine reaches a
  shelf, cancelled when it leaves, and written onto that room's spines. A room is twenty shelves and
  ADR-0005 measured one at 14.8 to 45.0 ms, so asking for a room is never what happens.

## What cannot be imported

- `@core`'s generation surface — `prf`, `feistel`, `library` and the `index` barrel. `@app` runs on
  the main thread, which is exactly what ADR-0005 keeps generation off; a page arrives through
  `@worker/client` (ADR-0029). This is the layer's one restriction, and `src/main.ts` carries it too

## Imports allowed

- Everything else: `@core`'s address model, `@worker`, `@engine`, `@motion`, `@state`, `@ui`,
  `three`, `gsap`

## Responsibilities

- Own the one `GenerationClient`, so the reader and the spine titles share one cache and one thread
- Create the Three.js renderer and canvas
- Initialize the FSM and listen for state changes
- Wire up the UI to emit events to the FSM
- Pass scene updates from the FSM to the engine
- Pass animation requests from the state to motion
- Serialise and parse the shareable URL, and refuse a fragment that is not this format's
