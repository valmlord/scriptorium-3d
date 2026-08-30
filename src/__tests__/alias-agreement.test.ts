import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getViteConfig } from '../../vite.aliases';

describe('alias agreement', () => {
  it('every tsconfig path has a matching vite alias', () => {
    const tsconfigPath = resolve('tsconfig.json');
    const tsconfigContent = JSON.parse(readFileSync(tsconfigPath, 'utf-8'));
    const tsconfigPaths = tsconfigContent.compilerOptions?.paths || {};

    const viteAliases = getViteConfig();
    const viteKeys = Object.keys(viteAliases);

    for (const tsPath of Object.keys(tsconfigPaths)) {
      // Extract the alias prefix (e.g., '@core' from '@core/*')
      const aliasPrefix = tsPath.replace('/*', '');
      expect(viteKeys).toContain(aliasPrefix);
    }
  });

  it('every vite alias has a matching tsconfig path', () => {
    const tsconfigPath = resolve('tsconfig.json');
    const tsconfigContent = JSON.parse(readFileSync(tsconfigPath, 'utf-8'));
    const tsconfigPaths = Object.keys(tsconfigContent.compilerOptions?.paths || {});

    const viteAliases = getViteConfig();

    for (const aliasKey of Object.keys(viteAliases)) {
      const tsconfigKey = `${aliasKey}/*`;
      expect(tsconfigPaths).toContain(tsconfigKey);
    }
  });
});
