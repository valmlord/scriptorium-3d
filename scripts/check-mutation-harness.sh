#!/usr/bin/env bash
#
# The cheap half of the mutation harness (ADR-0014). Stryker's dry run is the step that instruments
# `src/core`, starts the runner and takes one full pass of the suite; it is what broke on `ae0af83`,
# and it costs about fifteen seconds against the full mutation run's twenty-one to fifty-nine
# minutes.
#
# Why this is a script and not `stryker run --dryRunOnly` in the workflow: the exit code alone is not
# enough. With the dry run deliberately broken (`testTimeout` cut to 50 ms in
# `vitest.stryker.config.ts`), six of seven observed runs exited 1 — and the seventh printed
# "Initial test run succeeded. Ran 43 tests", a pass on a suite that had silently lost 186 of its
# 229 tests. A gate that green-lights a truncated run is the thing this repository keeps finding and
# removing, so the count is asserted as well.
#
# The expected count comes from `vitest list` against the same config, which collects without
# running and costs well under a second. That keeps the number out of this file: a floor written
# here would be a magic literal that rots the first time a test is added.
#
# The two counts are comparable because both sides read `vitest.stryker.config.ts`, so both see
# `SCRIPTORIUM_STRYKER=1` and both drop the same deliberately skipped work -- the budget suite in
# `performance.test.ts` is `describe.skipIf(isInstrumented)`, and `vitest list` reports 229 with
# none of it, exactly what the dry run then runs. Reading the count from the unscoped config would
# compare 257 against 229 and fail every time.
set -euo pipefail

cd "$(dirname "$0")/.."

expected="$(npx vitest list --config vitest.stryker.config.ts --json |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))')"

if ! [[ "$expected" =~ ^[0-9]+$ ]] || [[ "$expected" -eq 0 ]]; then
  echo "check-mutation-harness: vitest list collected no tests (got '$expected')" >&2
  exit 1
fi

echo "check-mutation-harness: the Stryker config collects $expected tests; running the dry run"

# Tee rather than capture-then-print, so a hang or a crash still leaves the operator the log.
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
npx stryker run stryker.config.json --dryRunOnly 2>&1 | tee "$log"

# `grep -o` prints nothing when Stryker rewords this line, and an empty `ran` then fails the
# comparison below. That is the intended direction: an unparseable log is a red gate, not a green
# one.
ran="$(sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -oE 'Ran [0-9]+ tests' | head -1 | grep -oE '[0-9]+' || true)"

if [[ "$ran" != "$expected" ]]; then
  echo "check-mutation-harness: the dry run reported '${ran:-no parseable count}' tests, expected $expected" >&2
  exit 1
fi

echo "check-mutation-harness: the dry run ran all $expected tests"
