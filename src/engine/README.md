# @engine

Three.js scene and rendering. Low-level mesh manipulation, rendering loop, camera rig.

## What belongs here

- Scene graph management
- Mesh creation and instance updates
- Camera and rig logic
- The render loop: exactly one `setAnimationLoop`
- Geometry and material setup

## What cannot be imported

- `@ui/*` — the scene graph does not reach into the interface
- `gsap` — animations are numbers from `@motion`, not GSAP timelines
- `@core`'s generation surface — `prf`, `feistel`, `library` and the `index` barrel. A `getPage` in a
  layout function is a dropped frame (ADR-0005, ADR-0029)
- `@worker/*`, `@motion/*`, `@state/*`, `@app/*` at runtime

## Imports allowed

- `three` at runtime; type-only imports of it are allowed in every layer, but runtime use is
  `@engine`'s and `@app`'s alone
- `@core`'s address model at runtime — `@core/address`, `@core/alphabet`, `@core/bignum`,
  `@core/errors`, `@core/format`. The structural constants and the linearisation have one home and
  cost nothing to call (ADR-0029)
- Type-only imports from any layer

## What calls @engine

- `@app` for setup and lifecycle, and for passing it what the FSM and the timelines produce

`@state` and `@motion` do not call in: they are read as types and composed by `@app`, which is what
keeps a scene-graph call out of a transition table.
