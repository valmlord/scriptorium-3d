# @core

Core domain logic. No side effects, no I/O, no dependencies on Three.js, GSAP, DOM or browser APIs.

## What belongs here

- Address model and validation
- The Feistel bijection
- Page generation
- Search logic
- Any pure computation that runs unchanged in Node, in a worker, and in tests

## What cannot be imported

- `three`
- `gsap`
- `window`, `document`, `navigator` or any browser API
- Any layer: `@worker`, `@engine`, `@motion`, `@state`, `@ui`, `@app`
- Only `@core` may import `@core`

## Type-only imports

Type-only imports from any layer are allowed, as they do not create runtime dependencies.
