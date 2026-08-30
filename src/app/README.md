# @app

Application root. The only layer allowed to import everything, and the place where integration happens.

## What belongs here

- Main initialization
- Wiring all layers together
- Event handling and coordination
- Error handling at the boundary

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
