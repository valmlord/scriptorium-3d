import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { getViteConfig } from '../../vite.aliases';

/**
 * The editor resolves `@core/*` through tsconfig; the bundler resolves it
 * through vite.aliases. If the two disagree, imports keep type-checking while
 * the build points at a different directory — or the reverse, which is worse,
 * because the failure surfaces only in a production bundle.
 *
 * tsconfig.json is JSONC: it carries comments, so it is read with TypeScript's
 * own parser rather than JSON.parse. That also means this test resolves paths
 * exactly the way tsc does, instead of reimplementing the rules.
 */

const TSCONFIG_PATH = resolve('tsconfig.json');

function readTsconfigPaths(): Record<string, string[]> {
  const { config, error } = ts.readConfigFile(TSCONFIG_PATH, (path) =>
    ts.sys.readFile(path)
  );
  if (error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  }
  const paths: unknown = (config as { compilerOptions?: { paths?: unknown } })
    .compilerOptions?.paths;
  if (paths === undefined || typeof paths !== 'object' || paths === null) {
    throw new Error('tsconfig.json declares no path mappings');
  }
  return paths as Record<string, string[]>;
}

/** `@core/*` -> `@core`, and `./src/core/*` -> an absolute directory. */
function aliasName(pathKey: string): string {
  return pathKey.replace(/\/\*$/, '');
}

function targetDirectory(pathValue: string): string {
  return resolve(dirname(TSCONFIG_PATH), pathValue.replace(/\/\*$/, ''));
}

describe('alias agreement between tsconfig and vite', () => {
  it('declares the same set of aliases on both sides', () => {
    const tsAliases = Object.keys(readTsconfigPaths()).map(aliasName).sort();
    const viteAliases = Object.keys(getViteConfig()).sort();

    expect(viteAliases).toEqual(tsAliases);
  });

  it('points every alias at the same directory on both sides', () => {
    const tsconfigPaths = readTsconfigPaths();
    const viteAliases: Record<string, string> = getViteConfig();

    for (const [pathKey, targets] of Object.entries(tsconfigPaths)) {
      const target = targets[0];
      expect(target, `tsconfig path ${pathKey} has no target`).toBeDefined();

      const viteTarget = viteAliases[aliasName(pathKey)];
      expect(viteTarget, `vite has no alias for ${pathKey}`).toBeDefined();

      expect(
        resolve(viteTarget as string),
        `alias ${aliasName(pathKey)} disagrees`
      ).toBe(targetDirectory(target as string));
    }
  });

  it('maps each alias to exactly one target', () => {
    for (const [pathKey, targets] of Object.entries(readTsconfigPaths())) {
      // Several targets would let tsc fall back to a second directory that the
      // bundler knows nothing about, so the two resolvers could diverge for a
      // single import without either configuration looking wrong.
      expect(targets, `${pathKey} must have exactly one target`).toHaveLength(1);
    }
  });
});
