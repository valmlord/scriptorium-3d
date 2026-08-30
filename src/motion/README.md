# @motion

Animation timeline and easing. Drives numerical values; does not know about Three.js.

## What belongs here

- GSAP timelines and tweens
- Animation callbacks
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

- `@engine` for camera and object animation
- `@state` for navigation transitions
- `@ui` for overlay animations
