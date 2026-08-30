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
- Type-only imports from `three` are allowed everywhere, but runtime use is restricted to `@engine` and `@motion`

## Imports allowed

- `three` at runtime
- `@state/*` for FSM queries (read-only)
- `@motion/*` for animation callbacks
- Type-only imports from any layer

## What calls @engine

- `@app` for setup and lifecycle
- `@state` for reactive updates (e.g., room change)
