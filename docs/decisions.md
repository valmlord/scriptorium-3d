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
