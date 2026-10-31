import fc from 'fast-check';

/**
 * A fixed seed for all property tests. fast-check defaults to a random seed
 * per run, which makes a counterexample reproducible only if the seed is
 * captured at failure time. Pinning it here makes every run deterministic and
 * the seed a recorded constant (testing.md §2). When fast-check finds a
 * counterexample, the shrunk case is added as a named regression test and the
 * seed stays put.
 */
/**
 * Under Stryker the suite runs once per mutant, so the >= 1000-case property
 * tests are given a smaller budget to keep a mutation run to minutes rather
 * than hours (`vitest.stryker.config.ts`). Fewer cases can only let a mutant
 * survive that more cases would have caught, so the mutation score this
 * produces is a floor, never an inflation. Every other run — `npm run test`,
 * `npm run coverage`, CI — uses the full budget.
 */
const isMutationRun = process.env.SCRIPTORIUM_STRYKER === '1';

fc.configureGlobal(
  isMutationRun ? { seed: 20260830, numRuns: 25 } : { seed: 20260830 }
);
