/**
 * How many cases a property test should run.
 *
 * testing.md §2 requires at least 1000 cases in CI, and that is what every
 * ordinary run uses. Under Stryker the suite runs once per mutant and
 * `src/core` yields close to 600 mutants, so the same budget would turn a
 * mutation run into hours; the cap below keeps it to minutes (ADR-0012).
 *
 * The reduction can only let a mutant **survive** that more cases would have
 * killed, so it moves the reported mutation score down, never up — the score
 * is a floor. Were it the other way round this would not be acceptable.
 *
 * This helper exists because `fc.configureGlobal({ numRuns })` does **not**
 * apply to an `fc.assert` that passes `numRuns` of its own: explicit
 * parameters win, so a global cap would have silently done nothing. Every
 * property test therefore routes its count through here.
 */
const MUTATION_RUN_CAP = 10;

const isMutationRun = process.env.SCRIPTORIUM_STRYKER === '1';

export function propertyRuns(requested: number): number {
  return isMutationRun ? Math.min(requested, MUTATION_RUN_CAP) : requested;
}
