# @app

Application root. The only layer allowed to import everything, and the place where integration happens.

## What belongs here

- Main initialization
- Wiring all layers together
- Event handling and coordination
- Error handling at the boundary
- The URL codec in `url.ts`: the SPEC §7 fragment to an `Address` and back, as a pure pair of
  functions. It touches no browser global — `architecture.md` §4 gives the URL to the navigation FSM
  and nothing else may read `location`.

## What cannot be imported

- (Nothing is restricted; `@app` imports everything)

## Imports allowed

- Everything: `@core`, `@worker`, `@engine`, `@motion`, `@state`, `@ui`

## Responsibilities

- Create the Three.js renderer and canvas
- Initialize the FSM and listen for state changes
- Wire up the UI to emit events to the FSM
- Pass scene updates from the FSM to the engine
- Pass animation requests from the state to motion
- Serialise and parse the shareable URL, and refuse a fragment that is not this format's
