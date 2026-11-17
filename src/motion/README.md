# @motion

Animation timeline and easing. Drives numerical values; does not know about Three.js.

## What belongs here

- The `CameraRig`: the six numbers a flight animates
- The master timeline, one label per navigation level, and the playhead that moves between them
- The clock: GSAP's root timeline is advanced from the render loop, not from GSAP's own ticker
- Easing and sequencing logic
- Duration and timing calculations

## What cannot be imported

- `three` — timelines animate numbers, not meshes (ADR-0004). Type-only imports of it are allowed
- `@core`'s generation surface — `prf`, `feistel`, `library` and the `index` barrel (ADR-0029)
- `@worker/*`, `@engine/*`, `@state/*`, `@ui/*`, `@app/*` at runtime

## Imports allowed

- `gsap` at runtime; this is the only layer that may, `@app` aside
- `@core`'s address model at runtime — the address, the alphabet, the radix codec, the domain errors
  and the format version. A random address is not here: `randomAddress` is generation, and it
  arrives through `@worker/client`
- Type-only imports from any layer

## What calls @motion

- `@app`, which composes the layers: it builds the flight from the routes `@engine` computes for the
  navigation state, and gives `@engine`'s viewer a callback returning the rig for a given time. The
  write itself is `applyRig` in `@engine/camera`, inside the one render loop (ADR-0004)

`@engine`, `@state` and `@ui` see this layer as types only. A rig that the engine moved and the state
machine also moved would be the two writers ADR-0004 exists to prevent.
