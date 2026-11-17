# @core

Core domain logic. No side effects, no I/O, no dependencies on Three.js, GSAP, DOM or browser APIs.

## What belongs here

- Address model and validation
- The Feistel bijection
- Page generation
- Search logic
- Any pure computation that runs unchanged in Node, in a worker, and in tests

## Layout

| File          | What it holds                                                                        |
| ------------- | ------------------------------------------------------------------------------------ |
| `format.ts`   | `FORMAT_VERSION`, the version of the frozen format (SPEC §4.5)                       |
| `alphabet.ts` | the 36-symbol page alphabet, the room-name alphabet, search normalization            |
| `bignum.ts`   | fixed-width radix codec, text ↔ `bigint`                                             |
| `address.ts`  | the address model, linearisation, room names, validation                             |
| `prf.ts`      | the Feistel round function: SHA-256 in counter mode (SPEC §4.3)                      |
| `feistel.ts`  | the 10-round balanced network over `Z_(36^3200)` and its inverse (SPEC §4.4)         |
| `library.ts`  | the public API: `getPage`, `locate`, `getTitle`, `search`, `randomAddress` (SPEC §5) |
| `errors.ts`   | the domain error types                                                               |

The dependency order is one-directional:
`alphabet` → `bignum` → `address` → `prf` → `feistel` → `library`. `format` stands outside it: it
imports nothing and nothing in `core` depends on it, though the barrel re-exports it.

**This layer is not importable as a whole.** Which of these modules a layer outside `core` may
import at runtime is the table in `docs/architecture.md` §1 and the blocks in `eslint.config.js`,
and it is not restated here (ADR-0013): the line of ADR-0029 runs between the address model and the
generation surface, and the `index.ts` barrel re-exports both, so only `@worker` may import it.

`@noble/hashes` is the single runtime dependency, and the only one `core` is permitted: a
hand-rolled SHA-256 that is subtly wrong still produces convincing-looking output and would
corrupt the library invisibly (code-style §7).

## What cannot be imported

- `three`
- `gsap`
- `window`, `document`, `navigator` or any browser API — kept out by `tsconfig.core.json`, which
  compiles this directory with no DOM lib, not by the lint rule, which cannot see a global
- Any layer: `@worker`, `@engine`, `@motion`, `@state`, `@ui`, `@app`

## Type-only imports

Type-only imports from any layer are allowed, as they do not create runtime dependencies.

## What calls @core

- `@worker` — all of it, generation included
- `@engine`, `@motion`, `@state`, `@ui`, `@app` — the address model only
