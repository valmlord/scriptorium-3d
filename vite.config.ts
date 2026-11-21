// `vitest/config` rather than `vite`, because the `test` block below is
// Vitest's and Vite's own `UserConfig` does not carry it: imported from
// `vite`, the block type-checks only in programs that happen to include
// another file importing `vitest/config`, which is how it went unchecked
// until `src/__tests__/test-budgets.test.ts` read it. Same import as
// `vitest.stryker.config.ts` already uses.
import { defineConfig } from 'vitest/config';
import { getViteConfig } from './vite.aliases.ts';

const aliases = getViteConfig();

/**
 * Whether this run is collecting coverage. The v8 provider instruments through
 * an inspector session inside the worker, which leaves no trace in the
 * worker's own environment, so the flag is passed down deliberately. It is
 * read by `src/core/__tests__/performance.test.ts`, where a wall-clock budget
 * would otherwise be measuring the instrumentation rather than the library.
 *
 * Set through `test.env` rather than a shell prefix on the npm script so that
 * `npm run coverage` behaves the same on Windows.
 */
const isCollectingCoverage = process.argv.includes('--coverage');

export default defineConfig({
  // Must match the GitHub repository name exactly: Pages serves the site
  // from https://<user>.github.io/scriptorium-3d/ and every asset URL is
  // resolved against this prefix.
  base: '/scriptorium-3d/',
  resolve: {
    alias: aliases,
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    env: {
      SCRIPTORIUM_COVERAGE: isCollectingCoverage ? '1' : '',
    },
    // A hang guard, not a performance gate, and chosen rather than inherited
    // (ADR-0028). Vitest's 5 s default decided the mutation job by coin flip;
    // `vitest.stryker.config.ts` writes that reasoning out and this does not
    // repeat it. The wall-clock budget is testing.md section 5's, asserted in
    // `src/core/__tests__/performance.test.ts` and enforced by CI's `verify`
    // on every push (ADR-0013), so nothing here is what notices the library
    // getting slower.
    //
    // 25 s is 5.8x the slowest test this setting governs, measured on
    // `ubuntu-latest` under `npm run coverage` -- the slower of the two CI
    // jobs that read this config -- at 4318 ms over six runs on two CPU
    // models. 50 s is 5.4x the slowest hook on record, the `beforeAll` in
    // `src/__tests__/layer-boundaries.test.ts` at 9328 ms in the same runs,
    // which had already reached 93% of Vitest's unexamined 10 s default.
    // ADR-0028 carries the figures and the per-file overrides they settled.
    testTimeout: 25_000,
    hookTimeout: 50_000,
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    setupFiles: ['src/core/__tests__/fast-check-setup.ts'],
    // e2e belongs to Playwright; Vitest must not try to run those specs.
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/**/__fixtures__/**',
        'src/*/index.ts',
      ],
      // Glob-keyed thresholds; a matched file does not inherit global ones.
      // engine/ and ui/ are covered by e2e and carry no layer threshold on
      // purpose, because most of each needs WebGL or a DOM. The modules of
      // each that need neither have floors of their own. In engine/,
      // `retirement.ts`, which decides when a replaced room is disposed, holds
      // no three.js and is unit-tested whole, so it is kept at 100. In ui/,
      // the four pure modules (`query.ts`, `highlight.ts`, `page-grid.ts`,
      // `room-name.ts`) and the DOM-free search session (`search-session.ts`)
      // are kept at 90; `reader.ts` and `search.ts` build the DOM and are
      // Playwright's alone.
      //
      // **One glob per module, never one brace glob over several.** Vitest
      // pools the files a glob matches, so a fully tested `query.ts` beside a
      // `search-session.ts` at 0% branches passes a pooled `{a,b}.ts` floor.
      //
      // app/ had none either, and that was an omission rather than a decision:
      // it is where the projections live, so M6 put the title resolver and the
      // composition of `waitForIdle()` there, which is the most
      // order-dependent code in the repository. Its floor is 80 rather than
      // 90 because `controls.ts` installs DOM pointer handlers and is reached
      // only from Playwright, so it sits at 0 here and the layer still
      // aggregates to 87.
      thresholds: {
        'src/core/**': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/worker/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/state/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/app/**': { lines: 80, branches: 80, functions: 80, statements: 80 },
        'src/motion/**': { lines: 80, branches: 80, functions: 80, statements: 80 },
        'src/engine/retirement.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'src/ui/query.ts': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/ui/search-session.ts': {
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
        'src/ui/highlight.ts': {
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
        'src/ui/page-grid.ts': {
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
        'src/ui/room-name.ts': {
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
      },
    },
  },
});
