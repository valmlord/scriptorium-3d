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

- _Modular multiplication._ Rejected for the linearity above.
- _A seeded PRNG per page._ Simple and fast, but one-directional — search would become impossible, and
  search is half the product.
- _AES-FF1 from a library._ Standardised, but no maintained JS implementation handles a radix-36 domain of
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

**Why.** One page is invisible; a shelf of them is not. Medians of 50 warmed samples from
`npm run bench:report`. The two `ubuntu-latest` columns come from the `generation-cost` job over
five runs on Node 22, image `ubuntu24`, whose benchmark code is identical — CI 41639200450,
41640084878 attempts 1 and 2, 41641061495 and 41641249757. The third was taken by hand on an
Apple-silicon laptop, the fastest machine this library has been measured on:

| Operation            | AMD EPYC 7763 (4 runs)              | Intel Xeon 6975P-C        | Apple silicon             |
| -------------------- | ----------------------------------- | ------------------------- | ------------------------- |
| `getPage`            | 1.34–1.35 ms                        | 1.01 ms                   | 0.56 ms                   |
| `getTitle`           | 0.97–0.98 ms                        | 0.73 ms                   | 0.46 ms                   |
| `locate`             | 1.41–1.44 ms                        | 1.05 ms                   | not reported              |
| A shelf of 32 titles | **32.5–33.4 ms — 1.95–2.00 frames** | **25.1 ms — 1.51 frames** | **14.8 ms — 0.89 frames** |

Two `ubuntu-latest` columns because it is a label and not a machine: those runs landed on two CPU
models, and the Intel one is 34% faster on a page. They are reported separately rather than averaged,
because the average of two machines is a machine that does not exist. Within one model the figures
are reproducible — the four AMD runs span 0.8% on a page and 2.6% on a shelf — so the gap between
the columns is the hardware, not the apparatus. Which is also why the job that produces these
figures carries no threshold of its own: one here would be decided by which host the runner drew.

**On the fastest machine measured a shelf fits inside a frame only by consuming all of it, leaving
nothing to render with; on both runners it does not fit at all.** The camera is usually flying while
those titles are being resolved, so on the runners they are frames the user watches go missing, and
on the laptop they are a frame with no time left in it for the draw calls architecture §2 budgets.
That is the argument for the thread, and it does not depend on which machine the reader has — which
is the point of measuring three. A cold page is worse again: the first `getPage` of a fresh process
measured 4.37 ms on the laptop, 6.97 ms on the Intel runner and 10.5 to 12.1 ms on the AMD one,
roughly eight times the warm figure on every one of them — up to three quarters of a frame for a
single page, which is what the worker's warm-up on startup is for.

And it cannot be optimised away. `getTitle` renders 25 digits where `getPage` renders 3200 and still
costs 71–73% of it on the runners and 81% on the laptop, so what is left when nearly all the
rendering is gone is the Feistel network — whose ten rounds are what keep neighbouring addresses
from producing correlated text (ADR-0002), over a page format that is frozen (ADR-0003). The faster
the machine, the larger that share, because rendering digits is the part that gets cheaper. There is
no cheaper page to generate on any of them.

Cancellation matters as much as the thread: fly past a shelf and its titles are no longer wanted.

**Why these figures name their machines.** Because ADR-0013 requires it, and this record predates
ADR-0013 by eight decisions. It read "one page costs ~1.3 ms" and "a shelf of 32 titles costs
~42 ms, which is three dropped frames", with no machine attached to either — and a performance
figure that names no machine can be neither reproduced nor refuted, which is worse than no figure,
because it reads as evidence. Both were also stale by the time anyone looked: the machines since
measured span close to a factor of ten, and `424c37c` made `getTitle` divide the page value down and
render 25 digits instead of rendering 3200 and discarding 3175, so a shelf stopped being 32 page
costs. The decision above never rested on which of those numbers was right, which is why correcting
them changes nothing else in this record. Issue #17 has the measurement.

**A fourth machine, slower than all three, measured since.** The table above is three machines and
does not claim to be every machine, but anything that cites it for "the slowest machine measured" is
now out of date — `src/worker/loop.ts`'s comment on the 4 ms slice does exactly that. The
`feat/worker-page-generation` container is an **Intel(R) Xeon(R) Processor @ 2.10GHz, 4 logical cores,
15.7 GiB, Node v22.23.4 on linux/x64**: medians of 50 warmed samples from the same
`npm run bench:report` apparatus give `getPage` **2.282 ms**, `getTitle` **1.327 ms**, `locate`
**2.625 ms** and **a shelf of 32 titles 44.990 ms — 2.70 frames**, with a p99 of 64.077 ms on the
shelf. Cold: the first `getPage` of the process 12.427 ms, median of the first 15 3.808 ms — again
about eight times the warm figure, as on all three above.

So the span across the four is a factor of about four on a page and close to three on a title, and the
argument this record rests on only gets stronger: a shelf that does not fit in a frame on either
runner does not fit in two and a half on this one. What moves is any arithmetic built on the span.
ADR-0024's 4 ms slice is three to eight titles on the three machines above and three on this one, and
that is stated there rather than here.

The same pull request's `generation-cost` job on `ubuntu-latest`
([run 41684435446](https://github.com/valmlord/scriptorium-3d/actions/runs/41684435446/job/126086319884),
**AMD EPYC 7763, 4 logical cores, Node v22.23.4, image ubuntu24**) reported `getPage` 1.377 ms,
`getTitle` 1.004 ms and a shelf of 34.194 ms, with a cold first `getPage` of 11.934 ms. That is 0.8 ms
above this record's AMD upper bound on a shelf, inside the 2.6% spread it reports across four runs on
the same model, so the AMD column stands as measured.

**Consequence.** The core stays synchronous and pure; asynchrony exists only at the worker boundary.

---

## ADR-0006 — No UI framework

**Decision.** Vite and TypeScript, no React or Svelte.

**Why.** The interface is a handful of overlays over a WebGL canvas — a reader, a search panel, an address
bar. Their state lives in the navigation FSM, not in a component tree, and a virtual DOM buys nothing while
adding a render loop that competes with the real one for frame budget.

**Consequence.** DOM updates are written by hand and must stay confined to `ui/`.

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

- _Pixel snapshots with a tolerance._ Tolerance wide enough to survive GPU differences is wide enough to
  miss a wrongly positioned shelf.
- _Headless GL in unit tests._ Tests the driver, not the code, and adds a native dependency to CI.

**Consequence.** Geometry correctness must be provable without rendering, so layout arithmetic lives in
pure functions in `engine/` rather than inline in mesh construction.

---

## ADR-0008 — Mutation testing on `core`

**Decision.** Stryker runs against `src/core` only. Score threshold 85%, build breaks below 75%.

_Where it runs was changed by ADR-0014:_ nightly on `main` and on demand, not on the pull request path.
_The thresholds were changed by ADR-0018:_ `break` is 92, with `low` 92 and `high` 93, calibrated on
fifteen observed runs rather than on a swing that turned out to have a cause. The 85 and 75 above are
the figures this decision was taken with and are kept for that reason; they are not the figures in
force. The scope below is unaffected by either.

**Why.** Coverage proves a line executed; it says nothing about whether an assertion would have caught it
being wrong. That distinction is usually academic — here it is the entire risk, because a subtly broken
bijection produces output indistinguishable from correct output. There is no user, no log line and no
exception to tell us. A mutant that survives is a concrete demonstration that some part of the library
could be silently wrong and every test would still pass.

Restricted to `core` because that is where the property holds: pure, fast, and small enough that minutes of
mutation runs are affordable. Mutating scene code would mostly produce timeouts.

---

## ADR-0009 — Room names parse leniently, render canonically

**Decision.** `roomFromName` accepts a name with leading zeros and resolves it; `roomToName` never produces
one. A separate predicate reports whether a name is canonical, and the router rewrites a non-canonical name
to the canonical form on load.

**Why.** Encoding and parsing pull in opposite directions here. Strict parsing would make a hand-edited or
truncated URL fail instead of landing somewhere sensible, which is hostile for no gain. Lenient parsing
alone, however, makes name→room many-to-one: `1`, `01` and `0001` all reach room 1, so the same page has
unboundedly many URLs and the project's central claim — that a link _is_ the page — quietly stops holding.

Splitting the two resolves it: the address space keeps exactly one name per room, while a malformed link
still opens.

**Alternatives rejected.**

- _Reject non-canonical names._ Bijective, but turns a stray keystroke into an error page.
- _Fixed-width names padded to 3197 characters._ Also bijective, and it was briefly implemented, but it
  makes every URL 3197 characters even for room 0 — a cost paid by every shared link to buy uniformity
  nobody sees.

**Consequence.** M8 must rewrite the URL after parsing, not merely accept it.

---

## ADR-0010 — The seed encoding is injective by construction, not by layout

**Decision.** `prf.ts` implements the seed input of SPEC §4.3 exactly as written —
`DOMAIN_TAG ‖ u8(round) ‖ u32be(xb.length) ‖ xb` — and the encoding is kept in its own
function, `seedInput`, separate from the SHA-256 call that consumes it.

**Why.** The property that matters is that distinct `(round, half)` pairs never produce the same
seed bytes — over the domain `seedInput` accepts, which it enforces rather than assumes (below).
If two did, two different addresses would share a round-function value, and the
bijection would stop being one — silently, because SHA-256 would be behaving perfectly. Keeping
the encoding separate from the hashing is what lets a test _decode_ the bytes back into
`(round, half)` and prove injectivity, instead of asserting it in a comment. That decoder is in
`prf.test.ts`.

**The bound the round field puts on it, and why it is enforced.** Injectivity holds over the pairs
the encoding can carry, not over every pair a caller could name: `u8(round)` has room for 256
values, so the property is that distinct pairs of an **integer `round` in `[0, MAX_ROUND]`** and a
half in `[0, HALF_DOMAIN)` never collide. Left unenforced that qualification was invisible and the
claim was simply false — `seedInput(0, 1)` and `seedInput(256, 1)` returned the same bytes, as did
`(10, 1)` and `(10.5, 1)`, and `(3, 1)` and `(-253, 1)`: a round the field cannot hold was reduced
into the byte of a round the network does use. So `seedInput` rejects such a round instead,
`MAX_ROUND` is exported as the bound the claim is made over, and the property test in
`prf.test.ts` ranges across that whole interval rather than across the ten rounds in use. The
guard is unreachable from the generation path — `ROUNDS` is 10 and `feistel.ts` is the only caller
— and is exercised directly for the same reason as the ones in `asciiToBytes` and
`toMinimalBytesBE`: an unenforced precondition is indistinguishable from an absent one.

The bound is the field's and not `ROUNDS - 1`, which would be tighter: `feistel.ts` imports
`prf.ts`, so the encoding cannot see the round count without an import cycle, and the limit on
what the bytes can express belongs to the bytes. A test asserts `ROUNDS - 1 <= MAX_ROUND`, so
raising the round count past the field becomes a red test rather than a silent reuse of round 0's
seed.

**A correction to the SPEC's own justification.** SPEC §4.3 says the prefix is mandatory because
"without it `u8(i)` and the leading bytes of `xb` can be reordered into the same seed for
different inputs". For the frozen field order that is not quite true, and it is worth recording
precisely why, so that nobody later removes the prefix on the grounds that the stated reason does
not hold:

- `DOMAIN_TAG` is a fixed 17 bytes and `u8(round)` a fixed 1 byte, and `xb` is the only
  variable-length field and comes **last**. A byte string of that shape can be cut only one way,
  so the encoding is injective even with the length removed. The ambiguity the SPEC describes
  would be real if `xb` came before the round index, or if the tag were variable-length.
- What the prefix buys concretely is that injectivity no longer _depends_ on that layout. Add a
  second variable-length field, reorder the fields, or make the tag configurable — all of which a
  later format revision might reasonably do — and a prefix-free concatenation collides
  immediately. With the length committed, the encoding stays self-delimiting whatever else is
  appended.

So the prefix stays, verbatim and mandatory, because the cost is four bytes inside a hash and the
thing it protects is every book in the library. But it is belt-and-braces for the current layout
rather than load-bearing, and a reader who works that out for themselves should find it written
down here rather than conclude the SPEC is confused.

**Alternatives rejected.**

- _Drop the prefix, since the current layout is injective without it._ Saves nothing measurable
  and makes a future field reordering silently catastrophic.
- _Hash the fields separately and combine._ Equivalent, slower, and further from the SPEC text,
  which is the thing the golden vectors freeze.
- _Widen the round field so the claim needs no bound._ The honest alternative to narrowing the
  claim, and it is closed off by ADR-0003 rather than by preference: replacing `u8(round)` with
  `u32be(round)` changes the seed bytes of every round, the ten in use included, which replaces
  every book in the library. Tried, to be sure rather than to assume: 21 of the 36 golden-vector
  assertions fail under it. The format is frozen, so the claim is the thing that moves.

**Consequence.** `PRF_BYTES`, `DOMAIN_TAG` and the field order are quoted from the SPEC rather
than recomputed, and `prf.test.ts` pins the raw seed bytes as well as the round-function output,
so a format break is localised to whichever of the two changed. `MAX_ROUND` is part of the public
surface of `core` because it is the stated domain of the injectivity claim, and a claim whose
domain a reader cannot name is not a claim they can check.

---

## ADR-0011 — Randomness is injected, never reached for

**Decision.** `randomAddress` and `search` take an optional `RandomSource` — a
`(byteLength: number) => Uint8Array` — defaulting to a `Math.random`-backed implementation that
is the only thing in `core` to call `Math.random`. Both are uniform by rejection sampling, not by
reducing a wider draw modulo the range.

**Why.** Architecture §5 forbids reaching for randomness inside generation, and SPEC §5 gives
`randomAddress()` and `search(query, mode, offset?)` with no source argument. Adding the source as
a trailing optional parameter satisfies both: a caller can call exactly the signature the SPEC
names, while a test, the worker, or anything that needs reproducibility can pin the bytes. Nothing
on the generation path — `getPage`, `locate`, the Feistel network, the round function — can reach
randomness at all, which is what makes a page a function of its address and nothing else.

`Math.random` rather than `crypto.getRandomValues`: these bytes choose which book a reader is
shown, not a key, so unpredictability to an attacker is not a requirement — and
`crypto.getRandomValues` is an ambient global, which `core` is not allowed to depend on.

Rejection sampling rather than `draw % limit`: the modulo would favour the low end of the range,
which for `randomAddress` means some books being measurably more likely to open than others. The
draw is masked to the limit's exact bit width and retried on overflow, which for
`limit = 36^3200` accepts about 85% of draws.

A source is also _validated_: one that returns fewer bytes than asked is rejected rather than
quietly yielding a smaller, non-uniform value.

**Alternatives rejected.**

- _A required source argument._ Diverges from the SPEC's signature and makes the common call
  verbose for no gain.
- _A module-level seedable PRNG._ Hidden mutable state in a layer whose whole value is that it has
  none.

**Consequence.** `search` does not normalize its query either: `normalize` stays the caller's to
apply (SPEC §2), because it is the caller that must decide whether to reject or strip the unknown
symbols it reports — and normalizing inside `search` would falsify the function's contract, since
the page would then contain the normalized query rather than the string that was passed in.

---

## ADR-0012 — Mutation and coverage runs get their own test budgets

**Decision.** Three run modes exist and are configured separately:

| Command                     | fast-check cases | Wall-clock budget asserted |
| --------------------------- | ---------------- | -------------------------- |
| `npm run test`, CI `verify` | 1000             | yes                        |
| `npm run coverage`          | 1000             | no                         |
| `npm run test:mutation`     | 10               | no                         |

**Why.** Both deviations are about the measuring apparatus, not the code.

_The wall-clock budget._ testing.md §5 fixes a budget for `getPage` and `locate`. The same
call measures ~0.7 ms uninstrumented, ~6 ms under v8 coverage and ~8 ms under Stryker's mutant
switching, so a timing taken in either of those modes is a reading of the instrumentation rather
than of the library — whatever the threshold happens to be. The budget
is therefore asserted only in the uninstrumented run — which is the one CI's `verify` job runs on
every push and every pull request, so the threshold is enforced, not waived. A test that runs in
_all three_ modes sits beside the skipped suite and exercises the same path, so a skipped timing
assertion cannot hide a broken bijection.

_The case count._ Stryker re-runs the suite once per mutant, and `src/core` produces ~600 of them.
At 1000 cases per property the run is hours. Capping the budget at 10 cases under Stryker can
only let a mutant **survive** that more cases would have killed, so it moves the reported score
down, never up: the score is a floor. Were it the other way round this would be unacceptable.

The cap is applied by `propertyRuns` in `src/core/__tests__/property-runs.ts`, which every
property test routes its count through, and **not** by `fc.configureGlobal({ numRuns })`. That
distinction is the whole reason the helper exists: fast-check lets an explicit `numRuns` on an
`fc.assert` override the global, and every property test here passes one, so a global cap reads
like a budget while enforcing nothing. It was written that way first, and the mutation run was
still taking hours when the discrepancy turned up — which is the same failure mode as the
benchmark assertion in ADR-0012's sibling commit: configuration that looks like a control and is
not one.

Neither threshold itself is lowered. The 100% coverage floor on `src/core`, the 85% mutation
threshold, the 75% break point and the wall-clock budget are all unchanged by this decision.
The budget's figure was later recalibrated for an unrelated reason (ADR-0013), and the two mutation
thresholds for another (ADR-0018); neither disturbs the argument above, which never rested on what
any of those numbers was.

**Alternatives rejected.**

- _Lower the property-test case count everywhere._ Trades a real guarantee for a faster suite.
- _Scale the time budget by a measured instrumentation factor._ Invents a number, and the factor
  varies with what is being instrumented.
- _Assert no performance budget at all._ An accidental `O(n²)` radix conversion is exactly the
  regression this project cannot see any other way.

**A third budget, found the hard way.** The two deviations above were chosen; Vitest's 5 s
`testTimeout` was not, and it decided the mutation job by coin flip. On commit `ae0af83` the dry run
passed in CI run 41326395583 and timed out in 41326391660 — the same code, two verdicts — on two
property tests that take about 420 ms each uninstrumented. Stryker's dry run executes them over 598
mutants' worth of coverage counters with per-test recording on top, which costs ~2.5x locally before
the runner's own ~8x. `vitest.stryker.config.ts` now sets `testTimeout: 30_000`, above Stryker's own
per-mutant deadline (`timeoutMS` 15 s plus `timeoutFactor` 2 x the dry-run time, about 29 s) so that
slow mutants are still Stryker's to kill and only the dry run's ceiling moves. Verified by setting
it to 50 ms and watching the dry run fail with the CI error verbatim.

**And a fourth, left inherited by this record for ten decisions.** The paragraph above names Vitest's
5 s `testTimeout` as a budget nobody chose, and then raises it on exactly one of the three rows of the
table at the top of this record — the mutation run, which is where it had already produced a visible
failure. `npm run test` and `npm run coverage`, the other two rows, read `vite.config.ts`, which set no
`testTimeout` at all and so kept the default this record had just finished calling arbitrary. The suite
then grew into it: five property tests failed on timeouts alone on a contended machine, and on
`ubuntu-latest` the slowest test in the suite reaches 24.0 s under coverage. ADR-0028 chooses both that
ceiling and the per-hook one, on figures measured there. Nothing above changes — the case count, the
budget's absence under instrumentation and the Stryker ceiling are all as recorded — except that the
"third budget" was two, and the second one was the one every pull request runs.

**Consequence.** `vite.config.ts` and `vitest.stryker.config.ts` each pass a flag down through
`test.env`, because the v8 provider instruments through an inspector session that leaves no trace
in the worker's own environment. Stryker also runs only `src/core`'s tests: the two tests in
`src/__tests__` drive the ESLint API over throwaway files written into each layer directory, which
does not survive running from Stryker's sandbox copy — and a lint-configuration test could not
kill a mutant in the bijection anyway.

---

## ADR-0013 — The performance budget is calibrated on the machine that enforces it

**Decision.** The wall-clock budget of testing.md §5 is **25 ms** for `getPage` and `locate`,
measured as the median of 15 samples. The figure lives in testing.md §5 and in the single
`BUDGET_MS` constant that asserts it; no comment, benchmark label or other record restates it.

**Why.** The first budget was 5 ms, taken from the reference machine's 1.34 ms (SPEC §4.4) and
never measured anywhere else. Measured medians of 15 samples for `getPage`: development laptop
0.53–0.80 ms, reference machine 1.34 ms, `ubuntu-latest` ~5.05 ms. So the threshold sat on the
value of the only machine that enforces it — the first CI run of the suite failed at 5.052 ms and
the next run of the same commit passed. A gate that decides by scheduler luck reports a safety it
does not have, and testing.md §9 fixes a flaky test the day it is noticed rather than retrying it.

25 ms is five times the slowest observation, and the margin costs no detection power: the budget
exists to catch an accidental `O(n²)` radix conversion or a round function that re-hashes the whole
page, and those are orders of magnitude rather than percent. Verified by raising the assertion to
an impossible value and watching all five timing tests go red before restoring it.

**A number has one home.** The 5 ms figure had also been restated in four places that assert
nothing — a comment in `prf.ts`, the docstring and the `bench` label in `bignum.bench.ts`, and a
second docstring in `performance.test.ts` — and the commit that changed the budget updated none of
them, so for the length of that commit the repository documented two different budgets. A comment
that lies is worse than no comment (code-style §1), and the cheapest way to keep four of them
honest is to not have them: each now cites testing.md §5 instead of repeating its number.

**Alternatives rejected.**

- _Keep 5 ms and retry the job._ A retry discards exactly the information the test exists to
  produce (testing.md §9).
- _Calibrate to the reference machine and skip the budget on CI._ The reference machine does not
  run on every push, so the budget would then be enforced nowhere.
- _Scale the budget by a measured runner factor._ Invents a number that moves with the runner
  image, which is the same move ADR-0012 rejected for instrumentation.

**Consequence.** ADR-0012's decision not to assert the budget under the coverage and mutation runs
stands, but its reason is no longer arithmetic: ~6 ms and ~8 ms both fit inside 25 ms, so the
assertion would now pass there. The reason that survives is the one testing.md §5 gives — a timing
taken through an instrumented build measures the instrumentation.
---

## ADR-0014 — The full mutation run leaves the pull request path

**Decision.** The full Stryker run is **nightly on `main` and on `workflow_dispatch`**, not on pushes
or pull requests. What the pull request path gets instead is `npm run test:mutation:dry`
(`scripts/check-mutation-harness.sh`): Stryker's dry run, a 34-second job that adds nothing to the
critical path, asserting both its
exit code and that it ran every test the config collects. The score is read as a **floor**, not a
measurement, and the survivor list is not a to-do list. The `changes` job in `ci.yml` is deleted,
having had no other consumer.

**Why.** The run costs 21 to 70 minutes, measured over six CI runs. It was also believed to be
irreproducible, on the evidence below; that belief was wrong and the correction at the end of this
record explains what the evidence actually showed. The decision stands on the cost alone.

Between runs 41392938348 and 41394049476 — whose `src/` trees are identical, the
second commit touching only `vitest.stryker.config.ts` and two documents — **56 of 587 distinct
mutant positions changed verdict**: 31 `Killed → Survived`, 18 `Killed → Timeout`, 5
`Timeout → Killed`, 2 `Survived → Killed`. A timeout counts as killed, so only the survival moves
touch the score: −31 +2 over 594 scored mutants is 4.88 points, which is the whole of the
98.32 → 93.43 drop. A gate that swings five points on unchanged code decides by luck, which is what
ADR-0013 removed from the performance budget for the same reason.

The direction of the error is one-sided, and that is what makes a floor usable: 31 false survivals
against 2 positions that could be a false kill, and hand-applying all five reported survivors on
`ae0af83` killed every one of them. So `break: 75` can fire on noise but cannot go green over a real
gap. The score is still worth having. It is not worth an hour per pull request.

What the pull request path actually needs to catch is the harness breaking, which is what happened on
`ae0af83`: Vitest's unexamined 5 s per-test default timed out the dry run, the `push` and
`pull_request` runs of one commit disagreed, and it took two runs before the failure was even
visible. The dry run catches that in fifteen seconds.

**Why the check asserts a test count and not just an exit code.** With the dry run deliberately
broken, six of seven observed runs exited 1 — and the seventh printed `Initial test run succeeded.
Ran 43 tests`, a pass on a suite that had silently lost 186 of its 229. Exit code alone is a gate
that green-lights a truncated run. The expected count comes from `vitest list` against the same
config, so no floor is written down to rot: both sides see `SCRIPTORIUM_STRYKER=1` and both drop the
same skipped work. Verified by mutating the comparison by hand and watching it go red.

**Alternatives rejected.**

- _Keep the full run on pull requests and widen the margin._ The swing is the problem, not the
  threshold. A wider margin makes a noisy gate quieter without making it informative, and still
  spends the hour.
- _`coverageAnalysis: "all"`._ This does remove the unstable component — per-test attribution is
  what moves — but it runs every test against every mutant. At 594 mutants and concurrency 4 the
  current run already reaches 59 minutes with attribution narrowing the work.
- _Lower the concurrency._ Untested as a remedy, and it buys stability, if any, with more wall
  clock.
- _Gate the dry run on which files changed._ It costs fifteen seconds. Gating it would buy those
  back and pay the skipped-job dependency subtlety the `changes` job was written to work around.
- _Drop mutation testing._ ADR-0008's reason stands: for a bijection with no user, no log and no
  exception, coverage cannot tell whether an assertion would have noticed.

**Consequence.** A genuine score regression now lands in `main` and is caught within 24 hours rather
than before the merge. That is the cost of this decision, stated plainly; it is accepted because the
pre-merge gate it replaces produced false reds more often than true ones. A failing scheduled run
notifies the repository owner through GitHub's own default, so no extra machinery is added.

`schedule` fires only on the default branch, so a feature branch cannot get a score from it at all —
hence `workflow_dispatch`, which is how a branch asks for a number before it merges.

**Correction, 2026-11-03: the swing was caused, not random.** The sentence above calling the verdict
irreproducible does not survive its own evidence, and the mistake is instructive enough to record
rather than quietly edit away. The two runs compared were called identical because `src/` was
identical — but the commit between them, `d2aa600`, raised `testTimeout` from Vitest's unexamined 5 s
default to 30 s in `vitest.stryker.config.ts`, and that file governs how the suite runs under
Stryker. A configuration file is code for this purpose. Dismissing it as "only config" is the same
error this record was written to catch, committed in the act of writing it.

The mechanism is direct. A test that times out is a failing test, and a failing test kills its
mutant. Under a 5 s cap, mutants that merely made the code slower — a broken early exit, a wider
loop — died on the clock rather than on an assertion, and the score counted them as killed. Raising
the cap let those tests finish and pass, so the same mutants are now correctly reported as
survivors. That is the whole of the 31 `Killed → Survived`, and it means the earlier 98-99 scores
were inflated and the present ~93 is the more honest number. The same cap explains the per-mutant
flapping noted in `testing.md` — five runs of one mutant giving three verdicts is what a borderline
test sitting near a 5 s line does.

Six scores are now known: 99.16, 99.16 and 98.32 before `d2aa600`; 93.43, 93.10 and 93.27 after it.
The decisive pair is the last two: **two runs of the identical commit `e43d09b`, launched
concurrently, scoring 93.10 and 93.27 — a spread of 0.17 points.** Across all four post-change runs
the spread is 0.33. So the verdict is very nearly a function of the code, and the residual noise is
two tenths of a point rather than five.

What this changes in the record above: the score is a **measurement with about ±0.2 of noise**, not
a floor five points below the truth, and the one-sided-error argument is no longer needed to make it
usable. `break: 75` was sized for a swing that does not exist and is now far looser than the
evidence requires. What it does not change: the run costs an hour, which is the reason it is not a
pull request gate, and that reason was always sufficient on its own.

Issue #6 stays open, with its premise corrected: what remains to establish is the residual 0.2
points and where `break` should sit now that it is defending against that rather than against six.

`break` has since been set, on that corrected premise: ADR-0018 puts it at 92 from fifteen observed
runs. What stays open in issue #6 is the residual 0.2 points, and whether a machine that has stopped
drifting would justify tightening further.

**Correction, 2026-11-03: the hour this record rests on was an artefact, and has not been
re-measured on the machine that pays it.** The cost above — 21 to 70 minutes over six CI runs, and
the eight runs in ADR-0018 spanning 36m39s to 73m14s — was the cost of running the entire suite
against every mutant, which is what `coverageAnalysis: "perTest"` was silently doing (ADR-0017).
With that fixed the same work took **9m43s** on one developer machine.

This does not reinstate the pull request gate, and nothing here moves it, for a reason worth stating
precisely rather than assuming either way: **9m43s was measured once, outside CI, on one machine.**
Every duration this record and ADR-0018 quote was taken on `ubuntu-latest`, and no full run has been
timed there since the upgrade. So what the nightly run costs on the machine that actually runs it is
unmeasured, and the premise of this decision is neither confirmed nor refuted — it is simply no
longer evidenced. Whether the full run can return to the pull request path is therefore open, and
the thing to measure is a `workflow_dispatch` run on `ubuntu-latest` under 9.6.1, not another run on
a laptop. Until then the dry run stays the pull request's gate, which it earns on its own terms:
it catches the harness breaking, which is what the pull request path needs and what a score cannot
tell it.

**Correction, 2026-11-03: the `coverageAnalysis: "all"` rejection rested on a false baseline.**
The alternative above is rejected on the grounds that `"all"` "runs every test against every
mutant", where "the current run already reaches 59 minutes with attribution narrowing the work".
Attribution was narrowing nothing. `coverageAnalysis: "perTest"` was collecting no coverage at all
under the runner version of the day, so the committed configuration was **already** running every
test against every mutant, and `"all"` would have cost no wall clock whatever — it would merely
have made the behaviour honest about itself. ADR-0017 has the mechanism and the figures.

The conclusion survives and the reason now holds for the first time: under 9.6.1 attribution really
does narrow the work, by a factor of five on that record's measurement, so `"all"` would today cost
the hour this record wrongly believed it was already paying. The run-length reason this record
stands on is unaffected either way, since it never depended on which alternative was cheaper.

---

## ADR-0015 — Formatting and shell are CI stages, not hook conveniences

**Decision.** Every tool in `code-style.md` §8's table gets a CI job. The Husky hook is explicitly
the convenience copy, and only for tools the lockfile already installs.

**Why.** §8 named ESLint, Prettier and `tsc` as required CI stages. Prettier was enforced only by
`lint-staged` in the pre-commit hook, and shell by nothing, which let four documents stay
unformatted from `dd0c833` through three merged pull requests. The four were `CONTRIBUTING.md`,
`docs/code-style.md`, `docs/spec.md` and `README.md` — three of them the engineering standards
themselves — and on `e43d09b` `prettier --check .` named all four and exited 1, while each was byte
identical to the commit that published it. A hook sees the files one local commit stages; it is
bypassed by `--no-verify`, by a web edit, and by any file that was not staged at the time. A hook task that spawns a binary npm does not provide blocks commits on a machine that
lacks it — observed, with `Task failed to spawn: shellcheck ENOENT` — which is why shell is linted
in CI only.

`format` and `shell-lint` are separate jobs rather than steps in `verify`, because the name of a red
check is the first diagnostic anyone reads, and because an independent job still reports when
`verify` has failed for another reason. `format:check` is in `verify` as well, so a local run
catches drift before a push.

ShellCheck runs at its default check set. `--enable=all` adds only SC2250 here, and a gate whose
findings are all taste trains people to silence it. It is taken from the `ubuntu-latest` image
rather than pinned, trading reproducibility for zero setup; the job prints the version so that a
finding introduced by an image bump is traceable. Pinning is a one-line change if that trade turns
out wrong.

The file list for `lint:shell` comes from `git ls-files '*.sh' '.husky/*'` rather than being
enumerated in the workflow, so a new script is covered on the day it lands instead of when someone
remembers to extend a list. `yml` and `yaml` join the hook's Prettier glob at the same time, so the
local copy agrees with `prettier --check .`, which already covered the workflow files.

**What the two gates cost.** Both were watched red and green, and both are off the critical path.
On run [41577184462](https://github.com/valmlord/scriptorium-3d/actions/runs/41577184462), the
`pull_request` event on `d7166da`, `format` took 33s and `shell-lint` 6s against a critical path of
109 seconds held by `coverage` at 114s and `e2e` at 101s; the `push` run
[41577176764](https://github.com/valmlord/scriptorium-3d/actions/runs/41577176764) over the same tree
reported 30s and 4s, which also confirms the new jobs behave identically on both events — the
discrepancy that hid the `ae0af83` failure for two runs. `shell-lint` logged ShellCheck `0.9.0` on
runner image `ubuntu24/20261025.353`, the same version the local red/green transcripts were produced
with, so the proof and the job are not testing different linters.

**Alternatives rejected.**

- _The ShellCheck npm wrapper as a `devDependency`, so the hook could lint shell too._ It downloads a
  binary in a postinstall script, and code-style §7 makes a new dependency a decision to record
  rather than one to slip into a CI change. The hook keeping out of shell is the cheaper half of the
  same answer.
- _`--enable=all`._ Covered above: one extra finding class on this repository, and it is taste.
- _Steps inside `verify` instead of two jobs._ Covered above: a red check's name is the first
  diagnostic anyone reads, and a step cannot report while `verify` is failing for another reason.
- _A `"//"` key in `.lintstagedrc.json` carrying the note about why shell is CI-only._ That file is
  strict JSON, so the key reads as a glob with a command attached and the tool ignores it silently —
  which is the `_comment_timeout` shape this record exists to remove, committed in the act of
  documenting its removal. The note lives in the `shell-lint` job comment instead.
  `.lintstagedrc.yaml` is also a search place `lint-staged` honours and does take comments, so moving
  it there is a one-line change if the note is wanted beside the globs.

**Consequence.** Formatting drift and shell defects now fail a named check. This is the fifth
instance of one shape to be removed from this repository — a gate that is configured and never
invoked reports a safety that is not there — after `_comment_timeout`, the budget written beside a
`bench` task, the `mutation` job hidden behind a skipped dependency, and a dry-run check that passed
on 43 of 229 tests.

---

## ADR-0016 — A cancelled generation request rejects; it does not hang

**Decision.** The worker client's cancellation rejects the pending promise with a named domain
error carrying the request id and the address. `ROADMAP.md`'s M3 wording — "a cancelled request
never resolves" — is corrected to say so.

**Why.** Read literally, the original wording specifies a promise that never settles. That is a
retained continuation per cancelled request, and cancellation exists here precisely because the
camera flies past shelves continuously, so the leak would grow with the motion the feature is for.
A promise that never settles also cannot be awaited in a test without a timeout, which is how
"asserted by outcome" quietly becomes a sleep.

Both halves of what the milestone asks for survive the change: the caller observes an outcome, and
the result never reaches the cache. What changes is that the outcome is observable and the
continuation is released. The error is a dedicated type, following `src/core/errors.ts` where every
domain situation is a named type carrying context rather than a bare `Error`.

**What the test then asserts**, none of it needing a timer: the returned promise rejects with that
type; the cache holds no entry for the address afterwards; and a late worker message carrying the
cancelled request's id is ignored rather than cached. The third is the real hazard — cancellation
races the reply, and the honest implementation assumes the reply is already in flight.

**Alternatives rejected.**

- _Leave the wording and implement it literally._ A documented leak is still a leak, and the
  milestone's review gate would then certify it.
- _Resolve with a sentinel value instead of rejecting._ Every caller must then remember to check for
  it, and a forgotten check renders a cancelled page. A rejection cannot be ignored silently.
- _Expose an `AbortSignal` and let the caller own the lifetime._ Closer to the platform, and worth
  revisiting when there is a second caller; today it moves the bookkeeping into `ui/` for one call
  site.

**Consequence.** M3's "Cancellation asserted by outcome" is answerable without a timer, and the
frame budget that gates the milestone is measured against a client that releases what it cancels.

---

## ADR-0017 — Stryker 9.6.1, because `perTest` was collecting nothing

**Decision.** `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` are pinned at **9.6.1**,
the first release whose injected Vitest setup file reads the suite from the argument Vitest 4.1
actually passes it. `coverageAnalysis: "perTest"` has been in `stryker.config.json` since the tool
arrived and had never collected a byte.

**Why.** The configuration said `perTest`; the planner ran **every test against every mutant**, and
a full run cost forty-eight minutes for work that takes ten. The chain from the one wrong argument
to the hour is mechanical, and worth writing out because every link in it is silent:

- 9.2.0's runner records coverage in `afterAll((suite) => { suite.meta.mutantCoverage = ns.mutantCoverage; })`,
  which takes the suite as its **first** argument. Vitest 4.1 moved the suite to the **second**, so
  `suite` binds to the test context and `suite.meta` is not the file meta `ctx.state.getFiles()`
  later reads.
- `readMutantCoverage()` therefore ends in `return coverages[0]` over an empty array — `undefined`.
- The `undefined` is dropped crossing the test-runner child-process boundary, so the dry-run result
  reaches Stryker core with **no `mutantCoverage` key at all** rather than with an empty one.
- `TestCoverage.hasCoverage` is `!!staticCoverage`, hence `false`.
- `mutant-test-planner.js` then takes its last branch — _"No coverage information exists, all tests
  need to run"_ — for every mutant in the project.

**Nothing warns at any step.** The runner's peer range is `vitest: ">=2.0.0"` and 4.1.11 satisfies
it, so the install is clean; the harness starts, instruments, runs a green suite and prints a
plausible score. This is the same shape as `_comment_timeout` and the budget written beside a
`bench` task — configuration that reads as a control and reaches nothing — except that here the
config was correct and the tool below it was not, which is the variant no amount of reading the
repository would have caught.

**The measurement.** Same machine, same commit, same `stryker.config.json`, Vitest unchanged at
4.1.11. Taken in a clone outside the working tree so the run could not disturb the working copy or
the CI runs it was being compared against; scores read from the `clear-text` table Stryker prints,
not parsed out of the HTML report.

|                             | 9.2.0         | 9.6.1         |
| --------------------------- | ------------- | ------------- |
| **duration**                | **47m52s**    | **9m43s**     |
| tests per mutant            | 96.14         | **7.07**      |
| mutants with `coveredBy`    | **0 / 614**   | **610 / 614** |
| flagged `static`            | 0             | 125           |
| score                       | 93.77         | 93.77         |
| killed / timeout / survived | 546 / 26 / 38 | 541 / 31 / 38 |

The four mutants without `coveredBy` under 9.6.1 are exactly the four `Ignored` ones, the deliberate
`// Stryker disable next-line` exclusions at `library.ts:252` and `prf.ts:89`.

**The verdict does not move, which is what makes the upgrade safe to take.** Paired on mutant id
across all 614, the only changes are score-neutral: 10 `Timeout → Killed` and 15
`Killed → Timeout`. The 38 survivors are the same 38 mutants. Pairing on _position_ instead — file,
line, column, mutator, replacement — collapses the 614 into 602 distinct keys, 12 collisions, and
miscounts silently; the comparison was keyed on mutant id for that reason.

Three signals distinguish a working run from the old one, and are worth checking rather than
assuming after any future bump of either package: `Ran ~7 tests per mutant on average` in the
console summary where it read `~96`; the planner's static-mutant warning, which could not appear
while `hasStaticCoverage` was false for everything; and a non-zero `overhead` in the
`Initial test run succeeded` line, where it was `0`.

**Alternatives rejected.**

- _9.5.0 through 9.6.0._ Not a partial fix: they carry a _different_ and also-wrong shape,
  `afterAll(({ meta }) => …)`. 9.6.1 is the first release with the working form, which branches on
  an `isGreaterThanVitest4Point1` flag. Verified by reading each published tarball's
  `stryker-setup.js` rather than the changelog.
- _10.1.1._ Carries the fix as well. 9.6.1 is the first and the smaller move, with no
  major-version configuration migration to absorb at the same time as a behavioural change this
  large.
- _Upgrading one package._ `@stryker-mutator/vitest-runner@9.6.1` pins `@stryker-mutator/core` to
  exactly `9.6.1` in its peers, so they cannot move independently. Taken together the install needs
  neither `--force` nor `--legacy-peer-deps`.
- _`ignoreStatic: true`, or `coverageAnalysis: "all"`, as #6 proposed._ Both were measured against
  the broken state, where `hasCoverage` was false for every mutant and neither option's branch in
  the planner was reachable. Every reading of them was a reading of something else; see ADR-0023 for
  what `ignoreStatic` costs now that it has an effect.

**Consequence.** No runtime dependency changes — both packages are `devDependencies`, and the
lockfile churn is confined to the runner's own dev tree. The score is unchanged at 93.77, so the
nightly gate of ADR-0014 could not regress across the upgrade, and the thresholds that gate rests on
became measurable for the first time, which is ADR-0018.

---

## ADR-0018 — The mutation thresholds are calibrated on measured spread

**Decision.** `break: 92`, `low: 92`, `high: 93`, replacing `85 / 75` and the band under them.

**Why.** `break: 75` was sized for a five-point swing that does not exist — ADR-0014's correction
has the cause — and at 75 the gate cannot report any regression a reviewer would care about.

The arithmetic is exact rather than approximate, which is what makes the question answerable. The
mutant set is constant at **614 instrumented, 4 `Ignored`, 610 scored** in every run observed, so
the score is a pure function of the survivor count and moves in steps of **0.164 points per
survivor**:

```
38 survivors -> 93.77      40 survivors -> 93.44
39 survivors -> 93.61      41 survivors -> 93.28
```

So a threshold is not really a percentage; it is a number of spurious survivors it agrees to
tolerate:

| `break`     | fires at         | vs. floor (38) | points below floor |
| ----------- | ---------------- | -------------- | ------------------ |
| 75 (before) | 153 survivors    | +115           | 18.77              |
| 90          | 62 survivors     | +24            | 3.77               |
| **92**      | **49 survivors** | **+11**        | **1.77**           |
| 93          | 43 survivors     | +5             | 0.77               |
| 93.5        | 40 survivors     | +2             | 0.27               |

At 75 the gate needs 153 survivors out of 610 to fire: about a fifth of the scored set, and 115
above the floor. That is decoration rather than a loose threshold.

**The measurement.** Eight full runs of unchanged `main` (`6786120`), launched as concurrent
`workflow_dispatch` runs on `ubuntu-latest` — the machine that enforces the threshold, which is what
ADR-0013 requires of a calibration — each on its own runner:

| run                                                                                | score | survivors | duration |
| ---------------------------------------------------------------------------------- | ----- | --------- | -------- |
| [41638125915](https://github.com/valmlord/scriptorium-3d/actions/runs/41638125915) | 93.28 | 41        | 73m14s   |
| [41638154186](https://github.com/valmlord/scriptorium-3d/actions/runs/41638154186) | 93.77 | 38        | 69m49s   |
| [41638158324](https://github.com/valmlord/scriptorium-3d/actions/runs/41638158324) | 93.77 | 38        | 70m57s   |
| [41638163380](https://github.com/valmlord/scriptorium-3d/actions/runs/41638163380) | 93.61 | 39        | 64m47s   |
| [41638241444](https://github.com/valmlord/scriptorium-3d/actions/runs/41638241444) | 93.44 | 40        | 38m50s   |
| [41638246095](https://github.com/valmlord/scriptorium-3d/actions/runs/41638246095) | 93.77 | 38        | 73m02s   |
| [41638250824](https://github.com/valmlord/scriptorium-3d/actions/runs/41638250824) | 93.61 | 39        | 69m45s   |
| [41638321218](https://github.com/valmlord/scriptorium-3d/actions/runs/41638321218) | 93.77 | 38        | 36m39s   |

Spread **0.49** (93.28–93.77), mean 93.63, median 93.69, sd 0.184, **n = 8**. Seven further runs on
one machine — one on this configuration and six on the upgraded runner of ADR-0017 — all returned 38
survivors with a byte-identical survivor set. So across **fifteen observations the floor is 38 and
the worst is 41**, and the noise is one-sided: it only ever adds survivors, never removes one.

**Why 92 and not tighter.** 93 fires at 43 survivors, two above the worst run actually observed.
With n = 8 that is not margin, it is the ADR-0013 mistake in a different file — a threshold sitting
on the enforcing machine's own observed value, deciding by scheduler luck. 92 fires at 49: eight
clear of the worst run and roughly four times the largest measured spread.

**Why 92 and not looser.** 90 needs 24 extra survivors, 3.77 points. The regressions worth catching
here are not orders of magnitude — a deleted assertion frees a handful of mutants, not a hundred —
so the margin has to be a small multiple of the noise rather than merely comfortable. 92 still fails
on a regression of eleven mutants where 75 needed a hundred and fifteen.

**Why `low` and `high` move with it.** Stryker validates only `high >= low`, so a `break` above
`low` is accepted silently. Left at `low: 85`, the report would colour a score 1.77 points from
breaking green and never turn red before the build failed. `low: 92` makes red mean exactly "this
breaks"; `high: 93` sits above the entire observed range, the worst run at 93.28 included, so green
keeps meaning "within noise of the floor" and the yellow band becomes a genuine early warning rather
than dead space.

**Alternatives rejected.**

- _Leave `break` at 75._ Defensible while the score was believed to swing five points. It is not
  now: the swing had a cause, the cause is fixed, and ADR-0014's own argument against a gate that
  decides by luck now points the other way.
- _93, or 93.5._ Two and five survivors of margin over the worst observation, on n = 8 across
  machines. See above.
- _90._ Three and three-quarter points of margin to catch regressions that are worth a handful.
- _A per-file threshold for `errors.ts`._ Stryker enforces none, and the file is a real test gap
  rather than a calibration problem; see the consequence below.

**Consequence.** The nightly run on `main` now fails on a regression of eleven mutants instead of a
hundred and fifteen. Per ADR-0014 that failure lands in `main` and is caught within 24 hours rather
than before a merge, which is the cost that decision already accepted.

`src/core/errors.ts` reads 76.00 on six stable survivors, below the new `low`. Nothing changes for
it mechanically — `low` is a whole-project band and Stryker enforces no per-file threshold — but it
is now visibly below the band, and it is a test gap rather than noise: the same six mutants survive
across two Stryker versions and two `coverageAnalysis` settings. Filed as #26.

**Open: whether 92 is still the right floor on a machine that has stopped drifting.** The six runs
of the upgraded runner that all returned 38 survivors were taken on one machine, so "the upgrade
removed the spread" cannot yet be told apart from "this machine never exhibited it". If repeated
`workflow_dispatch` runs on `ubuntu-latest` under 9.6.1 also come back flat, `break` could be
tightened on that evidence. It is recorded as a question rather than acted on because 92 does not
depend on the answer, and because tightening a gate on a spread measured elsewhere is the move this
record exists to stop. Issue #6 carries it.

**Answered: it still drifts, and by more than this record measured.** Thirteen nightly runs of the
identical commit `ff005f10` on `ubuntu-latest` under 9.6.1 — one a night, so each on its own runner
and none competing with the other twelve — scored **94.75 to 95.57**: 27 to 32 survivors, a spread
of **five** against the three measured here, in 9m59s to 15m04s. The whole spread is five mutant
positions, and they are nameable: `bignum.ts:56` (two mutants), `bignum.ts:115`, `bignum.ts:116` and
`address.ts:30` are survivors in some of the thirteen runs and not in others, while the remaining 27
survivors are in every one. `address.ts:30` is an equivalent mutant (ADR-0031), so no test can kill
it and its other verdict can only have been a timeout — a kill for the wrong reason, which is the
same one-sided noise ADR-0014's correction describes, pointing the other way.

So the premise for tightening is gone: the upgraded runner did not remove the spread, and `break: 92`
stands on a measurement of the machine that enforces it rather than on one machine's flat run.

ADR-0031 then raised the floor by eight survivors, which is 1.31 points, by killing survivors that
were never real. At a floor of 24 survivors, `break: 92` fires at 49 and so tolerates 25 extra
against a measured spread of five — about five times it, where this record chose about four. The
arithmetic is unchanged and so is the decision; what has changed is that the margin is now five
spreads rather than four, and tightening it to 93 (43 survivors, 19 extra) would land back on this
record's own ratio. Not done here: the floor moved in the same commit that would move the gate, and
a gate recalibrated on the run that changed it is the ADR-0013 mistake. The figures to do it on are
in ADR-0031.

---

## ADR-0019 — The worker cache is budgeted in bytes, separately for pages and titles

**Decision.** The generation cache is **two** least-recently-used stores — one for page text, one for
titles — each bounded by the total size in bytes of the keys and values it holds, not by an entry
count. Each ceiling is a multiplier times the worst cost an entry of that kind can have, where the
multiplier is the access pattern that revisits its contents. The key is charged against the budget.
An entry that cannot fit its budget on its own is **refused**, and the cache is left byte for byte
as it was. It sits on the main thread in front of the worker, not inside it.

**Why.** A page is 3200 UTF-16 characters and a title 25, so "a hundred entries" means 640 KB of
pages or 5 KB of titles — three orders of magnitude apart. An entry count is a number that means
nothing here, and a single round figure in megabytes would have to mean one of the two.

|        | worst-case entry               | multiplier             | ceiling                      |
| ------ | ------------------------------ | ---------------------- | ---------------------------- |
| pages  | `(3200 + 3200) * 2` = 12 800 B | `PAGES_PER_BOOK` = 410 | **5 248 000 B** (≈ 5.00 MiB) |
| titles | `(3200 + 25) * 2` = 6 450 B    | volumes per room = 640 | **4 128 000 B** (≈ 3.94 MiB) |

**Pages are bounded by one volume**, because that is the bound of the only access pattern that
revisits a page: reading is page-at-a-time inside a book — flip forward, flip back, follow a search
hit and return to it — and a page revisited across volumes is a coincidence rather than a pattern
worth 6.4 KB of retention each. At 1.0 to 1.35 ms a page (ADR-0005), a full volume retained is 410
to 553 ms of generation that a reader walking a book never pays twice.

**Titles are bounded by one room**, because inside a room the camera _turns_. Titles resolve when the
camera is close enough to read them and are cancelled when it is not (architecture §3), and four of
a room's six walls carry shelves, so the set a turn can revisit is the whole room: 640 volumes. At
25.1 to 33.4 ms a shelf of 32 that is 502 to 668 ms — ten to twenty frames' worth — not paid again
for turning around. Leaving a room drops its titles, which is intended: the room behind you is one
out of some 10^4975, and keeping it would be keeping an arbitrary room forever.

Both are written as a multiplier times a worst case rather than as a round figure, because here the
worst case **is** the realistic one. A key is short only for a room near the start of the library; a
room reached by a deep link or by "open a random book" has a 3197-digit name. And each number keeps
one home (ADR-0013): the ceilings are derived from `core`'s own `PAGES_PER_BOOK`, `PAGES_PER_ROOM`,
`PAGE_LENGTH` and `TITLE_LENGTH`, and the tests assert the _derivation_ — "this budget holds one
volume of worst-case page entries" — rather than restating the figure. Total resident cost is
9 376 000 B, about 8.94 MiB: small beside a room's instanced geometry, and **bounded**, which is the
property that matters. It does not grow with how long the camera has been moving.

**Why the key is charged, and why it is a rendered string.** A key is `toLinear(address).toString(RADIX)`
rather than the `Address`: an `Address` is a plain object, so two addresses naming the same page are
two objects and identity is not a key, while `toLinear` is the one canonical ordering (SPEC §3), so
the rendering is total and injective over the address space. Base 36 rather than base 10 because
both are native and the base-36 form is 3200 characters where the decimal form is 4981. The largest
linear index is one below `36 ** 3200`, which is exactly `PAGE_LENGTH` base-36 digits — so **a
page's key is as long as the page it names, and a title's key is 128 times the title.** Dismissing
keys as overhead would let the title store hold 128 times the bytes it claims, so an entry costs
`(key.length + value.length) * 2`: two bytes per UTF-16 code unit, and both alphabets are inside the
BMP, so no character is a surrogate pair. What is _not_ counted is the engine's own per-entry
bookkeeping, because it is not observable from here and a budget cannot rest on a number that cannot
be read.

**Why an oversized entry is refused rather than accommodated.** The check runs before anything is
mutated, so nothing already stored under that key is displaced by a value that could not have been
kept. A refusal is a cache miss, which every caller already handles — the next `get` returns
`undefined` and the value is recomputed — so the rule needs no new error type and no return value
for a caller to remember to check. With the two ceilings above no page or title can be refused: the
largest page entry is one 410th of its budget. This is what a budget too small for its contents
does, not a case the library reaches.

**Why it is in front of the worker rather than inside it.** A hit served from inside would still
cost two `postMessage` hops and a task-queue turn, and that is the one part of the round trip a cache
can remove entirely.

Purity is what makes any of this assertable: no `Date.now()`, no timer, no `Math.random()`
(architecture §5). The only state is the map and a running byte total, so the same sequence of
operations produces the same contents and the same recency order on every machine, and eviction can
be a property test rather than a sleep.

**Alternatives rejected.**

- _One store with prefixed keys._ A title and page 0 of the same volume share a linear index, so one
  map would have the same key naming 25 characters in one moment and 3200 in the next, each
  overwriting the other at a tenth of the cost it was admitted for. A prefix guards against that;
  two stores make it unrepresentable, and are what give each budget the independence its test
  asserts.
- _An entry count._ The same number means 640 KB or 5 KB depending on which store it lands in.
- _A time-to-live._ Needs a clock, which architecture §5 keeps off this path, and would make
  eviction unassertable — the test would become a sleep. Nothing in the library goes stale: an
  address generates the same page forever (ADR-0003), so there is nothing for a TTL to protect
  against.
- _Keying by the `Address` object in a `Map`._ Object identity is not a key, and the structural key
  the alternative implies is a string in the end anyway.
- _Emptying the cache to admit an oversized entry._ Trades a whole working set for one entry that
  the next insertion would evict anyway.
- _A `set` that returns whether it stored._ A second contract to keep in step with the refusal rule,
  for information the next `get` already gives.

**Open: does the long key have to repeat?** The title store pays its budget almost entirely in keys.
Of its 4 128 000 bytes, the titles themselves are 32 000:

|                                  | bytes     | share of the ceiling |
| -------------------------------- | --------- | -------------------- |
| title text — 640 × 25 characters | 32 000    | 0.8%                 |
| keys — 640 × 3200 characters     | 4 096 000 | 99.2%                |

Charging those keys is still right, for the reason above. But _charging_ a key and _repeating_ it are
different questions, and only the first is decided here. **All 640 volumes of a room share one room
index**, and a room is precisely the bound the title ceiling is derived from, so a structure nested
by room would pay the long key once instead of 640 times: one room key at worst 6400 bytes, plus 640
in-room entries of `(2 + 25) * 2` = 54 bytes, which is about 41 KB of characters and lands near
46 KB once the nested map's own entry is counted. Two orders of magnitude, for the same 640 titles
and the same access pattern.

**It is recorded as a question rather than acted on because four megabytes is arithmetic, not
measured harm.** `ui/` and `engine/` do not exist yet, so there is no profile in which this store is
the thing that hurts, and restructuring a correct, bounded, tested module on a projection is
optimising without a number — which is the move ADR-0013 removed from the performance budget and
ADR-0014 from the mutation gate. A flat map also has the simpler contract, and the contract is what
this module is for. What to put to a profile when there is one: **is the title store's resident cost
ever a binding constraint — and if it is, does nesting by room earn the second level of indirection
it adds to the hit path?** Either answer is cheap to act on, because the ceiling is derived from
`PAGES_PER_ROOM / PAGES_PER_BOOK` and the key is rendered in one function; neither is spread across
the module.

**Consequence.** A hit is a `Map` lookup plus one key rendering — V8 converts a 16 545-bit `bigint`
to base 36 natively in about 0.1 ms — against the 1.0 to 1.35 ms `getPage` and 0.73 to 0.98 ms
`getTitle` it replaces, an order of magnitude under what it saves. ADR-0016's rule that a cancelled
result never reaches the cache is the **client's** to enforce, by not calling `setPage` or `setTitle`
for a cancelled request id: this module holds no opinion about request ids, which is why the rule
cannot live here.

---

## ADR-0020 — A non-canonical fragment is reported, not refused

**Decision.** `fragmentToAddress` resolves a fragment that is well-formed but not canonical, and
reports it: `ParsedFragment` carries `hasCanonicalRoomName`, a whole-fragment `isCanonical`, and the
`canonicalFragment` the router rewrites to on load. A non-canonical room name, leading zeros on a
numeric component, a `?` with nothing after it and parameters in another order all resolve with
`isCanonical: false` rather than throwing.

**Why.** ADR-0009 settled this for the room name — lenient parsing so a hand-edited or truncated
link lands somewhere sensible, canonical rendering so that a link _is_ the page, and a rewrite on
load — and the fragment is the same tension one level up. The codec extends the split to the whole
fragment rather than inventing a second policy for the parts ADR-0009 did not cover, which would
leave a URL that is bijective in its room name and many-to-one in its page number.

`canonicalFragment` is computed by **re-serialising the parsed address**, not by a second set of
normalisation rules. One canonical form, produced by the one function that produces canonical forms;
a separate normaliser would be a second implementation of the scheme to keep in step with the first.

`hasCanonicalRoomName` is kept as a separate, narrower signal rather than folded into `isCanonical`
because the room name is the segment a human hand-edits and the one that runs to 3197 characters. A
log saying which segment was rewritten is worth more than one saying only that something was.

**Alternatives rejected.**

- _Refuse a non-canonical name._ Contradicts SPEC §3 outright, and turns a stray keystroke into an
  error page for no gain — ADR-0009's reason, unchanged.
- _Normalise silently, without telling the caller._ The URL in the address bar would then disagree
  with the address the FSM holds, which is precisely the desynchronisation architecture §4 exists to
  prevent. The caller cannot rewrite what it is not told about.
- _One `isCanonical` flag and nothing finer._ Cheaper, and it loses the only part of the answer that
  helps a reader diagnose a link: which of 3223 characters was wrong.

**Consequence.** M8's router must rewrite the URL after parsing rather than merely accepting it —
ADR-0009's consequence, now with the string to rewrite _to_ supplied by the parse rather than
recomputed at the call site.

---

## ADR-0021 — The URL codec's error classes are flat, with no shared base

**Decision.** `src/app/errors.ts` declares nine independent error classes —
`UrlPrefixError`, `UnknownFormatVersionError`, `UrlSegmentCountError`, `UrlSegmentLabelError`,
`NonNumericComponentError`, `UnknownLanguageError`, `UnknownUrlParameterError`,
`DuplicateUrlParameterError`, `UndecodableParameterError` — with no common base class, and `core`'s
errors pass through the codec unwrapped.

**Why.** A base class here would catch only part of what the codec throws while looking as though it
caught all of it. Parsing a fragment also surfaces `InvalidAddressError`, `AddressBeyondLibraryError`
and `UnknownSymbolError` from `core`, and those cannot extend an app-layer base: `core` imports
nothing (architecture §1). So `catch (e) { if (e instanceof UrlError) … }` would be a plausible,
wrong, and silently wrong way to handle a URL — the three refusals it misses are the ones about the
address itself, which is the half a caller most needs to report.

Wrapping `core`'s errors to restore the hierarchy is the other way to get it, and it is worse: the
bounds would have to be re-derived in `app/`, where `assertValidAddress` already derives them from
`WALLS_PER_ROOM`, `SHELVES_PER_WALL`, `BOOKS_PER_SHELF` and `PAGES_PER_BOOK` and already names which
component crossed which bound. Two homes for one number (ADR-0013), and the second one further from
the SPEC.

What replaces the base class is a **table**: the module doc comment lists every input shape against
the error it produces, in one place, next to the code that produces it. That is the thing a caller
actually needs — not a type to catch, but the list of what can go wrong.

**Alternatives rejected.**

- _A `UrlError` base for the app-layer nine._ Covers nine of twelve refusals and reads as though it
  covers twelve.
- _Wrap `core`'s three in app-layer types._ Re-derives bounds that `core` owns, to buy a hierarchy
  that is only wanted because it was assumed.
- _One error type with a discriminant field._ Loses `instanceof`, and makes the refusal a value to
  switch on rather than a type the compiler can narrow — which is the shape code-style §4 rejects
  when it says a domain situation gets a dedicated type.

**Consequence.** A caller handling URL failures enumerates what it cares about rather than catching
a base, and the doc-comment table is load-bearing documentation: it is the only complete statement of
the codec's failure surface, so a new refusal is added there in the same change or the surface is
silently understated.

---

## ADR-0022 — `+` in a fragment parameter is a literal plus

**Decision.** The codec reads `+` in a `q` or `lang` value as the character `+`, not as a space, and
parameters are parsed and written by hand rather than through `URLSearchParams`, in the fixed order
SPEC §7 writes them: `q` then `lang`.

**Why.** Reading `+` as a space is form encoding — `application/x-www-form-urlencoded` — and this is
a URL fragment, not a submitted form. Nothing on this path ever produces that encoding:
`encodeURIComponent` writes a space as `%20`. So the only way a `+` reaches the parser is that
somebody typed or pasted one, and a reader of this library searching for a literal plus is far more
likely than one who meant a space and wrote a plus.

`URLSearchParams` was rejected for the same reason first — it applies form decoding, so it would turn
that typed `+` into a space — and then for a second one that matters as much: it gives no control
over parameter order, and a **fixed** order is what makes a canonical fragment a single string
rather than one of a set of equivalent ones. ADR-0020 computes `canonicalFragment` by re-serialising;
that is only a canonical form if serialising twice from the same address yields the same bytes.

**Alternatives rejected.**

- _`URLSearchParams`._ Form-decodes `+`, and leaves parameter order to the implementation. Both
  break something this scheme needs.
- _Accept `+` as a space but keep writing `%20`._ Asymmetric: the parse of a serialised fragment
  would no longer be the identity on queries containing a plus, so the round-trip property SPEC §7
  rests on would hold only for queries that avoid one character.
- _Refuse `+` outright as ambiguous._ Refuses a character that is in neither alphabet's way and that
  a search query may legitimately contain.

**Consequence.** `q` is percent-decoded with `decodeURIComponent` and nothing else, so an invalid
sequence is a refusal (`UndecodableParameterError`) rather than a replacement character, and the
round trip over queries built from Cyrillic text and from the scheme's own delimiters is a property
test rather than a set of examples.

---

## ADR-0023 — Static mutants are measured, not ignored

**Decision.** `ignoreStatic` stays **off**, and is written out as `"ignoreStatic": false` in
`stryker.config.json` rather than left to the default, with a comment naming this record. The 125
static mutants in `src/core` stay in the scored denominator.

**Why.** Two corrections before the figures, because the option has been discussed three times on a
premise that was wrong each time.

First: **the option was never set.** It is not in `stryker.config.json` and never has been, and
`stryker-schema.json` gives it `"default": false`, so the committed behaviour has always been
`false`. Second: until `d6e4cfa` it could not have mattered either way. Under the previous runner no
coverage map reached Stryker core (ADR-0017), `TestCoverage.hasCoverage` was `!!staticCoverage` and
therefore `false`, and `mutant-test-planner.js` never entered the branch that reads the option — so
**both** of its branches were unreachable for every mutant in the project, and every measurement
anyone took of it was a measurement of something else. That is issue #25. Since the upgrade the
planner flags 125 static mutants of 614 and warns that they account for about 62% of the run, so the
option has an observable effect for the first time, and the question is whether to turn it **on**.

**The measurement.** Two full runs of `a1ea587`, same configuration in every other respect, run
sequentially so neither competed with the other for the four cores. Node 22.23.4, Stryker 9.6.1,
`concurrency: 4`, on an Intel Xeon at 2.10 GHz — **not** `ubuntu-latest`, so the absolute durations
belong to this machine and the ratio between them is the transferable part (ADR-0013).

|                             | `false` (committed) | `true`        |
| --------------------------- | ------------------- | ------------- |
| **duration**                | **9m10s**           | **6m47s**     |
| wall clock, including start | 552 s               | 408 s         |
| tests per mutant            | 7.37                | 4.00          |
| instrumented                | 614                 | 614           |
| `Ignored`                   | 4                   | **97**        |
| scored denominator          | **610**             | **517**       |
| killed / timeout / survived | 546 / 26 / 38       | 468 / 20 / 29 |
| no coverage                 | 0                   | 0             |
| **score**                   | **93.77**           | **94.39**     |

Paired on mutant id, every difference is accounted for and none of it is noise about the option:

- **93 `Ignored`** that were not: 89 `Killed → Ignored`, 1 `Timeout → Ignored`, 3
  `Survived → Ignored`. These are the purely static mutants — static coverage, no `coveredBy` — and
  **90 of the 93 were being detected.**
- **6 `Survived → Killed`**: `prf.ts:98` twice, `alphabet.ts:48` twice, `alphabet.ts:50` twice. These
  are the hybrid mutants — static coverage _and_ real per-test coverage — which `ignoreStatic` moves
  onto their covering tests under runtime activation. Four of them are the `alphabet.ts` lines issue
  #6 opened about, and this is the demonstration that #6 was right about them.
- 7 `Timeout → Killed` and 2 `Killed → Timeout`, which are score-neutral and are the run-to-run
  flapping ADR-0018 measured.
- **No new survivors at all.**

**So what the option buys, exactly: 2m23s and six honest survivors, for 93 mutants.** Of those 93,
90 are ones this suite kills. Turning it on would relabel them `Ignored` — a truthful "not measured"
rather than a false accusation, but not a kill either — and would shrink what the tool measures by
**15% of the scored set** while the printed score went _up_ 0.62 points. A number that rises because
the denominator fell is the kind of figure ADR-0008 bought this tool to avoid producing.

**And the 93 are not in incidental code.** By file: `alphabet.ts` 88 (74 purely static, 14 hybrid),
`address.ts` 21 (11 / 10), `prf.ts` 15 (7 / 8), `library.ts` 1. They are static because
`buildAlphabet` runs at import to construct `PAGE_ALPHABET` and the address arithmetic is reached
while test modules initialise — that is, the alphabet table of ADR-0001 and the linearisation of
SPEC §3, which are exactly the two places where being silently wrong replaces every book in the
library without failing anything.

**The run length was the only argument for it, and it is gone.** 9m10s against 6m47s is 2m23s on a
run that is nightly, not on anybody's critical path (ADR-0014). It is worth saying plainly that this
is probably the whole story of why the option kept being proposed: it was first raised against a
47m52s run that `coverageAnalysis: "perTest"` was silently causing, where 62% of the time was a real
cost. Fix the cause and the saving is two minutes a night.

**A correction to #25's second point, which the measurement refutes.** That issue asks for the
record that "a static mutant is not killable by a suite that imports the module once". As a
generalisation about this project that is false: with `ignoreStatic` off, **116 of the 125 static
mutants are detected** — 114 killed and 2 timed out. The claim holds for nine of them, six hybrid
and three purely static, and not for the rest. What _is_ true, and is the part worth writing down,
is the other half: the planner's static handling is reachable only when coverage data exists, so an
absent coverage map presents as "nothing is static" rather than as an error. Before reasoning about
`static`, `coveredBy` or `ignoreStatic` in any future survivor investigation, confirm the report
contains coverage data at all.

**Alternatives rejected.**

- _`ignoreStatic: true`._ The measurement above: 2m23s and six recovered false survivals against 93
  mutants, 90 of them currently killed, in the alphabet table and the address arithmetic.
- _Leave it unset, since `false` is the default._ An unset option is how this one became
  unexaminable: it was proposed twice, measured three times and discussed in two issues while being
  invisible in the repository. The explicit `false` and its comment cost two lines and make the
  decision findable where it is applied.
- _`coverageAnalysis: "all"`._ Removes the per-test attribution the hybrid fix depends on, so the 32
  hybrids become indistinguishable from purely static ones, and costs the hour ADR-0014's correction
  describes.
- _Excluding the nine undetected static mutants with `// Stryker disable`._ Those comments are for
  mutants that are genuinely equivalent, with the reason written beside them (`library.ts:259`,
  `prf.ts:96`). None of these nine is equivalent; six of them are killed by their own covering tests
  the moment the planner is allowed to run them that way, which makes them a reporting artefact, and
  the remaining three are an untested branch of the address arithmetic.

**Consequence.** The survivor list overstates by six: `prf.ts:98` and the four `alphabet.ts` lines
are reported as survivors on every run and are killed by the suite when the mutation is applied by
hand. That is the price of keeping 93 mutants measured, it is bounded and named, and testing.md §4
already requires a survivor to be hand-applied before it is acted on — which is precisely the check
that catches these six.

**Open: can the hybrid mutants be run on their covering tests without ignoring the purely static
ones?** `mutant-test-planner.js` bundles the two behaviours behind one flag: its first branch takes
`!isStatic || (ignoreStatic && coveredBy.length)` and its second `Ignored`s everything else static,
so there is no configuration that selects the first without the second. Were there, the answer here
would be trivially yes — six false survivals removed, 93 mutants kept, and about 2m23s of the saving
with them. Nothing in this repository can settle that; it is an upstream shape, and the thing to put
to Stryker is whether the hybrid case deserves its own option. Recorded rather than acted on because
the workaround costs nothing a reader is not already told to do, and because patching the planner
locally would make this project's score incomparable with its own history. Issues #6 and #25 carry
the six named mutants.

**Answered from the test side, and the question turned out to be the wrong one (ADR-0031).** The six
do not have to be run on their covering tests at all. They are reported as survivors because the
test files that notice them fail to _collect_, so the run contains no failing test for Stryker to
read — not because static activation does not reach them. A test file that imports nothing from
`core` at the top still collects, and evaluating the module body inside a test turns the throw into
a failing test. The six are killed with `ignoreStatic` off, the planner untouched, and all 610
mutants still scored. What is left for upstream is narrower and worth reporting on its own: a Vitest
run in which no test ran at all is reported as a survival.

---

## ADR-0024 — The worker yields between requests, and a drain begins with a yield and never ends with one

**Decision.** The worker's message loop takes delivery of messages and computing them separately.
`accept` answers a payload claiming to be a `cancel` **on arrival** and queues everything else, which
is O(1). The drain **hands the event loop back before computing anything**, then answers the queue in
order, yielding again once `REQUEST_SLICE_MS` — **4 ms** — of compute has gone by, and **never
yielding into an empty queue**. The yield is a `MessageChannel` round trip.

**Why.** The naive loop is `onmessage = (event) => post(handle(event.data))`. It passes every test the
handler has and the feature it implements does nothing. Fan a shelf out and 32 request messages are
queued as 32 tasks; the worker runs them back to back, about a millisecond apiece; the `cancel` the
client posts 5 ms later is queued **behind** the 27 requests it was trying to prevent and is read
about 27 ms after the last title it could have saved. Every title is computed. The handler then
answers each cancel `reply-in-flight`, truthfully, and the client correctly discards 27 results it
paid for in full. Nothing is red, and cancellation is decorative — which is this repository's
recurring defect in a new place: a mechanism that is configured, tested and reaches nothing.

The leading yield is what makes the queue worth having, and leaving it out is the subtle way to
rebuild the naive loop out of the right parts. Without it the first `accept` drains the single
message it just queued, synchronously, inside its own task — so the queue holds at most one request,
the other 31 are still in the event loop's queue, and the cancel is the 33rd task behind them exactly
as before. **A queue only overtakes work that is actually in it.**

Which is also why what `protocol.ts` calls a channel that overtakes the queue is one queue and one
`postMessage` rather than a second `MessagePort`. Both ports' deliveries land in the same task queue
in arrival order, so a cancel posted after 32 requests is the 33rd task either way. What makes it
overtake is that by then the work is no longer in the queue it has to overtake.

**Why the yield is a macrotask, and specifically a message.** `queueMicrotask` and a bare `await`
drain the microtask queue and return to the same task, so no `message` event is delivered in between
and a loop yielding that way would read no cancellation at all. Only returning to the event loop lets
a message in. Among macrotasks it is a `MessageChannel` round trip and not `setTimeout(0)`, because a
browser clamps nested timers to 4 ms after five levels of nesting and the drain's timers **are**
nested — each is scheduled from inside the previous one's callback. That would add a 4 ms sleep to
every 4 ms slice and halve the rate at which a shelf is generated, for no benefit. A message has no
such clamp.

**Why 4 ms.** It is the one figure in the loop that does not vary with the machine, which is why it is
the one that is fixed, and both directions have a cost. A slice of 1 ms would check for cancellation
between every title and spend a few percent of the thread doing it; a slice of 32 ms would be the
naive loop with extra steps, reading a cancel only once a shelf had finished. A title costs 0.46 ms
on the fastest machine on record and 0.98 ms on the slowest of ADR-0005's three, so a 4 ms slice is
three to eight titles there — and 1.33 ms on the fourth machine now recorded in ADR-0005, where it is
three. The cost of a yield is a task-queue turn, microseconds, so a slice three to eight requests long
spends well under 1% of the thread on yielding. It is a clock and not a counter because the budget is
4 ms of **compute**, and how many requests fit in 4 ms is exactly what varies by a factor of three
across the machines in that record.

**The measurement.** 32 title requests to the worker through a real `node:worker_threads` thread, with
the cancels for the second half posted when the first answer comes back — the timing a camera has,
about 28 ms of work still queued. A `dropped` response can only be produced for a request refused
_before_ `core` was called, so the disposition is what discriminates rather than the count of
rejections. On the container named in the pull request, an **Intel(R) Xeon(R) Processor @ 2.10GHz, 4
logical cores, 15.7 GiB, Node v22.23.4 on linux/x64** (ADR-0013):

| drain                 | titles computed | dropped | dispositions           |
| --------------------- | --------------: | ------: | ---------------------- |
| as written            |          **16** |  **16** | 16 × `pre-emptive`     |
| slice yield removed   |              32 |       0 | 16 × `reply-in-flight` |
| leading yield removed |              32 |       0 | 16 × `reply-in-flight` |
| both removed          |              32 |       0 | 16 × `reply-in-flight` |

So abandoning a shelf half way through abandons half the work, and without a yield it abandons none of
it **while reporting the cancellation truthfully** — the decorative-feature failure, reproduced rather
than argued.

**Why the drain never yields into an empty queue, which was found by measuring rather than by
reasoning.** With only the _leading_ yield removed the loop first measured as unchanged: 16 and 16.
The cause was the drain's trailing yield into an already empty queue, which let the queue fill one
request late and papered over the missing leading yield. Pinned by a fourth variant — no leading yield
**and** no yield into an empty queue → **32 computed, 0 dropped** — while keeping the leading yield and
dropping the trailing one stays at 16 and 16. The drain was changed to never yield into an empty queue,
which is one macrotask cheaper and makes the leading yield load-bearing and detectable; the table above
is after that change. A guard that is red in only one of the two places it should be is a guard partly
reporting a safety it does not have.

**Alternatives rejected.**

- _A second `MessagePort` for cancels._ Overtakes nothing: both ports deliver into the same task queue
  in arrival order. Covered above, and it is the alternative `protocol.ts`'s wording invites.
- _`queueMicrotask`, or a bare `await`, as the yield._ Never leaves the task, so no message is
  delivered and the naive loop's behaviour is unchanged.
- _`setTimeout(0)`._ Clamped to 4 ms once nested, which doubles a slice.
- _Counting requests instead of milliseconds for the slice._ A budget that varies by a factor of three
  across the machines in ADR-0005, which is the thing ADR-0013 forbids.
- _A module-level `MessageChannel` singleton instead of one per yield._ One allocation instead of about
  eight per shelf, against 25 to 33 ms of `bigint` arithmetic — not measurable — and an open port with
  a listener keeps its host's event loop referenced, which is a test process that never exits.

**Consequence.** One extra task-queue turn before a burst is answered — microseconds against the 1.0 to
1.35 ms of the first page in it (ADR-0005) — and one more per slice. In exchange a shelf abandoned
after 5 ms stops after about 5 ms of compute instead of running all 32 titles to completion, which is
what makes ADR-0016's rejection worth issuing. `WorkerLoop.whenIdle` is the worker-side half of the
`waitForIdle()` that testing.md §7 specifies so that no end-to-end test ever sleeps on a duration; the
main-thread half is ADR-0025's.

**Open: none of this closes M3's frame gate, and it cannot be closed here.** The gate reads "generating
32 shelf titles drops no frame", and "drops no frame" is a statement about a render loop: `engine/` is a
stub, there is no `setAnimationLoop`, no `window.__scriptorium` hook and no scripted camera flight. What
was measured instead is a 60 fps timer on an otherwise idle main thread while 25 shelves are generated —
a 16.17 ms median, an 18.13 to 20.20 ms maximum, no frame over 32 ms in 365 frames across four runs, and
0.0 to 1.1% over 20 ms, against 96.2% of frames over 32 ms for the same work inline. The main thread's
own share of a shelf is 0.75 to 0.95 ms, which is the figure that could have sunk this: architecture §2
puts anything above ~1 ms on the worker, and the fan-out plus 32 response handlers sits just under it.
The assertion that closes the gate is the one testing.md §5 already specifies, through the debug hook,
and it belongs to M4/M5. No threshold is added anywhere from the figures above, for ADR-0013's reason.

---

## ADR-0025 — A generation call returns a cancellable handle, not a promise

**Decision.** Every `GenerationClient` call returns a `GenerationRequest<T>` — `ids`, `result`,
`cancel()` — rather than a bare promise, and rather than taking an `AbortSignal` the caller owns.
`cancel()` is idempotent and a no-op once the call has settled. Request ids are monotonic integers
owned by the client, never a timestamp and never random (architecture §5).

**Why.** ADR-0016 settled that a cancelled request **rejects** rather than hanging, and deferred the
`AbortSignal` because it moves the bookkeeping into `ui/` for a single call site. This record is the
other half of that: what was built instead, and why the handle carries what it carries.

**A handle rather than a plain promise, because cancellation names ids and not addresses.** The same
address may be in flight under two ids while a camera passes a shelf twice (`protocol.ts`), so
"cancel the request for this address" is not a well-formed instruction — it names either both or
neither, and which one the caller meant is information only the caller has. A handle is that
information, held by the one object that has it.

**`ids` is the set actually issued, which is not always one and not always more than zero.** A shelf
issues up to `BOOKS_PER_SHELF` of them; a call served entirely from the cache issues none and never
touches the worker, because ADR-0019 puts the cache in front of the boundary rather than behind it. A
caller never has to branch on which happened — `cancel()` is meaningful either way — and `ids` is
there for the case that wants to know, such as a test asserting that a hit did not cross the thread.

**The race against the reply is won by one rule: an id leaves the pending table the moment it is
cancelled.** A reply the worker had already computed then arrives, finds nothing to settle, and
changes nothing — it is not cached, nothing resolves on it, and **no set of cancelled ids has to be
kept** in order to recognise it, because ids are monotonic and never reused. That is also why
`cancel-ack` is a no-op for all three of its dispositions: the client has already done everything the
acknowledgement could tell it to do. A no-op there is a result of rejecting on the spot, not an
oversight, and it is worth writing down because it looks like one.

**Admission to the cache happens in a `then` on the request's own promise, not in the response
handler.** It is the same mechanism seen from the other side: cancellation rejects, so the admission
never runs. ADR-0019 states that keeping a cancelled result out of the cache is the **client's** to
enforce, because `cache.ts` holds no opinion about request ids; this is the enforcement, and it is one
line rather than a check that a future response kind could forget.

The behaviour is measured rather than argued, through a real thread, in ADR-0024's table: 32 titles
requested, the second half cancelled when the first answer comes back, **16 computed and 16
`dropped`, all 16 `pre-emptive`**. The dispositions are the part that discriminates — a `dropped`
response can only be produced for a request refused before `core` was called.

**Alternatives rejected.**

- _An `AbortSignal` the caller owns._ ADR-0016's reason, unchanged: closer to the platform, and worth
  revisiting when there is a second call site. That is still open there rather than re-decided here.
- _A bare promise._ Cancelling then has to name an address, which does not identify a request.
- _A promise that never settles for a cancelled request._ ADR-0016 rejected it: a retained
  continuation per cancelled request, growing with exactly the camera motion the feature exists for.
- _Keeping a set of cancelled ids so a late reply can be recognised._ Unnecessary once the id leaves
  the pending table, and it is the same unbounded growth in a smaller container.
- _One batch message per shelf instead of 32 single-address requests._ Cheaper on the wire and it
  cannot express the cancellation of part of itself, which is the normal case — some of a shelf's 32
  titles have arrived and some are still queued in the worker. Aggregating in the client is what lets
  a half-cached shelf issue only what it must.
- _A `locate` cache keyed by the page._ Separate decision, ADR-0026.

**Consequence.** `GenerationClient.pendingCount` is the main-thread half of the `waitForIdle()` that
testing.md §7 specifies; the worker-side half is `WorkerLoop.whenIdle` (ADR-0024). Cancellation is
asserted by outcome throughout, per ADR-0016, so no test in this layer waits on a duration — the
integration test waits on an exact message count instead, which the protocol's one-response-per-message
rule makes exact.

---

## ADR-0026 — A located address is not cached

**Decision.** `locate` results are not cached, and `cache.ts` has no store for them. The cache stays
the two byte-budgeted stores of ADR-0019 — pages and titles — and `locate` is the one `core` call that
always crosses the thread boundary.

**Why.** The key would have to be the page. ADR-0019 charges a key against its store's budget, and
spells out why: an entry costs `(key.length + value.length) * 2`, and a page's key — the base-36
rendering of its linear index — is as long as the page it names. A `locate` store inverts that
relation into its extreme case, because here the key **is** the 3200-character page and the value is an
address object. So an entry is about **6.4 KB of key** to save the **1.0 to 1.4 ms** a `locate` costs
(ADR-0005). That is the worst ratio of anything the cache could hold, and it is the opposite end of the
same arithmetic that made the title store's keys 99.2% of its ceiling.

And no access pattern asks twice. ADR-0019 derives each ceiling from the pattern that revisits that
store's contents — page-at-a-time inside a volume, and the camera turning inside a room. There is no
such pattern here: **a search query is typed once, and the address it resolves to is what the
navigation state then holds** (architecture §4), so the second lookup of a given page does not happen.
A cache with no re-reads is a byte budget spent on nothing.

**Alternatives rejected.**

- _A third store keyed by the page._ The figures above: the cache's worst key-to-value ratio, buying
  back a millisecond for a call nothing issues twice.
- _A third store keyed by a hash of the page._ Replaces 6.4 KB of key with 32 bytes, and pays a
  SHA-256 over 3200 characters on every lookup to save a `locate` that nothing repeats — and `core`'s
  `locate` is the Feistel network run backwards, so the hash is a real fraction of what it saves. It
  also introduces a failure mode this project does not currently have: two distinct pages hashing
  alike would resolve one page to the other's address, silently, which is exactly the class of wrong
  that ADR-0008 bought the mutation gate to defend against. Vanishingly unlikely is not the same as
  structurally impossible, and the trade buys nothing.
- _Caching the search query rather than the located page._ A short key, but the query is what is typed
  once; `search` and `locate` are different functions, and the one with a reusable key is not the one
  being asked about here.

**Consequence.** The budget arithmetic of ADR-0019 covers the whole cache, so there is no third ceiling
to derive and no third worst-case entry to name. The cost of the inverse direction is paid in full on
every search — 1.05 ms on ADR-0005's Intel runner, 1.41 to 1.44 ms on its AMD one — which is under a
tenth of a frame, once per query, and it is paid on the worker thread rather than the main one.
`locate` is therefore also the one call whose `GenerationRequest.ids` is never empty (ADR-0025): there
is no cache for it to hit.

---

## ADR-0027 — The worker's own messages are narrowed at the boundary too

**Decision.** `response.ts` narrows a payload posted **by the worker** from `unknown` before the client
acts on it, exactly as `handler.ts` narrows a payload posted by the client. Every member of the
narrowed `IncomingResponse` is a `Pick` of the protocol's own interface rather than a shape written out
again, and the two directions keep their own guards rather than sharing a module.

**Why.** code-style §1 says data crossing a boundary is untrusted and validated at runtime, and it does
not care which way the message travels. "The worker is our own code" is a promise to the compiler, and
**the compiler is not what delivers the message.** One concrete way the two ends disagree without
anybody making a mistake: a stale worker bundle served from an HTTP cache after a format change. A
`page` response whose `text` is `undefined` would then be admitted to the cache as a page and rendered
as the string `"undefined"` — nothing throws, nothing is red, and a reader is shown text that is not in
the library. That is ADR-0003's failure mode reached through the wire instead of through a constant.

**`Pick` rather than a restated shape** is what makes the module hold itself to the format: a renamed
field or an added response kind stops `response.ts` type-checking instead of being silently dropped on
arrival. The protocol's interfaces stay the single home of the wire format, which is ADR-0013's rule
applied to a type rather than to a number.

**An id is reported on failure whenever one could be read**, for the same reason `handler.ts` reports
it: a malformed message under a sound id still names a promise the client is holding, and leaving it
unnamed is the hang ADR-0016 exists to prevent. `null` means the message cannot be attributed to
anything, and then there is genuinely nothing to settle. This is what closes the gap between "every
message is answered exactly once" on the wire and "every request settles" on the main thread.

**The guards are this module's own.** `handler.ts`'s equivalents are private, deliberately: the two
directions of the format are reviewed separately and a shared guard module would couple them through
something that owns neither. The duplication is four predicates of one line each, which is a smaller
cost than a third module both directions have to agree with.

**Alternatives rejected.**

- _Trust the worker, because it is our own code._ The argument above: a promise to the compiler, which
  is not the transport. And the stale-bundle case needs nobody to have been careless.
- _`as` on arrival._ code-style §1 makes an assertion a red flag needing justification, and here the
  justification would be the very thing the boundary exists to check.
- _A shared guard module for both directions of the wire._ Couples the two halves of the format through
  a third module that owns neither, to save four one-line predicates.
- _A schema validation library._ code-style §7: twenty lines of your own code often beat a package with
  six transitive dependencies, and the shape is already written down once, as the protocol's
  interfaces, which a schema would be a second copy of.
- _Narrowing only the fields the client happens to read today, written out by hand._ That is what
  `Pick` does, except `Pick` fails to compile when the protocol moves and a hand-written shape does
  not.

**Consequence.** Every response kind either resolves or rejects a promise, the malformed included, so
the "every request settles" rule of ADR-0016 holds across the boundary and not merely up to it. Adding
a response kind means extending `IncomingResponse` and its guard in the same change, or the module does
not type-check.

**Open: the worker _scope_ is narrowed on the platform's word rather than on a measurement.**
`entry.ts` narrows `globalThis` structurally for the two members a worker scope must offer, rather than
taking the `WebWorker` lib — which redeclares much of `DOM` and would make every other module compile
against a scope it does not run in. The integration harness installs those two members over Node's
`parentPort` and then imports the real `entry.ts`, so the production module is what runs; what is
_assumed_ is that a browser's `DedicatedWorkerGlobalScope` offers the same two. That is the platform's
specification and not a measurement, and a browser `Worker` is not reachable from the `node`
environment this suite runs in. The Playwright suite exercises it once there is a page that loads the
worker (testing.md §6), which is M4/M5. Until then it is the one claim in this layer resting on a
specification rather than on a test.

---

## ADR-0028 — The suite's per-test and per-hook ceilings are chosen, and calibrated on CI

**Decision.** `vite.config.ts` sets **`testTimeout: 25_000`** and **`hookTimeout: 50_000`**, replacing
Vitest's 5 s and 10 s defaults. Both are hang guards and neither is a performance gate. Three per-file
overrides were re-examined against them: `library.test.ts`'s 120 s on five properties stays,
`layer-boundaries.test.ts` loses its `testTimeout` and keeps its `hookTimeout`, and
`worker-thread.integration.test.ts` loses both. `src/__tests__/test-budgets.test.ts` asserts that the
ceiling the runner applies is the one the config declares, and that nothing outside the config lowers
either one.

**Why.** `vitest.stryker.config.ts` raised `testTimeout` to 30 s with the reasoning written out — "not
a budget anyone chose, and it decided the mutation job by coin flip" — and ADR-0012 recorded it as a
third budget found the hard way. It raised the default only on the path where it had already produced a
visible failure. `vite.config.ts`, which every `npm run test`, every CI `verify` and every
`npm run coverage` reads, was left on the default, and the suite has grown into it: on a contended
developer machine five tests failed, all on timeouts and none on an assertion, at 5341 to 7871 ms
(issue #35). The same suite on the same machine idle passes all 556 in 26.8 s, and CI takes 18.9 s wall
with 45.4 s of test time. So nothing is broken today; what exists is a gate that decides by how busy
the machine is, which is what ADR-0013 was written about.

It is also not the sort of thing a reviewer can see. A test that times out **fails**, so under an
unchosen ceiling a slow test and a wrong one are the same red, and ADR-0014's correction is what that
costs: a 5 s cap was killing mutants on the clock rather than on an assertion and inflating the
mutation score by five points.

**What this is not.** The wall-clock budget is testing.md §5's, asserted in
`src/core/__tests__/performance.test.ts` against a committed baseline and enforced by `verify`
uninstrumented on every push (ADR-0013, ADR-0012). Nothing here is what notices the library getting
slower, and raising a timeout cannot hide a slowdown, because the budget that would catch one is a
separate assertion in a separate file. Conversely a timeout is useless as a performance gate: it fires
on the machine being busy, which is the property ADR-0013 removed from the budget.

**The measurement.** Taken on `ubuntu-latest`, because that is the machine that enforces this
(ADR-0013) and it is also where the slower of the two consumers runs. A throwaway reporter printing
each test's `onTestCaseResult` duration and each module's `onTestModuleEnd` diagnostics — a module's
residual, its own duration less the sum of its tests', is what a `beforeAll` costs — pushed on a scratch
branch so that both commands could be timed on real runners. **Eighteen runs**: twelve of
`npm run test` and six of `npm run coverage`, over three CPU models, Node v22.23.4, images
ubuntu24/20261026.354.1 and ubuntu24/20261101.360.1. Runs
[41688546201](https://github.com/valmlord/scriptorium-3d/actions/runs/41688546201) and
[41689066798](https://github.com/valmlord/scriptorium-3d/actions/runs/41689066798), on the scratch
branch `chore/infra-test-duration-probe`. **Both runs are red overall and the figures are still
sound**: the reporter is a loose `.mjs` at the repository root, so `format` and `verify` failed on it
while the duration jobs — which are what the numbers come from, and which run the suite unmodified —
passed. The branch is not merged and can be deleted once these figures are read.

| mode               | machine            | runs | slowest test in the suite | slowest test this ceiling governs |      heaviest hook |
| ------------------ | ------------------ | ---: | ------------------------: | --------------------------------: | -----------------: |
| `npm run test`     | Intel Xeon 6973P-C |    3 |            4137 – 4483 ms |                    1624 – 1864 ms |     2108 – 2320 ms |
| `npm run test`     | AMD EPYC 7763      |    7 |            5457 – 5866 ms |                    2211 – 2927 ms |     3298 – 3590 ms |
| `npm run test`     | AMD EPYC 9V45      |    2 |            3176 – 3401 ms |                    1232 – 1399 ms |     2230 – 2328 ms |
| `npm run coverage` | AMD EPYC 7763      |    4 |        23 652 – 24 007 ms |                3905 – **4318** ms | 7572 – **9328** ms |
| `npm run coverage` | AMD EPYC 9V45      |    2 |        12 619 – 12 671 ms |                    2244 – 2319 ms |     4371 – 4858 ms |

The two columns differ because five properties in `library.test.ts` already carry their own 120 s — so
the suite's slowest tests are not the ones the configured ceiling decides. **It is the governed column
that calibrates `testTimeout`**, and the ungoverned one that settles whether those five overrides can
go. The heaviest hook is the `beforeAll` in `layer-boundaries.test.ts`, which builds a type-aware
TypeScript program for the whole project; it is the only hook in the suite that costs anything, and it
is governed by that file's own `hookTimeout`.

Three things the figures say that reading the repository does not. `ubuntu-latest` draws more than one
machine, and on a page the three models here span a factor of 1.8 on the same test — so a figure taken
from one of them is not a figure about CI. Coverage instrumentation costs between 1.6x and 4.2x, so the
`coverage` job and not `verify` is the binding case, and `coverage` is also the run where the wall-clock
budget is deliberately not asserted (ADR-0012). And the suite's slowest test reaches **24.0 s** — Vitest's
default is not merely unchosen, it is five times under what the suite already does.

**Why 25 s.** A threshold is really a statement about how much slower than the worst observation a run
may be before it is called a hang:

| `testTimeout`  | vs. the 4318 ms worst governed observation | what it means                                                                                         |
| -------------- | -----------------------------------------: | ----------------------------------------------------------------------------------------------------- |
| 5 s, inherited |                                  **1.16x** | already crossed: five tests at 5341 to 7871 ms on a contended machine (#35)                           |
| 10 s           |                                      2.32x | 27% above the worst contended observation on record. The ADR-0013 mistake with a wider number         |
| **25 s**       |                                  **5.79x** | one hang costs 25 s against an 18.9 s suite                                                           |
| 30 s           |                                      6.95x | `vitest.stryker.config.ts`'s figure, derived from Stryker's own deadline and not from these durations |
| 120 s          |                                     27.79x | `library.test.ts`'s figure. One hang costs six times the whole job                                    |

Five times the slowest observation is the margin ADR-0013 settled on for the performance budget, and for
the same reason: what is being guarded against is unbounded — a promise that never settles, a loop that
never exits, a thread that never replies — so margin costs no detection power at all, where a ceiling
sitting a few percent above the enforcing machine's own value decides by scheduler luck. The other
direction has a cost too, and it is the one a looser figure ignores: a ceiling is how long CI waits for
a hang. At 25 s a hung test roughly doubles the job, which is cheap and visible; at 120 s it is six jobs.

**Why 50 s for hooks, and what it honestly governs.** 5.4x the 9328 ms worst hook observation, by the
same arithmetic. **It governs no hook that exists**, and that is worth stating rather than leaving for
a reader to discover: the only two files with hooks both set their own, so the global reaches nothing
today. It is set because the next file that adds a hook would otherwise inherit a figure nobody chose —
and the figure nobody chose had already been reached. Vitest's default is 10 s, and the heaviest hook on
record is 9328 ms: **within 7% of it**, under a setting that has never been examined. That it reaches a
hook at all was verified rather than assumed, by removing `layer-boundaries.test.ts`'s own override and
setting the global to 50 ms: `Hook timed out in 50ms`, with that file's 20 tests skipped.

**The per-file overrides, re-examined.** Three existed. One was load-bearing, one had inverted, one had
never enforced anything:

| file                                                     | before                                      | after                 | why                                                                              |
| -------------------------------------------------------- | ------------------------------------------- | --------------------- | -------------------------------------------------------------------------------- |
| `src/core/__tests__/library.test.ts`                     | `PROPERTY_TIMEOUT_MS = 120_000`, five tests | unchanged             | those five reach 24.0 s under coverage; 25 s would be 1.04x an observed value    |
| `src/__tests__/layer-boundaries.test.ts`                 | `testTimeout: 20_000, hookTimeout: 60_000`  | `hookTimeout: 60_000` | the 20 s had stopped raising the ceiling and started lowering it                 |
| `src/worker/__tests__/worker-thread.integration.test.ts` | `testTimeout: 60_000, hookTimeout: 120_000` | removed               | 41x and 530x this file's own worst observations — 610 ms a test, 94 ms the build |

The middle row is the interesting one and it is this repository's recurring defect arriving by a route
nobody built: nothing about that file changed, and a line written to **raise** a ceiling became a line
that **narrows** one, silently, the moment the global passed it. Nothing would have gone red. The
bottom row is the familiar shape — figures sized against Vitest's default rather than against the
file, which this file's own measurements put at 610 ms for its slowest test and 45 to 94 ms for the
Vite build in its `beforeAll`.

**What keeps it honest.** `src/__tests__/test-budgets.test.ts` asserts the per-test ceiling **the runner
applied to the test doing the asserting**, read from `getCurrentTest()`, against what the config
declares. Not that the key is present: a key the tool silently discards is present too, which is the
`_comment_timeout` shape this repository has now removed eleven of. It then scans the suite for budgets
declared outside the config — `vi.setConfig` calls and `*_TIMEOUT_MS` constants — and asserts each one
**raises** a ceiling rather than lowering it, which is the `layer-boundaries.test.ts` inversion above
turned into a red test. The list of the two budgets that exist is asserted exactly, so the scan cannot
pass by matching nothing: that is ADR-0014's dry run reporting success on 43 of 229 tests, in a smaller
place. No figure is written in that file; both come from the config, so it cannot become a number's
second home (ADR-0013).

Both ceilings were watched firing, and the guard was watched going red six ways: the configured
`testTimeout` at 50 ms turns five of `bignum.test.ts`'s eighteen red with `Test timed out in 50ms`; the
guard goes red on the `testTimeout` being deleted, on it being set back to 5 s, on the `hookTimeout`
being deleted, on a per-file `hookTimeout` of 40 s, on the removed `testTimeout: 20_000` being put back,
and on `PROPERTY_TIMEOUT_MS` dropping to 20 s.

**Alternatives rejected.**

- _Leave the default and let the five contended failures stand._ They are timeouts on property tests
  that testing.md §2 requires at 1000 cases. A flaky red is fixed or deleted the day it is noticed
  (testing.md §9), and retrying discards the information the test exists to produce.
- _10 s._ 2.32x the worst governed observation and 27% above the worst contended one. A gate that close
  to a measured value is the arrangement ADR-0013 removed after a budget failed one CI run at 5.052 ms
  and passed the next.
- _30 s, matching `vitest.stryker.config.ts`._ Reads tidy and is derived from the wrong thing: that
  figure's lower bound is Stryker's own per-mutant deadline of about 29 s, which has nothing to do with
  how long this suite's tests take. Two numbers that agree for unrelated reasons invite a future change
  to move both. Keeping them apart also keeps that override meaningful — it is still a raise, and it
  stops being one if this ceiling ever passes 29 s, which is now noted there.
- _One ceiling wide enough for the whole suite, so the five `library.test.ts` overrides could go._ That
  means 120 s, since those five reach 24.0 s under coverage. It buys tidiness with a hang guard that
  waits two minutes per test, and 25 s is already 5.79x what it has to cover.
- _Calibrate on the development machine._ It is not the machine that enforces this (ADR-0013), and it
  is 1.8x off the runners in both directions depending on which model `ubuntu-latest` draws.
- _Scale the ceiling by a measured instrumentation factor, so `coverage` and `verify` get different
  figures._ Invents a number that moves with the runner image and the provider, which ADR-0012 rejected
  for the budget and ADR-0014 rejected for the runner.
- _Record the figure in testing.md as well._ The budget of testing.md §5 lives in that document because
  it is a stated contract about the library's speed. A hang guard is not a contract about anything; its
  home is the config that applies it and this record. One home (ADR-0013).

**Consequence.** `npm run test` and `npm run coverage` now run on a ceiling derived from what they
actually do on the machine that enforces it, and a per-file budget that stops raising one goes red
instead of quietly narrowing it. `vitest.stryker.config.ts` keeps its own 30 s and now overrides a chosen
25 s rather than an unexamined 5 s; its comment says so, and says what makes it stop being worth having.
`vite.config.ts` also imports `defineConfig` from `vitest/config` rather than `vite`, because its `test`
block is Vitest's and Vite's `UserConfig` does not carry it — so that block had been type-checked only
by accident, in programs that happened to include another file importing `vitest/config`, and reading it
from a test is what surfaced that.

**Open: nothing in CI reports a test duration, so the next time the suite grows into a ceiling nobody
will see it either.** The figures above came from a reporter on a scratch branch and are not reproducible
from `main` once it is gone; six months from now the only way to know whether 25 s is still 5.79x or 1.5x is to take the
measurement by hand again, which is exactly how the 5 s default survived as long as it did. The guard
test catches a ceiling that stops being applied, not one that stops being generous. The cheap answer is
the one `generation-cost` already uses for the benchmark table (ADR-0013): publish the slowest tests to
the run summary, where GitHub shows them on the run's own page, with no threshold attached — a figure
nobody can find without opening a log is a figure nobody will find. Whether that earns a job is the
question, and it is recorded rather than acted on because `verify`'s critical path is held by other jobs
and adding a step to it would be the easy half of the answer with the reporting half missing.

---

## ADR-0029 — The layer rule's line runs inside `core`, not around it

**Decision.** `core` is two groups of modules, and the layer rule is phrased on the groups rather than on
the layer:

| group                  | modules                                             | who may import it at runtime |
| ---------------------- | --------------------------------------------------- | ---------------------------- |
| the address model      | `address`, `alphabet`, `bignum`, `errors`, `format` | every layer                  |
| the generation surface | `prf`, `feistel`, `library`, and the `index` barrel | `worker` only                |

`FORMAT_VERSION` moves out of `library.ts` into a `format.ts` of its own, the barrel is closed to every
layer but `worker`, and all seven layer directories plus the composition root `src/*.ts` get a block in
`eslint.config.js` — `state`, `app` and `src/main.ts` had none. `src/__tests__/` deliberately gets none:
those three files are the suite's own meta-tests and belong to no layer.

**Why.** `architecture.md` §1 said `engine → (three only)` and then said of itself: _"These are enforced
with `no-restricted-imports` in the ESLint config. The lint rule is the specification; this list is its
explanation."_ Issue #39 found the two disagreeing. Verifying the rest found five more, so the document
and the rule disagreed in six ways at once:

| layer    | the table said                 | the rule enforced                                                             |
| -------- | ------------------------------ | ----------------------------------------------------------------------------- |
| `engine` | `(three only)`                 | `@core/*` unrestricted — a `getPage` on the main thread, lint-clean           |
| `motion` | `(gsap only)`                  | the same hole, unmentioned by the issue                                       |
| `state`  | `core types`                   | **no block at all**: anything, including `three` and the generation surface   |
| `app`    | everything, and uniquely so    | **no block at all**, which looked right only because `app` is allowed most    |
| `worker` | `worker → core`                | `@motion/*`, `@state/*`, `three` and `gsap` all unrestricted                  |
| `ui`     | `state`, `worker client`, i18n | `@state/*` and all of `@worker/*` forbidden at runtime — stricter, not looser |

Five of the six are the rule being **looser** than the document, and one is the rule being **stricter**.

The specification is neither wording. It is ADR-0005's reasoning, which is about **generation**: "a direct
`getPage` on the main thread is a dropped frame waiting for the right moment", on measurements putting a
shelf of 32 titles at 14.8 to 45.0 ms across four machines — one and a half to two and a half frames, with
nothing left to render in. That argument does not reach `toLinear` on a five-field address, a radix table,
or a constant naming how many volumes a shelf holds. `core` imports nothing, and those cost nothing to
call, so depending on them couples a layer to no weight at all. **So the boundary ADR-0005 draws is not
between layers; it is inside `core`**, and once it is drawn there the answer to #39's question falls out:
PR #37's four `@core/address` imports in `src/engine` were right, and a `getPage` beside them would not
have been.

Three things follow, and each closes a route around the first:

- **`FORMAT_VERSION` moves to `src/core/format.ts`.** It is a constant naming the frozen format (SPEC
  §4.5) and it lived in `library.ts`, which made `src/app/url.ts` import the generation module to write
  `v1` into a fragment. `address.ts` was the other candidate and is the wrong owner: the version covers
  `DOMAIN_TAG`, the alphabet order, `ROUNDS`, `PRF_BYTES` _and_ the linearisation, so filing it under the
  address model would have been a second comment that lies. A module of its own imports nothing, names one
  thing, and costs nothing to read.
- **`@core/index` is closed to every layer but `worker`.** It re-exports `./library`, so a group naming
  `@core/library` is defeated by one import statement — and `url.ts` was already through it. Non-worker
  layers import the specific module, as `engine` already did.
- **`ui`'s row is reconciled toward the table, not the rule.** Runtime `@worker/client` and `@state/*` are
  allowed; `@core`'s address model is allowed with it, because excluding `ui` from arithmetic that costs
  nothing would reinstate the over-broad shape this record removes, and `ui` formats addresses. This is the
  one row that moved in the opposite direction from the others, and the reason is that it is the only one
  where the rule forbade something the architecture grants and the roadmap needs: M6 wires the reader to
  the worker client, so the rule as it stood was a red build waiting for the next milestone rather than a
  boundary anyone had chosen. Where the rule was looser than the document the document won; here the
  document was the narrower claim about what may happen at runtime, and it won again. The rule never wins
  on its own — it is the specification only once someone has decided what it should say.

**Two rules carry the boundary, not one, and the second exists because the first has holes a group
cannot close.** `no-restricted-imports` matches gitignore patterns against the import string and visits
only the static forms. Five spellings got past it, each verified by importing `getPage` through it and
calling it:

| spelling                            | why the groups cannot refuse it                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `import('@core/library')`           | the rule has no `ImportExpression` visitor at all in ESLint 10.9.1                            |
| ``import(`@core/library`)``         | a `TemplateLiteral`, not a `Literal`; Rollup still resolves it statically                     |
| `from '@core//library'`             | a doubled slash is not a path segment, so `*` never matches it                                |
| `from '../core/'`                   | the `!**/core/` negation below **must** re-admit this form, or the address model goes with it |
| `from '../core/address/../library'` | `!**/core/address` frees everything **under** a directory of that name, this included         |

The last two are the sharp ones, and they are the same fact twice. A gitignore negation cannot say "this
file but nothing under it": `!**/core/` was load-bearing for keeping `../core/address` free and the same
stroke re-admitted the directory spelling, and `!**/core/address` freed any path escaping upward through
it. That last one printed 3200 characters of real page text from `src/engine`, under a clean lint and a
clean `tsc --noEmit`.

**So the two mechanisms were given the jobs each is good at, rather than one patched twice.** The
gitignore groups keep the canonical `@core` alias and nothing else, because that is where
`allowTypeImports` has to be exact and gitignore is the only one of the two that gets it right. Every
relative path into `core` goes to a regex. The reason is the one the groups kept running into: that
syntax cannot anchor "relative paths only", so a group covering relative spellings had to be `**/core`,
which also matched **any package whose last segment is `core`** — it refused `@stryker-mutator/core`, a
devDependency of this repository, with a message about page generation, false in every clause. A regex
can tell `../core/library` from `@stryker-mutator/core`; a gitignore pattern cannot.

`no-restricted-syntax` is a core rule and takes an esquery selector, so this needs no new dependency, and
every regex is built from the same `CORE_ADDRESS_MODEL` array, so the list of free modules still has one
home (ADR-0013).

The regexes make three different claims, and each carries a message that is true of what it fires on:

| claim                                 | fires on                                         | message                                  |
| ------------------------------------- | ------------------------------------------------ | ---------------------------------------- |
| this is not how we cross layers       | any relative path into `core`                    | import core through its `@core` alias    |
| this alias is not spelled canonically | `@core//library`, `@core/`, `@core/address/../x` | import core by its canonical module path |
| this generates, and dynamically       | `import('@core/library')`, backticks included    | may not be imported dynamically          |

The distinction is not cosmetic, and code-style §5 is why. `@core//address` names the **address model**,
which every layer may import at runtime, so refusing it with a message about the generation surface would
tell the reader the opposite of what the table above says. A test asserts that message does **not** say
"generation surface".

The first two claims are about spelling, so they have no type-only exemption: `import type { X } from
'../core/library'` is refused as well, because a type import has the same alias available. Once a
specifier is canonical, `no-restricted-imports` decides whether the module is allowed, with its
`allowTypeImports` handling, which is correct and not worth reimplementing. `typeof import('@core/library')`
is a `TSImportType`, is deliberately not reached, and has a test of its own, because a type costs nothing.

**Why an allow-list, and why three spellings.** The generation group is written as "everything in `core`
except the address model" rather than as the four module names, so a module added to `core` tomorrow is
refused until someone decides it is address arithmetic. The patterns are gitignore-style over the import
**string**, not the resolved file, so each spelling that reaches the same module needs its own entry:
`@core/*` does not match `../core/library`, the globstar form does not match `@core/library`, and
`moduleResolution: "bundler"` resolves a bare `../core` to the barrel — verified, not assumed, by
type-checking an import of it. The bare-directory entry needs a trailing-slash negation beside it, because
a gitignore pattern that matches a directory excludes everything under it and no later negation can
re-include a file there; without it, `**/core` quietly took `../core/address` with it, and the test that
says the address model stays free is what caught that.

**What this does not cover, stated rather than left to be found.** Four things, none of them closed here:

- **A relative cross-layer import into a layer other than `core`.** The layer groups are written on the
  `@layer/*` aliases that every import in this repository uses, so `../ui/index` from `engine` is not
  matched. That gap predates this record and belongs to all seven blocks. For `core` it is **closed**:
  every relative path into `core` is refused, which is what let the groups shrink to the alias. Doing the
  same for the other six means one regex each, and is a change to all eight blocks rather than to this
  one boundary.
- **A genuinely computed specifier**, `import('@core/' + name)`. Nothing static can see it. A backtick
  specifier is _not_ computed, resolves statically, and is refused.

  This list was short three times, and each missing entry was found by _running_ `allowed/../forbidden`
  rather than by reasoning about the patterns. Whatever is still missing will be found the same way.

- **The dynamic form of every refusal other than `core`'s split.** The second rule is installed only in
  the six blocks that carry the generation restriction, and it matches only `core` specifiers, so
  `three`, `gsap`, `@ui/*` and the cross-layer groups are held by the static rule alone — the rule with
  no `ImportExpression` visitor. All of these lint clean today, verified rather than reasoned:
  `void import('three')` in `motion` (rule 3), `void import('@ui/index')` in `engine` and
  `void import('three')` in `ui` (rule 2), `void import('@worker/protocol')` in `ui` (rule 4),
  `void import('@state/index')` in `worker` — the very row this record lists above as a defect it fixes,
  whose static half is fixed and whose dynamic half is not — and `void import('gsap')` in `core`
  (rule 1). Closing them means every group's list existing twice, as a gitignore pattern and as a regex,
  which is the second home ADR-0013 exists to prevent; doing it properly means generating both from one
  table, and that is a change to all eight blocks rather than to this one boundary. `core`'s split is
  the one with both rules behind it because it is the one whose breach costs a frame rather than a
  review comment.
- **The bare `@core` alias.** No group matches it, and what refuses it is `npm run typecheck`:
  `tsconfig.json` maps only `@core/*` and carries no `baseUrl`, so `from '@core'` does not resolve, and
  `verify` runs `typecheck` before `lint`. Worth knowing that this rests on an asymmetry — `vite.aliases.ts`
  _would_ resolve it, and `alias-agreement.test.ts` normalises `@core/*` to `@core`, so that guard cannot
  notice. The dynamic-import selector does match it.
  **Alternatives rejected.**

- _Widen the document to match the rule: write `engine → three, core`._ That is the move the issue names
  and refuses. It would make the rule true by giving up the property ADR-0005 bought, and the first
  `getPage` in a layout function would be lint-clean.
- _Narrow the rule to match the document: forbid `@core/*` in `engine` outright._ Then PR #37's imports
  have to go, and `BOOKS_PER_SHELF`, `SHELVES_PER_WALL` and the linearisation get restated inside
  `engine` — a second home for numbers that already have one, which code-style §3 forbids and ADR-0013
  spent a record on.
- _Name the three forbidden modules instead of allow-listing the rest._ Reads shorter and defaults the
  wrong way: the next module in `core` would be importable everywhere until someone noticed, and "someone
  noticed" is what this repository has spent three days not being able to rely on.
- _Leave `FORMAT_VERSION` in `library.ts` and exempt it by name._ A per-symbol exemption is not something
  `no-restricted-imports` can express, so the exemption would have had to be the whole module, which is
  the hole.
- _Grant `state` the worker client, since its README claimed it._ The table says `core types`, and
  architecture §4 makes the FSM the source of truth for _where the user is_, not for page text — which is
  fetched by whatever renders it. If M5 or M6 finds otherwise, that is a row in the table and a group in
  the config changing together in one pull request, which is the mechanism working rather than failing.
  The layer READMEs are brought in step with the rule in the same change; three of them granted runtime
  imports the rule had always refused.

**Open: `src/worker/cache.ts` still imports the barrel, and `cache.ts` runs on the main thread.** This
is legal — `cache.ts` is in `worker` — but the rule is phrased per layer, so it cannot see that `worker`
has a main-thread half. `client.ts`, `protocol.ts` and `response.ts` were moved onto the specific modules
in this change; `cache.ts` cannot be, because it needs `TITLE_LENGTH`, which lives in `library.ts`.
Nothing reaches it today: the shipped bundle contains no `DOMAIN_TAG`, `sha256`, `feistel` or `getPage`,
because `src/main.ts` imports only `@engine/viewer` and neither `app/url.ts` nor the worker client is in
the entry graph yet. The moment M6 wires `ui` to `@worker/client`, the barrel and `@noble/hashes` land in
the main-thread bundle.

The fix is the move this record already makes for `FORMAT_VERSION`: `TITLE_LENGTH` is a constant naming
the format (SPEC §5), not generation, and belongs beside it — with one wrinkle `FORMAT_VERSION` did not
have, in that `library.ts` derives `TITLE_SHIFT` from it and the move has to decide whether the
derivation follows. It is left out because it is a second decision about a second constant and this
record is already redrawing the central invariant.

**And nothing mechanical will notice when M6 arrives.** The bundle claim above is a hand measurement
with no guard behind it: `src/__tests__` holds three meta-tests and none of them asserts anything about
what the built bundle contains, and the lint rule cannot help, because it is phrased per layer and
`worker` has a main-thread half. So the detector is a person reading this paragraph. That is the same
shape as ADR-0028's open question about test durations, and it wants an issue of its own rather than a
sentence here.

**Consequence.** `architecture.md` §1's claim about itself is true again, and it is true of eight blocks
rather than five, under two rules rather than one. `src/app/url.ts` imports `@core/address`,
`@core/errors` and `@core/format` instead of the barrel, and `src/worker/client.ts`, `protocol.ts` and
`response.ts` name the modules they use for the same reason. Each case is asserted in both directions in
`layer-boundaries.test.ts`, which grew from 20 tests to 100, and each rule was watched failing by deleting
it from the config and running the file — the standard the roadmap sets for M0, applied to the rules that
enforce the architecture itself. `.gitignore` gains the throwaway path that file writes, because its
`afterAll` is the only thing that removes it and that does not run when a run is killed.

---

## ADR-0030 — An interrupted flight retargets the playhead; the timeline is never rebuilt under it

**Decision.** Interruption is settled by four rules, and the fourth is the only one that is not a
restatement of the first three:

1. **The machine commits on the event; the rig is a projection that lags behind it.** There is no
   "in flight" navigation state. The instant an event is accepted the FSM is at the new level, and
   the camera is somewhere on its way there.
2. **The rig is moved only by the master timeline**, whose legs are `fromTo` tweens with both ends
   written out. The rig is therefore a pure function of the playhead: seek to a time and the rig is
   that time's values, in any order, any number of times.
3. **An interruption kills the playhead tween and starts another towards the new label.** It never
   kills a leg, never recaptures a leg's start values, and never rebuilds the timeline under a
   moving playhead.
4. **When the route asked for disagrees with the route built, the flight first takes the playhead
   back to the last stop the two still share**, and only then replaces what hangs below it. Both
   phases are the same mechanism — a playhead tween to a label — so there is no second code path to
   get wrong.

**Why.**

**Where the machine commits.** The alternative is committing on arrival, and it makes the FSM lie
for the whole duration of every flight. The URL (M8) and the overlays (M6) are projections of it
(architecture §4), so a second event arriving mid-flight would be read against a level the user has
already left, and a link copied during a flight would name the wrong book. Putting the flight into
the machine instead — `room`, `flying-to-wall`, `wall`, and so on — doubles a table whose totality
is the point of architecture §4, and half of the new states are not places anyone can be.

**Why the legs are `fromTo` and not `to`.** A `to` tween records its start values the first time it
renders, so what such a timeline _means_ depends on when it was first played and on where the rig
happened to be at that moment. Interrupt it and those recorded values are no longer the level above,
so playing it backwards lands somewhere that is not a level at all — and nothing in the code would
report it, because a tween always arrives at something. With both ends written out, a leg is the
same function of the playhead forever, which is what lets a test assert the rig against the
timeline at **every frame** of an interruption rather than only at the end of one.

**Why the playhead is what gets killed.** A playhead tween holds nothing but a destination; a leg
holds the geometry of the route. ADR-0004 requires that going back be the same timeline rather than
a second animation kept in step with the first, so the legs are retained and only the scrub is
replaced. That is also the answer to the obvious objection that this is not literally `.reverse()`:
gsap's `reverse()` has exactly one destination, the start of the timeline, and the ladder has four
levels. Going back one level from a book has to stop at the shelf, so the playhead is tweened to the
label above — the same timeline, the same legs, played backwards, with no second animation in
existence to disagree with.

**Why a retreat rather than a rebuild in place.** A leg may only be replaced while the playhead is
above it. Rebuilding the leg the playhead is standing in would mean capturing a start value at an
arbitrary point of a movement, which is the `to()` problem above with extra steps: the leg would
claim to begin at a level it does not begin at, and could no longer be reversed to one. A retreat
costs the user a movement they did ask for — they went back, and then chose somewhere else — and
never a movement they did not.

**What consistency means here, precisely.** At every instant: the FSM names a level, the playhead is
somewhere on the built route, and the rig is the timeline evaluated at the playhead. The FSM and the
rig may disagree about **where the camera is**, because that disagreement is what an animation is.
They may not disagree about **where it is going**.

That is also what makes `waitForIdle()` answerable at all, and the reasoning is worth writing out
because the obvious implementation is subtly wrong. A label is a level's **name**, so the route the
flight is on and a route it has just been asked for can both carry a `wall` stop at the same time on
the timeline and mean different walls; "the playhead is at the wanted label" is therefore not by
itself a statement about where the camera is. What rescues it is the rule above: a retarget whose
route disagrees at or above its target either starts a retreat or replaces the legs below the stop
the playhead is standing at, and either way it ends by aiming the playhead at a time strictly away
from where it is. **A superseded label is never a resting place**, so "no tween is running and the
playhead is at the wanted label" is sound — and the case that would otherwise have reported a false
arrival, being asked for another shelf while standing at one, is a named test.

This was not obvious in the writing. The flight carried a second check — that the built route still
agreed with the wanted one down to the target — until the mutation pass showed that no mutation
could make it fire: every route that disagrees leaves a tween running, and after `dispose()` the
check made `whenSettled()` hang on a flight that would never move again. A guard that cannot fail
is this project's recurring defect in miniature, so it is gone and the invariant that replaces it is
stated here and in the code.

**Alternatives rejected.**

- _Complete the interrupted flight instantly (`progress(1)`) and start the new one from there._ Every
  start value stays honest and the camera snaps by up to a whole level on every interruption. A
  camera system may have many faults; teleporting while the reader is watching is not one it can
  afford.
- _Kill the running legs and build a fresh timeline from the rig's current values._ This is
  ADR-0004's second hand-written animation wearing the first one's name. The new timeline's origin
  is wherever the camera was interrupted, so going back no longer returns to a level, and nothing
  fails — it simply stops being a ladder.
- _An "in flight" state in the machine, with the camera as the source of truth for arrival._ Doubles
  the transition table and inverts architecture §4: the projection would be telling the source of
  truth where the user is.
- _Queue the interrupting event until the current flight finishes._ The camera then keeps flying
  towards a level the user has already left, and the queue becomes a second record of where the user
  is going, which is the thing architecture §4 exists to forbid.
- _A timeline per pair of levels, played in sequence._ Each pair is then an animation to keep in step
  with its own reverse, and a descent of three levels is three eases with two standstills in the
  middle of it. That is three flights that happen to touch, not the one continuous flight the
  milestone asks for.

**Consequence.**

- `prefers-reduced-motion` (M10) is `timeline.seek(label)` in place of the playhead tween: the same
  timeline and no second code path, because the rig is a function of the playhead and of nothing
  else.
- A retreat is visible: backing out of a book and choosing another shelf flies up to the wall before
  it flies down again. That movement is the price of never snapping, and it is the user's own route
  played out rather than a path invented for them.
- **A rebuilt flight does not stall at the level the two routes share**, which was worth measuring
  rather than assuming. The retreat's arrival is reported by gsap inside a render, and the retarget
  is computed in that same render, so the playhead is moving again on the very next frame: over 120
  frames of a retreat-and-descend, **no two consecutive frames left the playhead at the same time**,
  and the frames either side of the shared level are symmetric to six decimal places. The retreat's
  ease out and the descent's ease in meet there, so the camera reads as changing direction rather
  than as stopping. `__tests__/flight.test.ts` holds it.
- Something has to own gsap's clock. A playhead tween is advanced by gsap's root timeline, and the
  root is advanced from the one `setAnimationLoop` through `src/motion/clock.ts`, which takes the
  root off gsap's own ticker. That is what keeps architecture §2's single loop true with gsap
  installed, and it is also why no test in `src/motion` waits on a wall clock.

---

## ADR-0031 — A mutant that breaks a module body is killed by a test that imports it from inside

**Decision.** `src/core/__tests__/module-load.test.ts` imports nothing from `core` at the top and
evaluates each module body inside a test, asserting what that body builds. The eight mutants issue
#6 is about are killed by it. `scripts/check-mutation-report.ts` then refuses any report whose
survivors ran fewer tests than their run plan named, so the class of false survival this record is
about cannot be reported as a pass again. `ignoreStatic` stays off (ADR-0023), `coverageAnalysis`
stays `perTest`, the planner is untouched, and no mutant leaves the scored set.

**Two corrections first, because issue #6 names a mechanism the measurement refutes.**

The issue says the mutant "never takes effect": that the Vitest runner assigns `ns.activeMutant` at
the setup file's module-load time, by which point the mutated modules are already instantiated and
cached, so every test passes and Stryker records `Survived`. If that were what happened, the mutant
run would report a full green suite of 250 tests.

It is the reverse. Static activation works exactly as intended. `mutant-test-planner.js` plans these
mutants with `testFilter: undefined` — `globalTestFilter` is undefined unless the `testFiles` option
is set, and this project does not set it — so `mutantActivation` is `'static'` and
`stryker-setup.js` assigns `ns.activeMutant` while the setup file loads, before any test module is
imported. The mutant is live while `core` is being imported and it does precisely what it says: each
of these eight makes a module body throw. The report even says so, in a field nobody was reading.
Of the 250 tests their run plan named, `alphabet.ts`'s four completed **1**, `prf.ts`'s two **104**
and `address.ts`'s two **53**.

The second correction: `break: 75` and `low: 85`, the thresholds the issue reasons about, are gone
(ADR-0018), and `feistel.ts:35`, the fifth mutant it names, is killed in all thirteen nightly runs
of `ff005f10` and in every one of the thirteen runs taken below. `addMod` is reached at runtime by the whole bijection
suite, so mutating it fails 62 tests rather than breaking an import; it was a false survivor only
while the dry run had no timeout anyone chose (ADR-0012's "third budget").

**What the suite does with each of them.** Each mutation applied to the file by hand, then
`vitest run --config vitest.stryker.config.ts` on `08d7700` — the same suite and the same
environment Stryker runs it in:

| mutant                                               | verdict      | what the suite does                        |
| ---------------------------------------------------- | ------------ | ------------------------------------------ |
| `alphabet.ts:48` `i <= symbols.length`               | **killed**   | 9 of 10 files fail to collect, 1 test runs |
| `alphabet.ts:48` `i--`                               | **killed**   | 9 of 10 files fail to collect, 1 test runs |
| `alphabet.ts:50` `if (true)`                         | **killed**   | 9 of 10 files fail to collect, 1 test runs |
| `alphabet.ts:50` `symbol !== undefined`              | **killed**   | 9 of 10 files fail to collect, 1 test runs |
| `prf.ts:98` `if (true)`                              | **killed**   | 5 files fail to collect, 104 tests run     |
| `prf.ts:98` `code <= 0x7f`                           | **killed**   | 5 files fail to collect, 104 tests run     |
| `address.ts:25` `BOOKS_PER_SHELF / PAGES_PER_BOOK`   | **killed**   | 7 files fail to collect, 53 tests run      |
| `address.ts:25` `SHELVES_PER_WALL / BOOKS_PER_SHELF` | **killed**   | 7 files fail to collect, 53 tests run      |
| `address.ts:30` `BigInt(PAGES_PER_ROOM) + 1n`        | **survives** | the whole suite passes                     |

Every killed row has **zero failing tests**. The suite is red on failing _files_, and a failing file
is not what Stryker reads.

**Why the report cannot see it.** `vitest-test-runner.js` builds its result from leaf test tasks
that carry a result:

```js
const tests = this.ctx.state
  .getFiles()
  .flatMap((file) => collectTestsFromSuite(file))
  .filter((test) => test.result);
let failure = false;
const testResults = tests.map((test) => {
  /* ... */ failure ||= testResult.status === TestStatus.Failed;
});
if (!failure && this.ctx.state.errorsSet.size > 0) {
  return { status: DryRunStatus.Error /* ... */ };
}
return { tests: testResults, status: DryRunStatus.Complete };
```

A test file whose import throws registers **no tasks at all**, so it contributes no failing test,
and a file's own `result` is never read; `collectTestsFromSuite` returns `task.type === 'test'` and
nothing else. Vitest keeps a collection error on the file task, while `errorsSet` carries unhandled,
teardown, source and reporter errors, so that escape hatch does not fire either. The runner returns
`Complete` with an empty, failure-free test list, and Stryker's rule — a mutant survived when no test
failed — then reads a red suite as a survival.

**The check that makes it unrepeatable.** A survivor is a claim that a mutant ran its tests and none
of them minded, so the test count is part of the claim: a static mutant is planned with no test
filter and runs every test in the dry run, and any other mutant runs the tests that cover it. A
survivor that completed fewer than that did not survive anything. `scripts/check-mutation-report.ts`
asserts exactly that over the `json` report and fails the run on a shortfall. Over the ten reports
it has been run on — the six taken on the laptop below, and the five `ubuntu-latest` runs of this
branch, where the job runs it itself — it names the eight in each of the three reports taken from
`main` and nothing in the other eight: 288 survivor observations, and every survivor other than
those eight, static and runtime alike, completed its planned count to the test. It is the same shape as
`scripts/check-mutation-harness.sh` asserting the dry run's test count, and for the same reason: a
truncated run that reads as a pass is the failure this repository keeps finding (ADR-0014).

**The fix.** A test file that imports nothing from `core` still collects when a `core` module body
throws, and a dynamic `import()` inside a test body runs that body where a throw is a _failing test_.
One test imports the barrel, so it covers every module including ones added after this record; the
rest assert the values the bodies build, so each test fails for the right reason rather than merely
observing that an import resolved. The constants are asserted in `address.test.ts`, `prf.test.ts` and
`alphabet.test.ts` too, and that duplication is the point: there the subject is the value, here it is
the import.

This is not a trick to satisfy the tool. A module that throws while being imported takes the
application down at startup, and until now the only observer of that was a test file that dies with
it. `core`'s own tests are inside the layer, so importing the barrel here is not the boundary
ADR-0029 is about.

**The measurement.** Eight full runs on `ubuntu-latest` through `workflow_dispatch` — three on
`main` at `08d7700` and five on this branch, four of them launched inside two minutes of the `main`
three so that neither side could draw the better half of the runner pool, and the fifth on the
branch's final commit, whose only difference from the other four is documentation — and six more on
one developer machine, which was running two other agents' suites throughout, so its
durations are noise and only its verdicts are evidence.

| machine            | tree             | runs  | score               | survivors    | truncated | duration                           |
| ------------------ | ---------------- | ----- | ------------------- | ------------ | --------- | ---------------------------------- |
| `ubuntu-latest`    | `main` `08d7700` | **3** | **94.75** every run | 32, same set | **8**     | 6m52s, 7m01s, 7m03s                |
| `ubuntu-latest`    | this branch      | **5** | **96.07** every run | 24, same set | **0**     | 6m17s, 7m03s, 7m31s, 8m00s, 10m22s |
| 10-core `Mac16,13` | `main` `08d7700` | **3** | **94.75** every run | 32, same set | **8**     | 4m31s, 5m04s, 5m28s                |
| 10-core `Mac16,13` | this branch      | **3** | **96.07** every run | 24, same set | **0**     | 5m33s, 6m48s, 6m20s                |

The 24 are the 32 less exactly the eight, paired on mutant position, mutator and replacement: no
mutant that was killed before survives now, in any of the fourteen runs. Eight survivors at ADR-0018's
0.164 points each is 1.31, which is the whole of 94.75 to 96.07 to the second decimal.

**On reproducibility, which is the part worth being careful about.** Fourteen runs returned one score
per tree, and that is not the same as saying the score is stable: it says these fourteen runs were
taken within an hour of each other, and ADR-0018's answered question has thirteen nightly runs of
`ff005f10` spanning 94.75 to 95.57. The five positions that flap there — `bignum.ts:56` twice,
`bignum.ts:115`, `bignum.ts:116` and `address.ts:30` — are survivors in all eight runs on
`ubuntu-latest` here and in all six on the laptop, so a slower runner can still time one out and print 96.23 instead of 96.07. **What this change
removes is not that noise.** It removes eight survivors that were never real, and it leaves the
report able to say which kind of run it had: the residual spread is `Killed` against `Timeout`, a kill
either way, while the eight were a red suite printed as a pass.

**Duration is unchanged, and the spread is the runner.** The fourth branch run took 10m22s on a
runner whose dry run cost 21.7 s net against 15.0 to 17.3 s for the other four — the same work on a
machine 1.3x slower, which is ADR-0013's whole point — and the four comparable branch runs span
6m17s to 8m00s against `main`'s 6m52s to 7m03s. The six new tests cost the dry run about 3 to 5 s on
`ubuntu-latest` (256 tests at net 15.0 to 17.3 s, against 250 at 11.3 to 11.9 s) and about 0.3 s on
the laptop, because each one re-evaluates the module graph under mutant switching. They are paid back
where the eight mutants used to run all 250 tests to the end and now fail on the first one: their
`testsCompleted` is 1.

**Alternatives rejected.**

- _`ignoreStatic: true`._ Measured in ADR-0023: it clears these by running the hybrid ones on their
  covering tests, and pays 93 mutants moved to `Ignored`, 90 of which this suite kills. The test file
  gets the same kills and keeps all 610 mutants scored, so that trade does not have to be made.
- _`coverageAnalysis: "off"`._ What issue #6's last comment proposed trying first. It is worse in
  both directions: with no coverage map every mutant takes the planner's last branch, so every mutant
  gets static activation and the whole suite — the eight survive by exactly the same mechanism, and
  the other 602 cost 256 tests each instead of about 7.
- _Patching `mutant-test-planner.js` or the Vitest runner locally._ The blind spot is one
  `tests.length === 0` check away from being reported and that belongs upstream; a local patch would
  make this project's score incomparable with its own history (ADR-0023).
- _Making the module bodies lazy._ Bending the construction of the format (ADR-0001) to suit the
  measuring apparatus, in order to work around a reporting bug in the apparatus.
- _Asserting the constants in the existing test files._ They already do. Their imports are at the
  top, which is exactly what makes them unable to report this.

**`address.ts:30` is a genuinely equivalent mutant, and stays measured.** `ROOM_COUNT` is
`(LIBRARY_SIZE + BigInt(PAGES_PER_ROOM) - 1n) / BigInt(PAGES_PER_ROOM)`, and `+ 1n` for `- 1n`
changes the quotient only when `LIBRARY_SIZE mod PAGES_PER_ROOM` is `0` or `PAGES_PER_ROOM - 1`. It
is 261376 of 262400, so the two expressions are the same number for this library and no test can
tell them apart (testing.md §4). It is left in the scored set rather than excluded with a
`// Stryker disable`, because that comment is per line and per mutator and would take the two killed
`ArithmeticOperator` mutants on the same line with it. It is also one of the five positions whose verdict flaps between
nightly runs (ADR-0018's answered question), and the only one of those whose other verdict can only
have been a timeout, since nothing can kill it.

**Consequence.** The survivor list is a list of claims again: every remaining survivor ran every
test it was planned to run, and the one equivalent mutant among them is named here with its
arithmetic. The score rises 1.31 points for the same tests, because eight kills stopped being
reported as gaps — which is the opposite direction from `ignoreStatic`, where the score rose by
measuring 15% less.

Two things are left open rather than settled. `break: 92` now tolerates 25 extra survivors against a
measured spread of five, where ADR-0018 chose about four spreads of margin; the figures for
tightening it to 93 are in that record's answered question, and it is not done here because a gate
recalibrated on the run that moved its floor is the ADR-0013 mistake. And the upstream report — that
a Vitest run in which no test ran at all is reported as a survival — is written down for a Stryker
issue and acted on from the test side only.

---

## ADR-0031 — A page turn is ADR-0030's interruption model, with the DOM in the place of the rig

**Decision.** Page turning reuses ADR-0030 rather than answering interruption a second time. The
correspondence is written out here because it is not quite term for term, and the one rule of
ADR-0030 that has nothing to do in a reader is named rather than left to be noticed:

| ADR-0030, the camera                                  | M6, the reader                                      |
| ----------------------------------------------------- | --------------------------------------------------- |
| The machine commits on the event                      | The machine commits on the event                    |
| The rig is a pure function of the playhead            | The DOM is a pure function of the machine's address |
| An interruption kills the playhead tween, never a leg | An interruption cancels the request, never a write  |
| A route disagreement retreats to the last shared stop | Nothing to retreat from: a turn has no stops        |

1. **The machine commits on the event.** The instant a turn is accepted the FSM is at the new page
   and `addressOf` names it. There is no "turning" state, for the reason ADR-0030 gives for there
   being no "flying" state: the overlays and the URL are projections of the machine
   (`architecture.md` §4), so a second event arriving mid-turn would be read against a page the
   user has already left.
2. **The view is written only while the machine has that page open.** That single line in
   `src/ui/reader.ts` is what makes an interrupted turn safe, and it is ADR-0030's second rule with
   the DOM in the place of the rig: the 80 line elements are a function of the machine's address
   and of nothing else — not of which reply arrived first, not of whether a page was cached.
3. **An interruption cancels the request in flight and issues another.** It never writes part of a
   page and never writes a reply the machine has moved past. `GenerationRequest.cancel()` is what
   stops the worker computing a page nobody is waiting for (ADR-0016), and the rule above is what
   makes the reply that was already in flight a non-event.

**Why rule 4 is vacuous here, and why that is not a loosening.** A flight's route is a path through
rig space with the levels standing on it, so two routes that disagree have a last point in common,
and the playhead has to come back to it before what hangs below can be replaced — that is ADR-0030's
retreat. A page turn has no such path. There are two pages in the question, the one on screen and
the one asked for, and the thing that would be "rebuilt under a moving playhead" is a single write
of 80 line elements, which either happens or does not. The last stop the old and the new turn still
agree on is the page already on screen, and the reader is standing exactly there: it keeps showing
it until the new page has arrived whole. So the retreat has nothing to do, rather than being skipped.

**Why the turn is not a timeline.** It could be. A page could slide across the panel, and then the
lag would be a movement, the playhead would be the thing interrupted, and ADR-0030 would apply
literally and without a word of this record. It is not a timeline because the lag in a page turn is
not a movement but a generation: 1.0 to 2.3 ms of worker time on the four machines of ADR-0005, with
nothing to interpolate between the old page and the new one. `@ui` may not import `gsap` either
(`architecture.md` §1, ADR-0004), so an animated turn is a `@motion` timeline driven from `@app` —
which is where it goes if M10 adds one, and this record does not change when it does.

**Why the event names a page and not a direction.** Every other event in the table names where to go
(`select-wall`, `select-shelf`, `select-volume`), and a `turn-page` carrying a delta would be the one
that does not. It also moves the arithmetic into the machine: the component `core` validates would be
one the caller never saw, so a refusal would name a page nobody asked for. The reader computes
`page + 1` from `addressOf` and the machine refuses it or does not, which is the same shape as a
click on a spine.

**What consistency means here, precisely.** At every instant: the machine names a page, the reader
shows a page it has received whole, and `aria-busy` on the page element says whether those two are
the same. The machine and the view may disagree about **which page is on screen**, because that
disagreement is what a generation is. They may not disagree about **which page is being opened**.

**The superseded reply is not a hypothetical.** It is the ordinary case of turning back and forth: a
page the client has already cached resolves inside the same task as the turn that asked for it
(`cache.ts` is read before the boundary, ADR-0005), so two turns dispatched together produce two
replies that land in the order the user did not ask for, and cancellation cannot help — a resolved
promise has nothing left to cancel. `e2e/reader.spec.ts` holds both cases: a turn interrupted while
the worker is still generating, and a turn superseded by a cache hit in its own task.

**Alternatives rejected.**

- _Queue the turns and apply them one at a time._ The reader then keeps opening pages the user has
  already left, and the queue becomes a second record of where the user is going, which is what
  `architecture.md` §4 exists to forbid. ADR-0030 rejected the same thing for the camera.
- _Blank the page while a turn is in flight._ Every turn flickers, and an interrupted turn leaves an
  empty reader. `aria-busy` and the status line report the same fact without taking the text away.
- _Write the lines as they arrive._ There is nothing to stream: a page is one `getPage` and arrives
  whole. A partially written page is 3200 characters that exist at no address, which is this
  project's definition of the wrong kind of wrong.
- _Render the page to a canvas and animate that._ The milestone is that the text is real DOM text,
  selectable and readable by a screen reader (SPEC §8). A texture is the thing being replaced.

**Consequence.**

- `waitForIdle()` grows from the camera to four sources: the flight, the worker client's request
  table, the reader, and the title resolver (`docs/testing.md` §7). The composition is
  `src/app/idle.ts`, and the property that needed a test is that one pass over the sources is not
  an answer — a page arriving leaves the client quiet and the reader writing.
- The same rule serves the spine titles: a shelf of titles that arrives for a shelf the machine has
  left changes nothing. Neither the reader nor the title resolver inspects an error class to tell a
  cancellation from a failure, because the question "is this still what the machine is asking for"
  answers both.
- A turn whose page genuinely fails to generate leaves the last page on screen and says so in the
  status line. That branch is not reachable from the interface in M6 — every address the machine
  produces is valid and the worker answers every message exactly once — so it carries no test, and
  that is stated here rather than implied by its absence.
