# Testing strategy

A library with no database has no way to notice that it is wrong. There is no user complaining that a
record is missing — a broken bijection simply returns different plausible gibberish, forever. Tests are the
only thing standing between "the library works" and "the library confidently lies". They are written
accordingly.

**Every pull request adds tests. A PR that only adds code is not finished.**

---

## 1. What gets tested where

| Layer        | How it is tested                                                                                                                     | Why that way                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `core`       | Vitest unit + **fast-check property tests** + committed golden vectors + mutation testing                                            | Pure, deterministic, no I/O. There is no excuse for anything less than complete coverage here.               |
| `worker`     | Unit tests on the protocol handler as a pure function; integration test through a real `Worker`                                      | The handler is where the bugs are; the thread is where the flakes are. Test them separately.                 |
| `state`      | Exhaustive transition table test — every `(state, event)` pair asserted, legal or rejected                                           | An FSM is a finite object, so "we tested the paths we thought of" is a choice, not a limitation.             |
| `motion`     | Timelines advanced by the same clock the render loop drives, in explicit steps, asserting rig values at labels                       | Numbers only, no WebGL (ADR-0004). If a timeline needs a canvas to be tested, it is in the wrong layer.      |
| `engine`     | Pure layout maths (shelf positions, instance matrices, address↔`instanceId`) tested directly; the renderer itself is not unit-tested | Asserting on a GPU is a losing game. Extract the arithmetic, keep the renderer thin enough to review by eye. |
| `ui` / `app` | Playwright end-to-end against the built site; the parts of `app` that touch no browser global are unit-tested directly               | The only place where "the user typed a phrase and arrived at the book" is actually a true statement.         |

## 2. Property tests over examples

Anything reversible gets a property test, not a handful of cases:

```
∀ address ∈ domain            locate(getPage(address)) === address
∀ page   ∈ valid pages        getPage(locate(page)) === page
∀ text, offset, mode          getPage(search(text, mode, offset).address)
                                .slice(offset, offset + text.length) === text
∀ address                     getPage(address).length === 3200
∀ address                     every character of getPage(address) is in the alphabet
```

Generators must reach the edges deliberately: room `0`, the last legal room, the last legal address in the
partially-filled final room, the first invalid one, `page` 0 and 409, and pages consisting entirely of the
index-0 symbol (leading zeros are where fixed-length radix conversion breaks).

Run with at least 1000 cases in CI. When fast-check finds a counterexample, the shrunk case is added as a
named regression test — the property stays, the specific failure gets a permanent name.

## 3. Golden vectors

`src/core/__fixtures__/golden-vectors.json`: a set of `(address, sha256-of-page, first 64 characters)`
entries covering ordinary and edge addresses, plus the `search` results for a few known phrases.

These are a **compatibility contract** (ADR-0003). A red golden test means the format changed and every
link ever shared now points at different text. It is never fixed by regenerating the fixture. The
regeneration script exists, is named `scripts/regenerate-golden-vectors.ts`, and prints a warning saying
exactly this before it writes.

## 4. Mutation testing on `core`

Coverage says a line ran. It does not say an assertion would have noticed it being wrong — and for this
codebase that gap is the whole risk. Stryker runs against `src/core` only:

- `npm run test:mutation`, configured in `stryker.config.json`.
- Thresholds: **`high` 93, `low` 92, `break` 92**, calibrated on the measured run-to-run spread
  rather than chosen as round numbers (ADR-0018). `break` is the only one that decides the exit
  code. The floor is **96.07** since ADR-0031, so `break` now tolerates 25 survivors more than the
  floor rather than ADR-0018's eleven; whether to tighten it to 93 is the open question at the end
  of that record.
- **Nightly on `main`, and on demand** via `workflow_dispatch` — not on pushes or pull requests.
  ADR-0014 took it off that path when a run cost 21 to 70 minutes. It is now **6m17s to 15m04s on
  `ubuntu-latest`** over twenty-one runs under 9.6.1 — thirteen nightly ones at 9m59s to 15m04s and
  eight `workflow_dispatch` ones at 6m17s to 10m22s (ADR-0031) — so the reason it left that path has
  gone. Whether to put a seven-to-fifteen-minute job back on every pull request is still ADR-0014's
  question; what has changed is that it is no longer being argued from one developer machine.
- The pull request path runs `npm run test:mutation:dry` instead: Stryker's dry run, a 34-second job
  that adds nothing to the critical path, which answers the one question a pull request can answer
  cheaply — does the harness still start, instrument and get a green suite? It asserts the test
  count as well as the exit code, because a broken dry run was observed reporting success on 43 of
  229 tests.

If a surviving mutant turns out to be genuinely equivalent, it is excluded with a comment explaining
why. Silently lowering the threshold is not an option. One survivor is equivalent and deliberately
_not_ excluded: `address.ts:30`, where `+ 1n` for `- 1n` in the room-count ceiling cannot change the
quotient for this library. `// Stryker disable` is per line and per mutator, so excluding it would
take two killed mutants with it; the arithmetic is written out in ADR-0031 instead.

**The score moves by a few survivors between runs, and a named survivor is a claim.** Thirteen
nightly runs of the identical commit `ff005f10` scored 94.75 to 95.57 on `ubuntu-latest`, which is
27 to 32 survivors, in 9m59s to 15m04s. Eight full runs of `6786120` spanned 0.49 points before
that (ADR-0018). The score is a pure function of the survivor count, so the whole spread is a
handful of mutants whose verdict flips between `Killed`, `Timeout` and `Survived` — and the flipping
is one-sided in the direction that matters: it adds survivors, it does not remove one.

An earlier version of this section reported a five-point swing and called the verdict
irreproducible. It was wrong: the swing was caused by `d2aa600` raising `testTimeout` from 5 s to
30 s, and a timing-out test is a failing test that kills its mutant for the wrong reason. The
correction, with the mechanism, is at the end of ADR-0014. The scores before that commit were
inflated; `~93` was the honest number for the suite as it then stood, and the suite has gained tests
since. ADR-0031 has the current figures.

Before acting on a named survivor, apply the mutation to the file by hand and run the suite. There
are two reasons, and the first is that the report can be wrong. A mutant that makes a module _body_
throw takes down every test file that imports it; a file that fails to collect contributes no
failing test, only a failing file; and Stryker decides a mutant survived when no test failed. So it
reads an empty result set and calls the mutant a survivor. Eight mutants were reported that way in
every one of those thirteen runs, and the suite kills all eight (ADR-0031, issue #6). The second
reason is the case count: property tests run at 10 cases under Stryker and 1000 everywhere else
(ADR-0012), so a survivor may be one that 1000 cases would have killed.

The first of those is now checked rather than remembered. `npm run test:mutation` runs
`scripts/check-mutation-report.ts` afterwards, and it fails the run when a survivor completed fewer
tests than its run plan named — a static mutant runs the whole suite, any other mutant runs the
tests that cover it, and a shortfall means the files that would have failed never collected. A
survivor that passes that check ran everything it was asked to run, which is what makes it a claim
worth acting on.

`src/core` yields close to 600 mutants, so the property tests are capped at 10 cases under Stryker
alone (`src/core/__tests__/property-runs.ts`, ADR-0012). Fewer cases can only let a mutant _survive_
that more would have killed, so the reported score is a floor rather than an inflation; every other
run uses the full 1000.

The cap was introduced when Stryker re-ran the whole suite against every mutant. It no longer does:
since ADR-0017 each mutant runs against its own covering tests, about seven of the 239 the Stryker
configuration collects. Whether the cap is still worth its cost is therefore an open question and
not a settled one — it has not been re-measured since the upgrade.

The cap is applied per `fc.assert`, not through `fc.configureGlobal({ numRuns })`: fast-check lets an
explicit `numRuns` override the global one, and every property test here passes one, so a global cap
would enforce nothing.

## 5. Performance is a test, not a feeling

`vitest bench` reports the numbers for humans (`src/core/__tests__/*.bench.ts`), and the budget is
asserted against a committed baseline:

- `getPage` on a cold cache: fails the build above **25 ms**.
- `locate`: fails above **25 ms**.

The budget is calibrated on the slowest machine that enforces it. Measured medians of 15 samples for
`getPage`: development laptop 0.53–0.80 ms, reference machine 1.34 ms (SPEC §4.4), `ubuntu-latest`
~5.05 ms. An earlier 5 ms budget was set from the reference figure alone; it failed on its first CI
run at 5.052 ms and passed on the next, because the threshold sat on the runner's own value and the
gate decided by luck. 25 ms is five times the slowest observation.

The margin does not weaken the gate: it exists to catch an accidental `O(n²)` radix conversion or a
round function that re-hashes the whole page, and those are orders of magnitude, not percent.

**The assertion does not live in the `.bench.ts` file.** `vitest run` does not collect `.bench.ts` files
and `vitest bench` does not run `it` tasks, so an `expect` written beside a `bench` executes in neither
mode and guarantees nothing. The budget is asserted in `src/core/__tests__/performance.test.ts`, which
`npm run test` does run — and it is measured as a median of several samples, so one scheduler hiccup on
a shared runner cannot fail the build while a genuine complexity regression, which moves every sample,
still does.

The budget is not asserted under `npm run coverage` or `npm run test:mutation`: the same call measures
~0.7 ms plain, ~6 ms under v8 coverage and ~8 ms under Stryker, so timing those runs would be measuring
the instrumentation (ADR-0012). CI's `verify` job runs uninstrumented, so the threshold is enforced on
every push and every pull request.

**What a page, a title and a shelf of 32 titles actually cost is reported, not asserted.**
`npm run bench:report` runs the `.bench.ts` tasks, takes a median of a fixed sample count for each —
fixed in the bench file, so it does not vary with how fast the machine is — and renders them as a
table with the runner's CPU model, core count and Node version beside them. The `generation-cost` job
publishes that table to the run summary, where GitHub shows it on the run's own page: a figure nobody
can find without opening a log is a figure nobody will find, and one that names no machine is not
evidence at all (ADR-0013). **No figure that job reports can fail the build, however slow; a
measurement it cannot take does fail it.** Both halves are deliberate. The run-to-run spread of those
medians is the runner's own drift between runs and does not shrink as the sample count grows, so a
threshold built on them would decide by luck rather than by the code — which is the whole of what
ADR-0013 took out of the budget above. The budget above is the only gate.

The figures the worker decision rests on, each with the machine it was taken on, are recorded in
ADR-0005.

**The `~5.05 ms` above does not reproduce on today's runners, and the budget has not been moved for
it.** The `generation-cost` job measures `getPage` on `ubuntu-latest` at 1.01 to 1.35 ms warm, and
1.83 to 2.99 ms on this section's own apparatus — an unwarmed median — over three runs that landed
on two different CPU models, because `ubuntu-latest` is a label and not a machine. So 25 ms is now
about eight times the slowest of those observations rather than five. Whether that means the budget
should come down is a question about what the budget is for and not about the measurement, and it is
open: see issue #17. Nothing here changes it, and ADR-0013's reasoning is untouched — a figure that
has stopped reproducing is still the figure that decision was taken on.

Frame budget is asserted in Playwright instead: during a scripted camera flight, no frame exceeds 32 ms and
no more than 1% of frames exceed 20 ms, measured through the debug hook.

## 6. End-to-end

Playwright, Chromium plus WebKit, against built output — never against the dev server.

**The build the suite runs against is a test build**, `npm run build:e2e`, which is the production
pipeline in test mode. The one difference is the branch in `src/main.ts` that installs
`window.__scriptorium`: §7 puts the hook in development and test builds only, and without it every
scenario below would be back to sleeping on a duration. `npm run test:e2e` builds it itself, so a
local run and the CI job cannot differ and neither can serve a bundle left over from an earlier
build. What the **production** bundle contains is a question no browser running the test build can
answer, so it is asserted where it can be — `src/__tests__/production-bundle.test.ts` builds both
and compares them, and `npm run build` is still built by the `verify` job.

Mandatory scenarios, each one owned by the milestone that introduces it:

1. The app boots, the canvas has a WebGL context, and the console produces no errors or warnings.
2. A deep link opens the exact address it names, in the language it names.
3. Typing a phrase in search flies to a book, and the reader contains that phrase at the stated offset.
4. A query containing characters outside the alphabet is refused, naming them — it does not silently
   substitute or strip.
5. Browser back and forward return to the previous address, and the camera agrees with the URL.
6. `prefers-reduced-motion: reduce` replaces flights with cuts, and every level stays reachable.
7. Keyboard-only navigation reaches a page of text without a mouse.
8. Axe reports no serious or critical violations on the reader and the search panel.
9. A volume chosen with the pointer is flown to, through every level between, and `Escape` flies
   back up the same way. The pointer tells a volume from the fabric of the room before it is
   clicked, and the room's own vantage is where the way back ends.
10. The reader shows the 3200 characters the library holds at that address, as selectable text; a
    title on screen is `getTitle` of that volume; a page turn interrupted mid-flight leaves the FSM
    and the view agreeing, and the superseded page is never shown; and the 640 spines are still one
    instanced draw call once a shelf has acquired its titles. The expected text is computed by
    `core` inside the spec, so these assert the bijection rather than the reader agreeing with
    itself.

**No pixel-diff screenshots of the WebGL canvas.** GPU and driver differences make them flake, and a flaky
test trains everyone to ignore red. Assert on the scene's _state_ instead — see §7. Screenshots of DOM
overlays are fine.

## 7. The debug hook

The app exposes `window.__scriptorium` **in development and test builds only**:

```ts
interface DebugHook {
  state(): NavigationState; // current FSM node
  address(): Address | null; // where the user is
  rig(): CameraRigSnapshot; // numeric camera state
  memory(): MemorySnapshot; // what the device holds, and whether a room is retiring
  frames(): never; // M10's; refuses by name until then
  waitForIdle(): Promise<void>; // timelines settled, worker queue empty
}
```

This is what makes end-to-end tests deterministic instead of `waitForTimeout(2000)`. Any test that sleeps
on a fixed duration is rejected in review; `waitForIdle()` exists precisely so that it never has to.

**How it is stripped.** The call that installs it stands behind `import.meta.env.MODE !==
'production'` in `src/main.ts`, which Vite replaces with a literal at build time, so a production
build drops the branch, the module behind it and the name itself.
`src/__tests__/production-bundle.test.ts` builds a production bundle and a test bundle in memory and
asserts the name is **absent** from the first and **present** in the second. Only asserting the
absence would pass just as well against a hook that had been renamed or deleted, which is the shape
of guard this project keeps finding.

**`frames()` refuses rather than reporting zeros.** The rolling frame budget is measured in M10, and
until then the hook throws `FrameTimingsUnavailableError`, naming the milestone. A hook that
answered with zeros would make §5's frame-budget assertion pass against a measurement nobody took —
a debug hook that lies is worse than one that is absent.

**`memory()` is for leaks across room changes.** It reads `renderer.info` when it is called:
`geometries` and `textures` from `renderer.info.memory`, `programs` as the length of
`renderer.info.programs` (`null` while the renderer has no program cache), and `isRetiring`, whether
the viewer is keeping a replaced room for its shader programs (`src/engine/retirement.ts`). The
counts include that room while it is kept, so a leak test compares them once `isRetiring` is `false`,
and waits on that condition, in the page, reading `memory().isRetiring` once per animation frame,
and not on a duration. Draw calls are not in it: `e2e/webgl-probe.ts` records them per frame,
below three.js.

**`waitForIdle()` is composed, not owned.** It resolves when every source of pending work the
composition knows about is idle. In M5 that is the camera flight: the playhead has arrived at the
label for the level the FSM is at, and no playhead tween is running (ADR-0030 explains why the label
alone is not enough). From M6 there are four, and from M7 five, joined by `src/app/idle.ts` and
listed in `src/main.ts` rather than by a second opinion held inside the hook:

1. the camera flight, as above, in the room the machine names: while the machine and the screen name
   different rooms the choreography is busy, even with the camera at rest (ADR-0034);
2. the worker client's request table, which reports an empty table as an event rather than leaving
   a test to poll `pendingCount`;
3. the reader, which is idle when the page in the DOM is the page the FSM says is open and nothing
   is in flight for it — the client going quiet is not the same statement, because a page arriving
   leaves the client with nothing to do and the reader with 80 lines to write;
4. the title resolver, because a shelf of 32 titles is generated work a test has every reason to
   wait for, and the flight arriving at a shelf is what starts it;
5. the search session, because the client is quiet the moment a hit arrives and the session acts on
   it a microtask later, so a test waiting on the client alone would read the machine before the hit
   had moved it.

**One pass over those five is not an answer**, which is the one property of the composition worth a
test: settling one source can make another busy, so `whenAllIdle` re-reads the list after every
settlement (`src/app/__tests__/idle.test.ts`).

## 8. Coverage thresholds

Each floor holds for lines, branches, functions and statements alike. `vite.config.ts` sets them per
glob, and there is no global threshold behind them.

| Path                                                                                                                                | Floor                                     |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `src/core/**`                                                                                                                       | 100% — it is pure, small and load-bearing |
| `src/worker/**`, `src/state/**`                                                                                                     | 90%                                       |
| `src/app/**`, `src/motion/**`                                                                                                       | 80%                                       |
| `src/engine/retirement.ts`                                                                                                          | 100%                                      |
| `src/ui/query.ts`, `src/ui/search-session.ts`, `src/ui/highlight.ts`, `src/ui/page-grid.ts`, `src/ui/room-name.ts`, each on its own | 90%                                       |
| the rest of `src/engine/**` and `src/ui/**`                                                                                         | no threshold; covered by e2e              |

`src/app/**` is at 80 rather than 90 because `controls.ts` installs DOM pointer handlers that only
Playwright reaches. Its one DOM-free predicate, `isEditableTarget`, is unit-tested, and the rest of the
file stays below the line. The floor is pooled over the layer's files, so the rest of the layer, the
title resolver and the composition of `waitForIdle()` among it, carries `controls.ts`.

`engine` and `ui` carry no floor as layers, because most of each needs WebGL or a DOM. The modules of
each that need neither have floors of their own: `retirement.ts` decides when a replaced room is
disposed, holds no three.js and is unit-tested whole, so it is held at 100; the four pure `ui` modules
and the DOM-free search session are held at 90. `reader.ts` and `search.ts` build the DOM and are
Playwright's alone. **One glob per module, never one brace glob over several:** Vitest pools the files a
glob matches, so a fully tested `query.ts` beside a `search-session.ts` at 0% branches passed a pooled
floor.

Thresholds only ratchet upward. Lowering one requires a line in the PR description explaining what was
given up.

## 9. Test hygiene

- Names describe behaviour: `rejects an address in the unfilled tail of the last room`, not `test address 3`.
- Arrange / Act / Assert, visually separated. One behaviour per test.
- No shared mutable state, no order dependence, no network.
- **A flaky test is fixed or deleted the day it is noticed.** Retries are not a fix; they are a way of
  discarding the information the test was built to produce.
- Never mock the thing under test. The bijection is tested against its own inverse, not against a stub.
