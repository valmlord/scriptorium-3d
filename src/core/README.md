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
| `alphabet.ts` | the 36-symbol page alphabet, the room-name alphabet, search normalization            |
| `bignum.ts`   | fixed-width radix codec, text ↔ `bigint`                                             |
| `address.ts`  | the address model, linearisation, room names, validation                             |
| `prf.ts`      | the Feistel round function: SHA-256 in counter mode (SPEC §4.3)                      |
| `feistel.ts`  | the 10-round balanced network over `Z_(36^3200)` and its inverse (SPEC §4.4)         |
| `library.ts`  | the public API: `getPage`, `locate`, `getTitle`, `search`, `randomAddress` (SPEC §5) |
| `errors.ts`   | the domain error types                                                               |

The dependency order is one-directional:
`alphabet` → `bignum` → `address` → `prf` → `feistel` → `library`.

`@noble/hashes` is the single runtime dependency, and the only one `core` is permitted: a
hand-rolled SHA-256 that is subtly wrong still produces convincing-looking output and would
corrupt the library invisibly (code-style §7).

## What cannot be imported

- `three`
- `gsap`
- `window`, `document`, `navigator` or any browser API
- Any layer: `@worker`, `@engine`, `@motion`, `@state`, `@ui`, `@app`
- Only `@core` may import `@core`

## Type-only imports

Type-only imports from any layer are allowed, as they do not create runtime dependencies.
