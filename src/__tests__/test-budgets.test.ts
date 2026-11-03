import { describe, it, expect } from 'vitest';
import { getCurrentTest } from 'vitest/suite';
import { globSync, readFileSync } from 'node:fs';
import viteConfig from '../../vite.config';

/**
 * The two ceilings in `vite.config.ts` are the kind of setting this repository
 * keeps catching: a figure that looks deliberate and governs nothing. Until
 * ADR-0028 the per-test one was Vitest's unexamined 5 s default and the suite
 * had grown into it, and a chosen number is only worth more than an inherited
 * one while it is still the number in force.
 *
 * So the first test asserts the ceiling the runner **applied to itself**
 * against what the config declares — not that the key is present, which is
 * also what a key the tool discards looks like. The rest assert that nothing
 * outside the config quietly narrows either ceiling, which is what
 * `layer-boundaries.test.ts` had started doing the moment the config's own
 * figure passed its 20 s override.
 *
 * **What is not covered.** A numeric literal written straight into a call site
 * — `it(name, fn, 30_000)` — is invisible to the scan below, which reads
 * `vi.setConfig` calls and `*_TIMEOUT_MS` constants. There is no such literal
 * in the suite, and finding one would mean resolving expressions out of the
 * source, which is a second TypeScript program for a style nothing uses.
 *
 * Neither ceiling's figure is written here. Both are read from the config, so
 * this file cannot become the second home of a number (ADR-0013).
 */

/** Vitest's own defaults, which the configured ceilings exist to replace. */
const VITEST_DEFAULT_TEST_TIMEOUT_MS = 5_000;
const VITEST_DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/**
 * This file, which the scan below skips.
 *
 * The two constants above match its own `*_TIMEOUT_MS` pattern and are not
 * budgets for anything — they are the defaults being replaced. Skipping by
 * path rather than by refining the pattern, so that a future constant here
 * cannot creep into the scan by being named carefully.
 */
const SCANNER = 'src/__tests__/test-budgets.test.ts';

const configured = viteConfig.test;
const declaredTestTimeout = configured?.testTimeout;
const declaredHookTimeout = configured?.hookTimeout;

/** A budget a test file declares for itself, and which of the two it raises. */
interface FileBudget {
  readonly file: string;
  readonly source: string;
  readonly kind: 'test' | 'hook';
  readonly ms: number;
}

function toMilliseconds(digits: string): number {
  return Number(digits.replaceAll('_', ''));
}

/**
 * Every budget declared in a test file rather than in the config.
 *
 * Read out of the source rather than by importing the module: `vi.setConfig`
 * is a side effect at module scope, so importing a file to inspect it would
 * run its suite.
 */
function findFileBudgets(): FileBudget[] {
  const budgets: FileBudget[] = [];
  for (const file of globSync('src/**/*.test.ts').sort()) {
    if (file === SCANNER) {
      continue;
    }
    const text = readFileSync(file, 'utf8');
    for (const [call] of text.matchAll(/vi\.setConfig\(\{[^}]*\}\)/g)) {
      for (const [, key, digits] of call.matchAll(
        /(testTimeout|hookTimeout):\s*([0-9_]+)/g
      )) {
        budgets.push({
          file,
          source: `vi.setConfig ${key ?? ''}`,
          kind: key === 'hookTimeout' ? 'hook' : 'test',
          ms: toMilliseconds(digits ?? ''),
        });
      }
    }
    for (const [, name, digits] of text.matchAll(
      /const (\w*TIMEOUT_MS) = ([0-9_]+);/g
    )) {
      budgets.push({
        file,
        source: `const ${name ?? ''}`,
        kind: 'test',
        ms: toMilliseconds(digits ?? ''),
      });
    }
  }
  return budgets;
}

const fileBudgets = findFileBudgets();

describe('the suite’s per-test and per-hook budgets', () => {
  it('runs this test on the ceiling vite.config.ts declares, not Vitest’s own', () => {
    const applied = getCurrentTest()?.timeout;

    expect(declaredTestTimeout).toBeTypeOf('number');
    expect(declaredTestTimeout).not.toBe(VITEST_DEFAULT_TEST_TIMEOUT_MS);
    expect(applied).toBe(declaredTestTimeout);
  });

  it('declares a per-hook ceiling too, so a file that adds a hook inherits a chosen one', () => {
    expect(declaredHookTimeout).toBeTypeOf('number');
    expect(declaredHookTimeout).not.toBe(VITEST_DEFAULT_HOOK_TIMEOUT_MS);
  });

  it('finds the budgets declared outside the config, rather than none', () => {
    expect(fileBudgets.map((budget) => `${budget.file} ${budget.source}`)).toEqual([
      'src/__tests__/layer-boundaries.test.ts vi.setConfig hookTimeout',
      'src/core/__tests__/library.test.ts const PROPERTY_TIMEOUT_MS',
    ]);
  });

  it.each(fileBudgets)(
    'lets $file raise a ceiling with $source and never lower one',
    ({ kind, ms }) => {
      const ceiling =
        kind === 'hook'
          ? (declaredHookTimeout ?? VITEST_DEFAULT_HOOK_TIMEOUT_MS)
          : (declaredTestTimeout ?? VITEST_DEFAULT_TEST_TIMEOUT_MS);

      expect(ms).toBeGreaterThan(ceiling);
    }
  );
});
