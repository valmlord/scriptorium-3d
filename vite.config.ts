import { defineConfig } from 'vite';
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
      // engine/ and ui/ carry no threshold on purpose — they are covered by e2e.
      thresholds: {
        'src/core/**': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/worker/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/state/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
        'src/motion/**': { lines: 80, branches: 80, functions: 80, statements: 80 },
      },
    },
  },
});
