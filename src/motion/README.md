# @motion

Animation timeline and easing. Drives numerical values; does not know about Three.js.

## What belongs here

- GSAP timelines and tweens
- Animation callbacks
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

- `@app`, which owns the wiring: a timeline animates a plain `CameraRig` of numbers and `@app` hands
  that rig to `@engine`, where it is applied to the camera once per frame (ADR-0004)

`@engine`, `@state` and `@ui` see this layer as types only.
