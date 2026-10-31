# Architectural invariants

Breaking one of these is a blocking review comment, not a matter of taste.

---

## 1. Layers

```
core   →  (nothing)
worker →  core
engine →  (three only)
motion →  (gsap only)
state  →  core types
ui     →  state, worker client, i18n
app    →  everything, and it is the only layer allowed to
```

1. **`core` imports nothing.** No DOM, no `three`, no `gsap`, no `window`, no `performance`. It runs
   unchanged in Node, in a worker and in a test. This is what makes the library provable.
2. **`engine` never imports `ui`, and `ui` never imports `three`.** A DOM overlay that reaches into the
   scene graph, or a mesh that reaches into a panel, is how a codebase stops being separable.
3. **`motion` never imports `three`.** It animates numbers (ADR-0004). Timelines must be testable without
   a WebGL context.
4. **Nothing but `worker/client` calls `core` at runtime** (ADR-0005). A direct `getPage` on the main
   thread is a dropped frame waiting for the right moment.

These are enforced with `no-restricted-imports` in the ESLint config. The lint rule is the specification;
this list is its explanation.

---

## 2. The render loop

- Exactly **one** `setAnimationLoop`. No `requestAnimationFrame` anywhere else.
- **One writer per property per frame.** The rig writes the camera; nothing else does.
- No allocation in the loop. `Vector3`, `Matrix4`, `Color` scratch objects are module-level singletons —
  a `new THREE.Vector3()` per frame at 60 fps is 3600 objects a minute handed to the GC.
- Anything above ~1 ms of computation belongs in the worker, not the frame.

## 3. The scene

- Books are **instanced**. 640 spines to a room is one `InstancedMesh` and one draw call, never 640 meshes.
- Per-instance appearance is derived deterministically from the address, never from `Math.random()` —
  otherwise a room looks different each time it is entered, and the library stops being a place.
- Textures and geometries are disposed when a room is unloaded. WebGL memory is not garbage collected.
- Level of detail decides what is generated, not merely what is drawn: titles are resolved when the camera
  is close enough to read them and cancelled when it is not.

## 4. State

- The navigation FSM in `state/` is the single source of truth for where the user is. The camera, the URL
  and the overlays are **projections** of it, never independent copies.
- Transitions are explicit and total: an unhandled `(state, event)` pair throws in development instead of
  being silently ignored.
- The URL is written from the FSM and parsed into it. No other code touches `location`.

## 5. Determinism

The library must be reproducible everywhere, forever:

- No `Math.random()` in generation. Randomness exists only in explicit user-facing choices — "open a random
  book", "pad this query with random filler" — and is passed in as an argument, never reached for inside.
- No `Date.now()`, no locale-dependent behaviour, no `toLocaleLowerCase()` in `core` (Turkish `I` alone is
  enough to fork the library for some users).
- `bigint` throughout the address space. A `number` cannot hold a room index and never will.
