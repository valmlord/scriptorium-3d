import { defineConfig } from 'vitest/config';
import baseConfig from './vite.config.ts';

/**
 * The Vitest configuration Stryker runs the test suite under.
 *
 * Mutation testing re-runs the suite once per mutant, and `src/core` produces
 * close to 600 of them. The property tests that testing.md §2 requires to run
 * at >= 1000 cases take seconds each, which multiplied out is hours, so the
 * flag below caps the case count — see `src/core/__tests__/property-runs.ts`,
 * which reads it. The cap lives there rather than in
 * `fc.configureGlobal` because a global `numRuns` is ignored by any
 * `fc.assert` that passes its own, and every property test here does.
 *
 * Fewer cases can only let a mutant **survive** that more cases would have
 * killed, so this lowers the reported mutation score rather than flattering
 * it. `npm run test` and CI still run the full 1000 cases.
 *
 * The fields are overridden explicitly rather than through `mergeConfig`,
 * which concatenates arrays: merging would have *added* to `test.include`
 * instead of narrowing it.
 */
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    env: {
      ...baseConfig.test?.env,
      SCRIPTORIUM_STRYKER: '1',
    },
    // Vitest's 5 s default is not a budget anyone chose, and it decided the
    // mutation job by coin flip: on commit ae0af83 the dry run passed in CI run
    // 41326395583 and timed out in 41326391660 — same code, two verdicts — on
    // `roomToName / roomFromName round-trips over generated rooms` and
    // `intToDigits round-trips through digitsToInt for arbitrary values`. Those
    // take 416 ms and 423 ms here uninstrumented; Stryker's dry run runs them
    // over 598 mutants' worth of coverage counters with per-test recording on
    // top, which costs ~2.5x locally (net 6.8 s against 2.8 s) before the
    // runner's own ~8x is applied.
    //
    // This is a hang guard, not a performance gate. The wall-clock budget lives
    // in performance.test.ts and is enforced by `verify` (ADR-0013), and a slow
    // *mutant* is still bounded by Stryker's own deadline — `timeoutMS` 15 s
    // plus `timeoutFactor` 2 x the dry-run time, about 29 s — which fires
    // first, so this ceiling only lifts the dry run. The same default was
    // raised for the same reason in src/__tests__/layer-boundaries.test.ts.
    testTimeout: 30_000,
    // Stryker mutates `src/core` (ADR-0008), so `src/core`'s own tests are
    // what judge the mutants. The two tests in `src/__tests__` drive the
    // ESLint API over throwaway files written into each layer directory, which
    // does not survive being run from Stryker's sandbox copy of the project —
    // and a lint-configuration test could not kill a mutant in the bijection
    // anyway. They run in `npm run test` and in CI as usual.
    include: ['src/core/__tests__/**/*.test.ts'],
    // Coverage is Stryker's job here; instrumenting on top of its own
    // instrumentation only slows the run down.
    coverage: {
      enabled: false,
    },
  },
});
