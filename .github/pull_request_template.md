## What and why

<!-- What this PR does and which problem it solves. Two or three sentences of substance.
     Not "implemented the cipher", but "address↔page is now a Feistel network, so neighbouring
     addresses no longer produce correlated pages". -->

## How it works

<!-- The key implementation decisions and what to read first to understand the diff.
     If this PR touches the bijection, the address model or the navigation FSM, describe the flow. -->

## Why this way

<!-- Alternatives considered and why they lost.
     If the decision is architectural, record it as an ADR in the same pull request. -->

## How to verify

<!-- Step by step: commands, what to click, expected outcome.
     Automated tests do not replace this section — manual verification catches different things. -->

```bash
npm ci
npm run verify        # typecheck + lint + test
npm run dev
```

## System impact

<!-- Tick what applies, delete the rest. -->

- [ ] Changes the library format — alphabet, `DOMAIN_TAG`, rounds, linearisation (`FORMAT_VERSION` bumped,
      golden vectors reviewed, previously shared links knowingly invalidated)
- [ ] Changes the public API of `core`
- [ ] Changes the URL scheme (old links still resolve or are refused with an explanation)
- [ ] Adds a runtime dependency, and the reason is written down
- [ ] Affects the frame budget (measured, numbers in this description)
- [ ] Breaking change

## How to verify performance

<!-- Only for PRs touching engine/, motion/ or worker/. State the numbers, not "feels smooth":
     frame time, draw calls, generation time. -->

---

## Author checklist

- [ ] CI is green
- [ ] Layer boundaries hold: `core` imports nothing, `motion` imports no `three`, `ui` imports no `three`,
      and only the worker client calls `core`
- [ ] No divergence from the spec, or the spec is updated alongside this PR
- [ ] Non-trivial decisions recorded as an ADR
- [ ] New logic is covered by tests; reversible logic is covered by property tests
- [ ] Golden vectors unchanged, or the format change above is ticked and deliberate
- [ ] No secrets, debug logging or commented-out code in the diff

## Milestone

<!-- Which milestone this closes, and the answer to its review gate. -->

Refs:
