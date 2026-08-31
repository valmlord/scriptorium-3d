import fc from 'fast-check';

/**
 * A fixed seed for all property tests. fast-check defaults to a random seed
 * per run, which makes a counterexample reproducible only if the seed is
 * captured at failure time. Pinning it here makes every run deterministic and
 * the seed a recorded constant (testing.md §2). When fast-check finds a
 * counterexample, the shrunk case is added as a named regression test and the
 * seed stays put.
 */
fc.configureGlobal({ seed: 20260830 });
