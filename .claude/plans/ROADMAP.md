# ROADMAP

One milestone, one branch, one pull request into `main`. Atomic commits inside it, green CI, squash-merge.
A milestone is closed only when its **review gate** passes — not when the code runs.

Every milestone ships its tests in the same pull request. A PR that only adds code is not finished; the
standard for each layer is in `.claude/rules/testing.md`. Branch naming follows `.claude/rules/commits.md`.

---

## M0 — `chore/infra-project-bootstrap`

Vite + TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), path aliases per
layer, a `tsconfig.core.json` without the DOM lib, ESLint flat config carrying the `no-restricted-imports`
layer rules, Prettier, Vitest with per-path coverage thresholds, Playwright, husky + lint-staged +
commitlint, GitHub Actions running typecheck · lint · test · e2e · build, and a Pages deploy workflow.

**Tests.** Layer-boundary tests driving the ESLint API: each rule is asserted to fire on a violating
snippet and stay silent on a legal one. One Playwright smoke test: the app boots, the canvas has a WebGL
context, the console is clean.

**Done when.** CI is green, and removing a layer rule turns a test red. A lint rule nobody has seen fail is
not a rule.

## M1 — `feat/core-alphabet-and-addressing`

`alphabet.ts`, `bignum.ts`, `address.ts`. Text ↔ `bigint` in radix 36 with fixed length and preserved
leading zeros; `Address` ↔ linear index; room-name codec; normalization that reports unknown symbols
instead of substituting them.

**Tests.** Property tests over ≥1000 cases for both roundtrips. Explicit edge cases: room 0, the last legal
room, the last legal address in the partially-filled final room, the first invalid one, and a page of 3200
index-0 symbols — leading zeros are where fixed-length radix conversion breaks. The fast `toString(36)`
path is verified against a naive divide-by-radix implementation.

**Done when.** `src/core` is at 100% line and branch coverage and the invalid tail of the last room is
covered by a named test rather than argued about in a comment.

## M2 — `feat/core-feistel-bijection`

`prf.ts`, `feistel.ts`, `library.ts` — the public API of §5 of the SPEC. Golden vectors committed, with
their regeneration script and its warning.

**Tests.** `locate(getPage(a)) === a` and the reverse as property tests; the `search` property that the
query really lands at the returned offset; symbol distribution uniform within tolerance; golden vectors;
`vitest bench` for `getPage`/`locate` against the committed baseline; Stryker at ≥85%.

**Done when.** All of the above pass, and the SHA-256 round function is checked against published test
vectors rather than only against itself.

**Review gate.** Why does a balanced Feistel cover `[0, N)` exactly, and what breaks if `PAGE_LENGTH`
becomes odd? What does the `u32be(length)` prefix in the seed prevent, concretely?

## M3 — `feat/worker-page-generation`

Worker plus typed client: request ids, cancellation, LRU cache, warm-up on startup.

**Tests.** The protocol handler unit-tested as a pure function, including malformed and out-of-order
messages. One integration test through a real `Worker`. Cancellation asserted by outcome — a cancelled
request never resolves and its result never reaches the cache.

**Done when.** Generating 32 shelf titles drops no frame, measured rather than asserted by feel.

## M4 — `feat/engine-hexagonal-room`

Renderer bootstrap, colour space and tone mapping, fog. Hexagonal room: four shelf walls, two doorways,
five shelves apiece, 32 spines each — 640 spines as one `InstancedMesh`, coloured deterministically from
the address. Lighting. Disposal on room unload.

**Tests.** Layout arithmetic as pure functions: shelf and spine transforms, and the `instanceId ↔ Address`
mapping round-tripped over all 640 slots. Determinism test: building the same room twice yields identical
matrices and colours. Disposal test: unloading releases every geometry, material and texture it created.

**Done when.** 60 fps on the reference machine, one draw call for the spines, no per-frame allocation.

## M5 — `feat/motion-camera-choreography`

`CameraRig`, the master timeline with a label per level, the navigation FSM, raycast picking by
`instanceId`, hover states, the `window.__scriptorium` debug hook.

**Tests.** Exhaustive FSM transition table — every `(state, event)` pair asserted as legal or rejected.
Timelines advanced under GSAP's ticker with fake time, asserting rig values at each label and that
`.reverse()` returns the rig to its starting values within epsilon. Interruption test: a transition
interrupted mid-flight leaves the FSM and the rig consistent.

**Done when.** Room → wall → shelf → book is one continuous flight, and back is that same timeline reversed.

**Review gate.** What happens when a transition is interrupted halfway by a new one?

## M6 — `feat/ui-book-reader`

Book opening, the reader (3200 characters on a 40×80 grid), page turning, spine titles through a canvas
texture atlas.

**Tests.** E2E: the reader shows exactly 3200 characters, they match `getPage` for that address, the text
is selectable, and page turns are interruptible. Titles asserted to equal the first 25 characters of page 0.

**Done when.** Text is real DOM text, not a texture.

## M7 — `feat/ui-search`

Search panel with both padding modes, `search()` wired to a camera flight to the located book, the query
highlighted in the reader.

**Tests.** E2E: typing a phrase flies to a book that demonstrably contains it at the stated offset; a query
with characters outside the alphabet is refused and names them; a 3200-character exact page resolves to its
own address. Axe reports no serious or critical violations on the panel.

**Done when.** The search box is the fastest way to reach a specific book in the library.

## M8 — `feat/app-routing-and-i18n`

Hash router (address ↔ URL, deep links, clipboard, browser history driving the FSM), RU/EN interface.

**Tests.** E2E: a deep link opens the exact address and language it names; back and forward return to the
previous address with the camera agreeing with the URL; an unknown `FORMAT_VERSION` is refused with an
explanation rather than opened at the wrong book; switching language leaves the address untouched.

**Done when.** A copied link reopens exactly what the sender was looking at.

## M9 — `feat/engine-atmosphere`

Corridors and neighbouring rooms receding into fog, the spiral staircase and the mirror from Borges, a
WebAudio ambience, bookmarks in `localStorage`, the intro sequence.

**Tests.** Neighbour-room addressing round-tripped through a corridor walk. Bookmarks survive a reload and
tolerate corrupt `localStorage` content. Audio starts only after a user gesture and is muted by default.

**Done when.** The library reads as infinite rather than as one room with wallpaper.

## M10 — `chore/infra-performance-and-deploy`

Performance pass, `prefers-reduced-motion`, keyboard-only navigation, touch and mobile, OG image, Pages
deploy, README with a recording and an architecture diagram.

**Tests.** Frame-budget assertion during a scripted flight: no frame over 32 ms, under 1% of frames over
20 ms. `prefers-reduced-motion: reduce` replaces flights with cuts and keeps every level reachable.
Keyboard-only path from the entrance to a page of text. Axe clean across the whole app. A test asserting
`window.__scriptorium` is `undefined` in the production bundle.

**Done when.** The public link works on a phone, and the whole hierarchy is reachable without a mouse.
