# Testing strategy

A library with no database has no way to notice that it is wrong. There is no user complaining that a
record is missing — a broken bijection simply returns different plausible gibberish, forever. Tests are the
only thing standing between "the library works" and "the library confidently lies". They are written
accordingly.

**Every pull request adds tests. A PR that only adds code is not finished.**

---

## 1. What gets tested where

| Layer | How it is tested | Why that way |
|---|---|---|
| `core` | Vitest unit + **fast-check property tests** + committed golden vectors + mutation testing | Pure, deterministic, no I/O. There is no excuse for anything less than complete coverage here. |
| `worker` | Unit tests on the protocol handler as a pure function; integration test through a real `Worker` | The handler is where the bugs are; the thread is where the flakes are. Test them separately. |
| `state` | Exhaustive transition table test — every `(state, event)` pair asserted, legal or rejected | An FSM is a finite object, so "we tested the paths we thought of" is a choice, not a limitation. |
| `motion` | Timelines advanced with GSAP's ticker under fake time, asserting rig values at labels | Numbers only, no WebGL (ADR-0004). If a timeline needs a canvas to be tested, it is in the wrong layer. |
| `engine` | Pure layout maths (shelf positions, instance matrices, address↔`instanceId`) tested directly; the renderer itself is not unit-tested | Asserting on a GPU is a losing game. Extract the arithmetic, keep the renderer thin enough to review by eye. |
| `ui` / `app` | Playwright end-to-end against the built site | The only place where "the user typed a phrase and arrived at the book" is actually a true statement. |

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

- Threshold: **85% mutation score**, break the build below 75%.
- Not on every push — it is minutes, not seconds. Nightly, and on any PR touching `src/core/**`.

If a surviving mutant turns out to be genuinely equivalent, it is excluded with a comment explaining why.
Silently lowering the threshold is not an option.

## 5. Performance is a test, not a feeling

`vitest bench` covers page generation, and the benchmark asserts against a committed baseline:

- `getPage` on a cold cache: fails the build above **5 ms** (reference machine: 1.34 ms).
- `locate`: fails above **5 ms** (reference: 0.98 ms).

The margin is wide because CI machines are not reference machines. The point is to catch an accidental
`O(n²)` radix conversion, not to police microseconds.

Frame budget is asserted in Playwright instead: during a scripted camera flight, no frame exceeds 32 ms and
no more than 1% of frames exceed 20 ms, measured through the debug hook.

## 6. End-to-end

Playwright, Chromium plus WebKit, against `npm run build` output — never against the dev server.

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

**No pixel-diff screenshots of the WebGL canvas.** GPU and driver differences make them flake, and a flaky
test trains everyone to ignore red. Assert on the scene's *state* instead — see §7. Screenshots of DOM
overlays are fine.

## 7. The debug hook

The app exposes `window.__scriptorium` **in development and test builds only** (stripped by a
`define` at build time, verified by a test asserting it is `undefined` in production output):

```ts
interface DebugHook {
  state(): NavigationState;        // current FSM node
  address(): Address | null;       // where the user is
  rig(): CameraRigSnapshot;        // numeric camera state
  frames(): FrameTimings;          // rolling frame budget
  waitForIdle(): Promise<void>;    // timelines settled, worker queue empty
}
```

This is what makes end-to-end tests deterministic instead of `waitForTimeout(2000)`. Any test that sleeps
on a fixed duration is rejected in review; `waitForIdle()` exists precisely so that it never has to.

## 8. Coverage thresholds

| Path | Lines / branches |
|---|---|
| `src/core/**` | 100% — it is pure, small and load-bearing |
| `src/worker/**`, `src/state/**` | 90% |
| `src/motion/**` | 80% |
| `src/engine/**`, `src/ui/**` | no threshold; covered by e2e |

Thresholds only ratchet upward. Lowering one requires a line in the PR description explaining what was
given up.

## 9. Test hygiene

- Names describe behaviour: `rejects an address in the unfilled tail of the last room`, not `test address 3`.
- Arrange / Act / Assert, visually separated. One behaviour per test.
- No shared mutable state, no order dependence, no network.
- **A flaky test is fixed or deleted the day it is noticed.** Retries are not a fix; they are a way of
  discarding the information the test was built to produce.
- Never mock the thing under test. The bijection is tested against its own inverse, not against a stub.
