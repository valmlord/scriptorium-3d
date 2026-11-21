# Architectural invariants

Breaking one of these is a blocking review comment, not a matter of taste.

---

## 1. Layers

Every layer may import anything from any other layer **as a type**. A type is a promise to the compiler
and disappears at build time, so a type-only import crosses no boundary that matters. The table below is
therefore about **runtime** imports, and it is what the ESLint config enforces, block by block.

| layer    | may import at runtime                                         |
| -------- | ------------------------------------------------------------- |
| `core`   | nothing outside `core` — not `three`, not `gsap`, not the DOM |
| `worker` | all of `core`. The only layer that may generate               |
| `engine` | `three`; `core`'s address model                               |
| `motion` | `gsap`; `core`'s address model                                |
| `state`  | `core`'s address model                                        |
| `ui`     | `@state`, `@worker/client`; `core`'s address model            |
| `app`    | everything except `core`'s generation surface                 |

`src/main.ts` is not a layer directory, and what it does is compose the layers, so it is held to `app`'s
row. It had no rule of its own until ADR-0029, which made it the one file that ran on page load with no
boundary around it at all.

**The line through `core` runs inside it, not around it** (ADR-0029). ADR-0005 keeps _generation_ off the
main thread — it measured a shelf of 32 titles at 14.8 to 45.0 ms on four machines — and that argument does
not reach `toLinear` on a five-field address or a constant naming how many volumes a shelf holds:

| group                  | modules                                             | who may call it at runtime |
| ---------------------- | --------------------------------------------------- | -------------------------- |
| the address model      | `address`, `alphabet`, `bignum`, `errors`, `format` | every layer                |
| the generation surface | `prf`, `feistel`, `library`, and the `index` barrel | `worker` only              |

1. **`core` imports nothing.** No DOM, no `three`, no `gsap`, no `window`, no `performance`. It runs
   unchanged in Node, in a worker and in a test. This is what makes the library provable.
2. **`engine` never imports `ui`, and `ui` never imports `three`.** A DOM overlay that reaches into the
   scene graph, or a mesh that reaches into a panel, is how a codebase stops being separable.
3. **`motion` never imports `three`.** It animates numbers (ADR-0004). Timelines must be testable without
   a WebGL context. The mirror holds too: outside `app`, `three` runs only in `engine` and `gsap` only in
   `motion`.
4. **Nothing but `worker` generates a page at runtime** (ADR-0005). A direct `getPage` on the main thread
   is a dropped frame waiting for the right moment. Every other layer reaches a page through
   `@worker/client`, which is also the only module of `worker` that `ui` may call: the protocol, the
   handler and the message loop are the thread's own business.
5. **`core`'s `index` barrel is closed to every layer but `worker`.** It re-exports `library`, so a rule
   phrased on the module alone is defeated by one import statement — which is how `app/url.ts` was
   reaching the generation module for `FORMAT_VERSION`. Other layers import the specific module they
   need, as `engine` already does with `@core/address`.

The import rules are enforced in the ESLint config. **All seven layer directories have a block there, and
so does the composition root** — a layer with no block is a boundary that reads as enforced and is not,
which is what ADR-0029 found in `state`, in `app` and in `src/main.ts`. `src/__tests__/` has no block on
purpose: it holds the checks and helpers about the repository as a whole, which belong to no layer. The
production-bundle test imports `@core/prf` to name `DOMAIN_TAG`, because what it asserts is which thread
that surface is shipped on (ADR-0032). A layer's tests may import a helper from there by relative path, and
a helper there imports nothing but Node built-ins, so the directory never relays a layer import around a
lint block; that is this paragraph's rule, and no lint block enforces it. The lint rules are the
specification; the table above is their explanation.

`no-restricted-imports` matches the static import forms of every row. **`core`'s split alone has a second
rule behind it**, and the two divide the work rather than overlap: the first holds the canonical `@core/*`
alias, where its type-only exemption has to be exact, and `no-restricted-syntax` regexes hold what that
syntax cannot express — the dynamic `import()`, which the first rule does not visit at all; every
**relative** path into `core`, which must use the alias instead; and a non-canonical alias spelling such
as `@core//library` or `@core/address/../library`. Each reports what it actually found, so a spelling
problem is reported as a spelling problem: `@core//address` names the address model, and a message about
generation would contradict the table above.

Which means the **dynamic form of every other refusal here is still open** — `await import('three')` in
`motion` lints clean, as does `await import('@ui/index')` in `engine`. That is a gap in all eight blocks
rather than a property of this change, and ADR-0029 records it, with the rest of what the rules do not
cover, instead of a document claiming otherwise.

One half of invariant 1 is not the lint rule's to enforce and never was. A `no-restricted-imports` group
matches import strings, so it cannot see a global: what keeps `window`, `document` and `performance` out of
`core` is `tsconfig.core.json`, which compiles `src/core/**` against `lib: ["ES2023"]` with no DOM, and
`npm run typecheck` runs it on every push.

What every one of these matches is the **import string**, not the file it resolves to, which is why the
same module needs refusing under more than one spelling. The layer groups are written on the `@layer/*`
aliases that every import in this repository uses, so a relative cross-_layer_ import — `../ui/index`
from `engine` — is still outside what they see. For `core` that is closed: a relative path into it is
refused outright. For the other six layers ADR-0029 records it as open rather than leaving it to be
discovered.

`src/__tests__/layer-boundaries.test.ts` drives the real ESLint API over throwaway files written into each
layer directory and asserts every case in both directions: the violating snippet fires, the legal one
stays silent. A lint rule nobody has watched fail is not a rule.

---

## 2. The render loop

- Exactly **one** `setAnimationLoop`. No `requestAnimationFrame` anywhere else.
- **One writer per property per frame.** The rig writes the camera; nothing else does.
- No allocation in the loop. `Vector3`, `Matrix4`, `Color` scratch objects are module-level singletons —
  a `new THREE.Vector3()` per frame at 60 fps is 3600 objects a minute handed to the GC.
- Anything above ~1 ms of computation belongs in the worker, not the frame.

## 3. The scene

- Books are **instanced**. 640 spines to a room is one `InstancedMesh` and one draw call, never 640 meshes.
  A spine carries its own title through a per-instance offset into one canvas atlas, so the draw call
  count does not grow with the number of shelves that have acquired titles (M6, `engine/titles.ts`).
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
- The open **page** is a component of the `book` state rather than a fifth level, because a turn moves no
  camera (SPEC §6). Turning is interruptible, and it is interruptible by ADR-0030's rules with the DOM in
  the place of the camera rig rather than by a second model of its own (ADR-0032).
- The URL is written from the FSM and parsed into it. No other code touches `location`.

## 5. Determinism

The library must be reproducible everywhere, forever:

- No `Math.random()` in generation. Randomness exists only in explicit user-facing choices — "open a random
  book", "pad this query with random filler" — and is passed in as an argument, never reached for inside.
- No `Date.now()`, no locale-dependent behaviour, no `toLocaleLowerCase()` in `core` (Turkish `I` alone is
  enough to fork the library for some users).
- `bigint` throughout the address space. A `number` cannot hold a room index and never will.
