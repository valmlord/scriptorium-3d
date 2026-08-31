import { defineConfig } from 'vite';
import { getViteConfig } from './vite.aliases.ts';

const aliases = getViteConfig();

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
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    setupFiles: ['src/core/__tests__/fast-check-setup.ts'],
    // e2e belongs to Playwright; Vitest must not try to run those specs.
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**', 'src/*/index.ts'],
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
