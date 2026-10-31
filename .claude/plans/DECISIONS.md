# Architecture Decision Records

Newest last. An entry is added for every non-trivial decision — choosing a technology or a pattern, or
deviating from `SPEC.md`. An ADR records the alternatives that lost and why, because in six months the
reasoning is the only part that is hard to reconstruct.

---

## ADR-0001 — A 36-symbol alphabet, 3200 characters to a page

**Decision.** Space, all 33 Russian letters including `ё` and `ъ`, comma, full stop. Pages of 3200
characters, as in the original Library of Babel.

**Why.** Dropping `ё` would have made the alphabet 35 symbols and slightly reduced visual noise, but it
also makes a whole class of Russian words unwritable — the library would stop being complete, which is the
single property the whole project exists to have. `ъ` is kept for the same reason.

3200 is inherited from libraryofbabel.info deliberately: it makes the two libraries comparable, and it is
an even number, which §4.1 of the SPEC turns into a structural advantage.

**Consequence.** `36^3200` pages, ~4981 decimal digits, and room names of 3197 characters.

---

## ADR-0002 — A Feistel network, not modular multiplication

**Decision.** The address↔page bijection is a 10-round balanced Feistel network over `Z_(36^3200)` with a
SHA-256 counter-mode round function, rather than the `page = (linear × K) mod N` construction the original
site uses.

**Why.** Both are bijections and both give instant search. But modular multiplication is **linear**:
neighbouring addresses yield correlated pages, and the relationship survives into the visible text. Walking
one shelf would show a pattern where there must be none. A Feistel network costs the same order of time and
destroys that structure.

Ten rounds, not four: four is the theoretical minimum for a strong pseudo-random permutation, and the extra
six cost about 0.5 ms in a construction that runs once per page.

**Alternatives rejected.**
- *Modular multiplication.* Rejected for the linearity above.
- *A seeded PRNG per page.* Simple and fast, but one-directional — search would become impossible, and
  search is half the product.
- *AES-FF1 from a library.* Standardised, but no maintained JS implementation handles a radix-36 domain of
  3200 digits; a bespoke Feistel over `bigint` is 40 lines and testable against its own inverse.

**Consequence.** `PAGE_LENGTH` must stay even, or the balanced split stops covering the domain exactly.

---

## ADR-0003 — The format is frozen and golden vectors enforce it

**Decision.** The alphabet order, `DOMAIN_TAG`, round count, PRF byte count and address linearisation are a
public contract. Committed golden vectors verify them, and `FORMAT_VERSION` is carried in every URL.

**Why.** This library has no database, so there is no migration to write — a one-character change to any of
those constants replaces all `36^3200` books at once and turns every previously shared link into a pointer
at different text. Nothing in the code would fail; users would simply be lied to.

**Consequence.** A red golden-vector test is never fixed by regenerating the fixture. It means the format
changed, and either the change is reverted or `FORMAT_VERSION` is incremented deliberately.

---

## ADR-0004 — GSAP animates a rig, never three.js objects

**Decision.** Camera choreography animates a plain `CameraRig` object of numeric fields. The rig is copied
onto the three.js camera once per frame, inside the render loop. GSAP is never pointed at a `Vector3`, a
`Quaternion` or an `Object3D`.

**Why.** Tweening `camera.position` directly works until something else also wants to move the camera —
damping, collision, a pointer drag — and then two owners write the same property in the same frame and the
result depends on call order. One writer per frame removes that class of bug entirely. It also keeps
`motion/` free of three.js imports, so timelines are unit-testable without a WebGL context.

**Consequence.** Every transition is a timeline with a label, and going back is `.reverse()` of the same
timeline rather than a second animation that has to be kept in sync with the first.

---

## ADR-0005 — Generation lives in a Web Worker

**Decision.** All `core` calls go through a worker client with an LRU cache and cancellation.

**Why.** One page costs ~1.3 ms, which is invisible. A shelf of 32 titles costs ~42 ms, which is three
dropped frames, and the camera is usually flying while those titles are being resolved. Cancellation
matters as much as the thread: fly past a shelf and its titles are no longer wanted.

**Consequence.** The core stays synchronous and pure; asynchrony exists only at the worker boundary.

---

## ADR-0006 — No UI framework

**Decision.** Vite and TypeScript, no React or Svelte.

**Why.** The interface is a handful of overlays over a WebGL canvas — a reader, a search panel, an address
bar. Their state lives in the navigation FSM, not in a component tree, and a virtual DOM buys nothing while
adding a render loop that competes with the real one for frame budget.

**Consequence.** DOM updates are written by hand and must stay confined to `ui/`.

---

## ADR-0009 — Room names parse leniently, render canonically

**Decision.** `roomFromName` accepts a name with leading zeros and resolves it; `roomToName` never produces
one. A separate predicate reports whether a name is canonical, and the router rewrites a non-canonical name
to the canonical form on load.

**Why.** Encoding and parsing pull in opposite directions here. Strict parsing would make a hand-edited or
truncated URL fail instead of landing somewhere sensible, which is hostile for no gain. Lenient parsing
alone, however, makes name→room many-to-one: `1`, `01` and `0001` all reach room 1, so the same page has
unboundedly many URLs and the project's central claim — that a link *is* the page — quietly stops holding.

Splitting the two resolves it: the address space keeps exactly one name per room, while a malformed link
still opens.

**Alternatives rejected.**
- *Reject non-canonical names.* Bijective, but turns a stray keystroke into an error page.
- *Fixed-width names padded to 3197 characters.* Also bijective, and it was briefly implemented, but it
  makes every URL 3197 characters even for room 0 — a cost paid by every shared link to buy uniformity
  nobody sees.

**Consequence.** M8 must rewrite the URL after parsing, not merely accept it.

---

## ADR-0007 — End-to-end tests assert scene state, never pixels

**Decision.** No screenshot comparison of the WebGL canvas. Playwright asserts against a `window.__scriptorium`
debug hook exposing the FSM node, the current address, camera rig values and frame timings, stripped from
production builds. DOM overlays may still be compared visually.

**Why.** A canvas rendered on an Apple GPU and on a CI runner's software rasteriser differ in antialiasing
and gamma by more than any useful tolerance. Pixel tests would fail for reasons unrelated to the change
being reviewed, and a suite that cries wolf gets ignored — at which point it is worse than no suite.
Asserting that the FSM is in `PAGE`, at address X, with the rig settled, tests the thing that actually has
to be true.

The hook also removes fixed-duration sleeps: `waitForIdle()` resolves when timelines have settled and the
worker queue is empty, which is deterministic where `waitForTimeout(2000)` is a guess that eventually fails
on a slow runner.

**Alternatives rejected.**
- *Pixel snapshots with a tolerance.* Tolerance wide enough to survive GPU differences is wide enough to
  miss a wrongly positioned shelf.
- *Headless GL in unit tests.* Tests the driver, not the code, and adds a native dependency to CI.

**Consequence.** Geometry correctness must be provable without rendering, so layout arithmetic lives in
pure functions in `engine/` rather than inline in mesh construction.

---

## ADR-0008 — Mutation testing on `core`

**Decision.** Stryker runs against `src/core` only, nightly and on any PR touching it. Score threshold 85%,
build breaks below 75%.

**Why.** Coverage proves a line executed; it says nothing about whether an assertion would have caught it
being wrong. That distinction is usually academic — here it is the entire risk, because a subtly broken
bijection produces output indistinguishable from correct output. There is no user, no log line and no
exception to tell us. A mutant that survives is a concrete demonstration that some part of the library
could be silently wrong and every test would still pass.

Restricted to `core` because that is where the property holds: pure, fast, and small enough that minutes of
mutation runs are affordable. Mutating scene code would mostly produce timeouts.

---

## ADR-0006 — No UI framework

**Decision.** Vite and TypeScript, no React or Svelte.

**Why.** The interface is a handful of overlays over a WebGL canvas — a reader, a search panel, an address
bar. Their state lives in the navigation FSM, not in a component tree, and a virtual DOM buys nothing while
adding a render loop that competes with the real one for frame budget.

**Consequence.** DOM updates are written by hand and must stay confined to `ui/`.
