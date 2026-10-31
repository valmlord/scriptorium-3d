# Code quality

Spacing and semicolons are the formatter's problem. This is about what the linter cannot catch.

**All code, comments, identifiers, log messages and error strings are in English.** A Russian comment in a
source file is a review blocker. The only Cyrillic in the repository is the alphabet table in
`core/alphabet.ts`, the UI dictionary and test fixtures.

---

## 1. Typing

`tsconfig` is strict and is not relaxed to make something compile:

```jsonc
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true
}
```

- **`any` does not pass review.** Unknown types are `unknown` with explicit narrowing.
- **`as` is a red flag.** Every assertion needs a justification; `as any` needs none — it is banned.
- Exported functions carry explicit return types. Inference is fine inside a module; at a boundary it turns
  an implementation change into a silent contract change.
- Data crossing a boundary is untrusted and validated at runtime: a parsed URL, a message arriving from the
  worker, a search query typed by a user. A type is a promise to the compiler, not a check.
- No empty `catch`, no `catch (e: any)`.

### bigint

- Address space is `bigint` everywhere. Never widen one to `number` "just for the UI" — `Number(room)` on a
  4975-digit value silently returns `Infinity`.
- Never mix: `1` and `1n` do not add. Constants that belong to the address space are declared with `n`.

## 2. Naming

- Complete and meaningful: `pagesPerRoom`, not `ppr`, and certainly not `n`.
- Booleans read as questions: `isValidAddress`, `hasUnknownSymbols`.
- No magic literals. A `3200` in code is `PAGE_LENGTH` with a comment pointing at the SPEC section that
  fixes it.
- One vocabulary, taken from the SPEC: a `volume` is the book on a shelf, a `page` is one side of it, a
  `room` is the hexagon. Never `book` where the SPEC says `volume`, never `hex` where it says `room`.

## 3. Functions and modules

- A function does one thing. If describing it needs an "and", it does two.
- Uniform abstraction level inside a function: a domain operation and manual byte fiddling do not belong
  side by side.
- Early returns over nesting; three levels of `if` is the ceiling.
- Side effects are explicit. A `getTitle` that also warms a cache is a trap for the next reader.
- Dead code is deleted, not commented out. Git is the history.

## 4. Errors

- Dedicated types for domain situations: `InvalidAddressError`, `UnknownSymbolError`. Never a bare
  `Error("something went wrong")`.
- Error messages carry context: which address, which character, at which offset. `"invalid input"` is
  useless to the user and to the developer reading a bug report.
- Catch where something can be done about it, not at every level "just in case".

## 5. Comments

A good comment answers **why**, not **what**.

```ts
// ❌ convert to base 36
const digits = value.toString(36);

// ✅ V8 converts bigint to base 36 natively in ~0.1 ms, where a hand-rolled
// divide-by-radix loop over a 16545-bit value takes tens of milliseconds.
// The digit-to-alphabet mapping is verified against the slow path in tests.
const digits = value.toString(36);
```

A comment restating the code is noise. A comment that lies is worse than none: change the code, change the
comment beside it.

## 6. Tests

- **The test name describes behaviour**: `locates the address of a page containing the query`, not
  `test_search_2`.
- Arrange / Act / Assert, visually separated.
- One test proves one behaviour.
- **Property-based tests for anything reversible.** `locate(getPage(a)) === a` over generated addresses
  proves more than fifty hand-picked examples, and it finds the edges you would not have thought of.
- Golden vectors are a contract, not a snapshot (ADR-0003). A red golden test is never fixed by
  regenerating the fixture.
- Tests do not share state or depend on order. A flaky test is fixed or deleted — "just re-run it" trains
  everyone to ignore a red pipeline.

## 7. Dependencies

A new library is a deliberate decision, recorded in `DECISIONS.md` when it is not obvious. Twenty lines of
your own code often beat a package with six transitive dependencies — but **cryptographic primitives are
the exception**: `@noble/hashes` is used rather than a hand-rolled SHA-256, because a subtly wrong hash
still produces convincing-looking output and would corrupt the library invisibly.

Versions are pinned by the lockfile, and the lockfile is committed.

## 8. What is automated

| Tool | Scope |
|---|---|
| ESLint + Prettier | style, layer import rules |
| `tsc --noEmit` | types |
| Vitest + fast-check | behaviour and properties |

All of them are required CI stages. Pre-commit hooks are a convenience; **CI is the authority**, and
anything CI has not verified counts as unverified.
