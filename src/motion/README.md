# @motion

Animation timeline and easing. Drives numerical values; does not know about Three.js.

## What belongs here

- The `CameraRig`: the six numbers a flight animates
- The master timeline, one label per navigation level, and the playhead that moves between them
- The clock: GSAP's root timeline is advanced from the render loop, not from GSAP's own ticker
- Easing and sequencing logic
- Duration and timing calculations

## What cannot be imported

- `three` — timelines animate numbers, not meshes
- Type-only imports from `three` are allowed, but runtime use is forbidden

## Imports allowed

- `gsap` at runtime
- `@core/*` for deterministic randomness and address space
- Type-only imports from any layer

## What calls @motion

- `@app`, which composes the layers: it builds the flight, hands it the routes `@engine` computes
  from the navigation state, and applies the rig to the camera once per frame

Nothing in `@engine`, `@state` or `@ui` calls this layer at runtime. A rig that the engine moved and
the state machine also moved would be the two writers ADR-0004 exists to prevent.
