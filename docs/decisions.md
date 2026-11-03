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
The thresholds and the scope below are unaffected.

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
The budget's figure was later recalibrated for an unrelated reason (ADR-0013), which does not
disturb the argument above: it never rested on what the number was.

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
