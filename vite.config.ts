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
    // e2e belongs to Playwright; Vitest must not try to run those specs.
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
