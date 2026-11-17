import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ESLint } from 'eslint';
import { writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';

/**
 * The layer rules are enforced by ESLint glob patterns over real file paths
 * under src/<layer>/. To exercise them we write a throwaway file into each
 * layer directory, lint it through the real ESLint Node API, and clean up.
 */
// These rules are type-aware, so the first lint builds a TypeScript program for
// the whole project — seconds, not milliseconds. Under coverage instrumentation
// that overran the 5 s default and failed the coverage job while `verify`, which
// runs the same tests uninstrumented, stayed green.
//
// The `beforeAll` below is the heaviest hook in the repository, and the one
// `vite.config.ts` calibrated its own `hookTimeout` on: its worst observation
// there is 9.3 s under coverage (ADR-0028, which has the runs). 60 s is 6.4x
// that against the config's 5.4x, and the extra margin is what this line is
// for — the one hook whose cost is a whole TypeScript program keeps a ceiling
// of its own.
//
// The per-test `testTimeout: 20_000` that stood here is gone, because against
// the config's chosen 25 s it had stopped raising a ceiling and started lowering
// one. ADR-0028 recorded the file at "twenty tests summing to about 1.2 s under
// coverage" to argue that; ADR-0029 took it to 100, so that sentence is no longer
// a description of this file and has been removed rather than rescaled.
//
// What replaces it is the reason the count never mattered: **neither ceiling is
// a sum.** `testTimeout` is per test and every test here is one lint of a
// one-line file against the program the hook has already built — under a second
// in every run observed, on machines carrying other work. `hookTimeout` is per
// hook and the hook does exactly one warm-up lint, so adding tests does not
// touch it either. Tripling the file moves neither number.
//
// No figure is written here on purpose. Local observations of the hook spanned
// roughly 3 s to 18 s depending on what else the machine was doing, which is a
// spread too wide to calibrate against; ADR-0028's own figures are
// `ubuntu-latest` ones and have not been retaken since the file grew. The
// 60 s above is left as ADR-0028 chose it, and the open question that record
// names — that nothing in CI reports a test duration — is what would settle it.
vi.setConfig({ hookTimeout: 60_000 });

/**
 * The two rules that carry a layer boundary. `no-restricted-imports` visits only
 * the static import forms, so the dynamic `import()` is held by a
 * `no-restricted-syntax` selector instead (ADR-0029). Both are filtered for
 * here, because a case that fires the wrong one is not the case it claims to be.
 */
/**
 * The name of the file each case is written to, carrying this process's pid.
 *
 * The rules are matched on real paths, so the file has to exist on disk and be
 * inside a tsconfig project for `projectService` to type it. A fixed name made
 * two concurrent runs share it, so one run's `afterAll` could delete a file
 * another was still linting — which happened three times while this file was
 * being written, once failing `typecheck` on a half-written snippet. The pid
 * makes each run's files its own.
 */
const THROWAWAY_FILE = `__layer_boundary_test__.${process.pid}.ts`;

const LAYER_RULES = new Set([
  '@typescript-eslint/no-restricted-imports',
  'no-restricted-syntax',
]);

describe('layer boundaries', () => {
  let eslint: ESLint;
  const tempFiles: string[] = [];

  beforeAll(async () => {
    eslint = new ESLint({
      baseConfig: undefined,
      overrideConfigFile: './eslint.config.js',
    });
    // Pay for building the type-aware program once, inside a hook with its own
    // budget, so no individual test carries the warm-up cost and times out.
    await lintInLayer('core', 'export const warmUp = 0;\n');
  });

  afterAll(() => {
    for (const file of tempFiles) {
      rmSync(file, { force: true });
    }
  });

  /**
   * Lint a throwaway file at one path under `src/`. Separate from
   * `lintInLayer` because one block's glob is not a layer directory:
   * `src/*.ts` holds the composition root, `src/main.ts`, which is held to
   * `@app`'s rule and had no block of its own until ADR-0029.
   */
  async function lintAtPath(relativePath: string, code: string) {
    const filePath = resolve(relativePath);
    writeFileSync(filePath, code);
    tempFiles.push(filePath);
    const results = await eslint.lintText(code, { filePath });
    return results[0]?.messages.filter((m) => LAYER_RULES.has(m.ruleId ?? '')) ?? [];
  }

  async function lintInLayer(layer: string, code: string) {
    return lintAtPath(`src/${layer}/${THROWAWAY_FILE}`, code);
  }

  describe('@core layer', () => {
    it('rejects a runtime three import', async () => {
      const violations = await lintInLayer('core', "import * as THREE from 'three';");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('three is not allowed in @core layer');
    });

    it('allows a type-only three import', async () => {
      const violations = await lintInLayer(
        'core',
        "import type { Vector3 } from 'three';"
      );
      expect(violations).toHaveLength(0);
    });

    it('rejects a runtime gsap import', async () => {
      const violations = await lintInLayer('core', "import { gsap } from 'gsap';");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('gsap is not allowed in @core layer');
    });

    it('allows a type-only gsap import', async () => {
      const violations = await lintInLayer(
        'core',
        "import type { Tween } from 'gsap';"
      );
      expect(violations).toHaveLength(0);
    });

    it('rejects a runtime import from other layers', async () => {
      const violations = await lintInLayer(
        'core',
        "import { something } from '@ui/index';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('layers may only be imported as types');
    });

    it('allows a type-only import from other layers', async () => {
      const violations = await lintInLayer(
        'core',
        "import type { Something } from '@ui/index';"
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe('@motion layer', () => {
    it('rejects a runtime three import', async () => {
      const violations = await lintInLayer('motion', "import * as THREE from 'three';");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('three may only be imported as types');
    });

    it('allows a type-only three import', async () => {
      const violations = await lintInLayer(
        'motion',
        "import type { Vector3 } from 'three';"
      );
      expect(violations).toHaveLength(0);
    });

    it('allows a runtime gsap import', async () => {
      const violations = await lintInLayer('motion', "import { gsap } from 'gsap';");
      expect(violations).toHaveLength(0);
    });
  });

  describe('@engine layer', () => {
    it('allows a runtime three import', async () => {
      const violations = await lintInLayer('engine', "import * as THREE from 'three';");
      expect(violations).toHaveLength(0);
    });

    it('rejects a runtime gsap import', async () => {
      const violations = await lintInLayer('engine', "import { gsap } from 'gsap';");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('gsap is not allowed in @engine layer');
    });

    it('rejects a runtime @ui import', async () => {
      const violations = await lintInLayer(
        'engine',
        "import { component } from '@ui/index';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('@ui is not allowed in @engine layer');
    });

    it('allows a type-only @ui import', async () => {
      const violations = await lintInLayer(
        'engine',
        "import type { Component } from '@ui/index';"
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe('@ui layer', () => {
    it('rejects a runtime three import', async () => {
      const violations = await lintInLayer('ui', "import * as THREE from 'three';");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('three is not allowed in @ui layer');
    });

    it('allows a type-only three import', async () => {
      const violations = await lintInLayer(
        'ui',
        "import type { Vector3 } from 'three';"
      );
      expect(violations).toHaveLength(0);
    });

    it('rejects a runtime gsap import', async () => {
      const violations = await lintInLayer('ui', "import { gsap } from 'gsap';");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(
        'gsap may only be imported as types in @ui'
      );
    });

    it('allows a runtime @state import', async () => {
      // architecture §1 grants `ui -> state`; until ADR-0029 the rule refused
      // it, and M6 would have been the first code to find out.
      const violations = await lintInLayer(
        'ui',
        "import { navigate } from '@state/index';"
      );
      expect(violations).toHaveLength(0);
    });

    it('allows a runtime @worker/client import', async () => {
      const violations = await lintInLayer(
        'ui',
        "import { createGenerationWorker } from '@worker/client';"
      );
      expect(violations).toHaveLength(0);
    });

    it('rejects a runtime import of the rest of @worker', async () => {
      const violations = await lintInLayer(
        'ui',
        "import { REQUEST_PAGE } from '@worker/protocol';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(
        'only @worker/client may be imported at runtime in @ui'
      );
    });

    it('rejects a runtime @worker barrel import, which re-exports the loop', async () => {
      const violations = await lintInLayer(
        'ui',
        "import { createGenerationWorker } from '@worker/index';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(
        'only @worker/client may be imported at runtime in @ui'
      );
    });

    it('rejects a runtime @motion import', async () => {
      const violations = await lintInLayer(
        'ui',
        "import { timeline } from '@motion/index';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(
        'other layers may only be imported as types in @ui'
      );
    });
  });

  describe('@worker layer', () => {
    it('allows a runtime @core import', async () => {
      const violations = await lintInLayer(
        'worker',
        "import { something } from '@core/index';"
      );
      expect(violations).toHaveLength(0);
    });

    it('rejects a runtime @ui import', async () => {
      const violations = await lintInLayer(
        'worker',
        "import { component } from '@ui/index';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(
        'layers may only be imported as types in @worker'
      );
    });

    it('allows a type-only @ui import', async () => {
      const violations = await lintInLayer(
        'worker',
        "import type { Component } from '@ui/index';"
      );
      expect(violations).toHaveLength(0);
    });

    it('rejects a runtime @motion import', async () => {
      // architecture §1 says `worker -> core`; its block left @motion and
      // @state out of the group, so the worker could have reached into the
      // timeline it exists to keep off the thread (ADR-0029).
      const violations = await lintInLayer(
        'worker',
        "import { timeline } from '@motion/index';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(
        'other layers may only be imported as types in @worker'
      );
    });

    it('rejects a runtime @state import', async () => {
      const violations = await lintInLayer(
        'worker',
        "import { navigate } from '@state/index';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(
        'other layers may only be imported as types in @worker'
      );
    });

    it('rejects a runtime three import', async () => {
      const violations = await lintInLayer('worker', "import * as THREE from 'three';");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(
        'three may only be imported as types in @worker'
      );
    });

    it('allows a type-only three import', async () => {
      const violations = await lintInLayer(
        'worker',
        "import type { Vector3 } from 'three';"
      );
      expect(violations).toHaveLength(0);
    });

    it('rejects a runtime gsap import', async () => {
      const violations = await lintInLayer('worker', "import { gsap } from 'gsap';");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(
        'gsap may only be imported as types in @worker'
      );
    });

    it('allows a runtime @core/library import — the one layer that may', async () => {
      const violations = await lintInLayer(
        'worker',
        "import { getPage } from '@core/library';"
      );
      expect(violations).toHaveLength(0);
    });

    it('allows a runtime @core/address import', async () => {
      const violations = await lintInLayer(
        'worker',
        "import { toLinear } from '@core/address';"
      );
      expect(violations).toHaveLength(0);
    });

    it('allows a dynamic @core/library import', async () => {
      const violations = await lintInLayer('worker', "void import('@core/library');");
      expect(violations).toHaveLength(0);
    });
  });

  describe('@state layer', () => {
    // This layer had no block at all until ADR-0029: every import below was
    // permitted, in the layer architecture §1 grants `core types` and nothing
    // else.
    it('rejects a runtime three import', async () => {
      const violations = await lintInLayer('state', "import * as THREE from 'three';");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(
        'three may only be imported as types in @state'
      );
    });

    it('allows a type-only three import', async () => {
      const violations = await lintInLayer(
        'state',
        "import type { Vector3 } from 'three';"
      );
      expect(violations).toHaveLength(0);
    });

    it('rejects a runtime gsap import', async () => {
      const violations = await lintInLayer('state', "import { gsap } from 'gsap';");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(
        'gsap may only be imported as types in @state'
      );
    });

    it('rejects a runtime @ui import', async () => {
      const violations = await lintInLayer(
        'state',
        "import { component } from '@ui/index';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(
        'other layers may only be imported as types in @state'
      );
    });

    it('allows a type-only @ui import', async () => {
      const violations = await lintInLayer(
        'state',
        "import type { Component } from '@ui/index';"
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe('@app layer', () => {
    it('allows a runtime three import', async () => {
      const violations = await lintInLayer('app', "import * as THREE from 'three';");
      expect(violations).toHaveLength(0);
    });

    it('allows a runtime @ui import', async () => {
      const violations = await lintInLayer(
        'app',
        "import { component } from '@ui/index';"
      );
      expect(violations).toHaveLength(0);
    });

    it('allows a runtime @worker/client import', async () => {
      const violations = await lintInLayer(
        'app',
        "import { createGenerationWorker } from '@worker/client';"
      );
      expect(violations).toHaveLength(0);
    });
  });

  describe('the composition root, src/main.ts', () => {
    // `src/*.ts` is not a layer directory, so no block reached it: the one
    // file that runs on page load was free to generate on the main thread.
    const ROOT_FILE = `src/${THROWAWAY_FILE}`;

    it('rejects a runtime @core/library import', async () => {
      const violations = await lintAtPath(
        ROOT_FILE,
        "import { getPage } from '@core/library';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(
        'generation surface may only be imported as types in @app'
      );
    });

    it('allows a runtime @core/address import', async () => {
      const violations = await lintAtPath(
        ROOT_FILE,
        "import { toLinear } from '@core/address';"
      );
      expect(violations).toHaveLength(0);
    });

    it('rejects a dynamic @core/library import', async () => {
      const violations = await lintAtPath(ROOT_FILE, "void import('@core/library');");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(
        'may not be imported dynamically in @app'
      );
    });
  });

  describe("core's split: the address model is free, generation is @worker's", () => {
    // ADR-0029. Every layer but @worker carries the same restriction, so the
    // table asserts it is attached to each of them rather than to whichever
    // one a single test happened to name. @core is absent: it imports itself.
    const LAYERS_THAT_MUST_NOT_GENERATE = ['engine', 'motion', 'state', 'ui', 'app'];

    for (const layer of LAYERS_THAT_MUST_NOT_GENERATE) {
      it(`rejects a runtime @core/library import in @${layer}`, async () => {
        const violations = await lintInLayer(
          layer,
          "import { getPage } from '@core/library';"
        );
        expect(violations).toHaveLength(1);
        expect(violations[0]?.message).toContain(
          `generation surface may only be imported as types in @${layer}`
        );
      });

      it(`allows a type-only @core/library import in @${layer}`, async () => {
        const violations = await lintInLayer(
          layer,
          "import type { PadMode } from '@core/library';"
        );
        expect(violations).toHaveLength(0);
      });

      it(`allows a runtime @core/address import in @${layer}`, async () => {
        const violations = await lintInLayer(
          layer,
          "import { SHELVES_PER_WALL } from '@core/address';"
        );
        expect(violations).toHaveLength(0);
      });

      it(`rejects a dynamic @core/library import in @${layer}`, async () => {
        // `no-restricted-imports` cannot see this one; the selector can.
        const violations = await lintInLayer(layer, "void import('@core/library');");
        expect(violations).toHaveLength(1);
        expect(violations[0]?.message).toContain(
          `may not be imported dynamically in @${layer}`
        );
      });

      it(`allows a dynamic @core/address import in @${layer}`, async () => {
        const violations = await lintInLayer(layer, "void import('@core/address');");
        expect(violations).toHaveLength(0);
      });

      it(`rejects a dynamic @core/index import in @${layer}`, async () => {
        const violations = await lintInLayer(layer, "void import('@core/index');");
        expect(violations).toHaveLength(1);
        expect(violations[0]?.message).toContain(
          `may not be imported dynamically in @${layer}`
        );
      });

      it(`rejects a runtime @core/index import in @${layer}`, async () => {
        // The barrel re-exports `library`, so a rule phrased on the module
        // alone is defeated by one import statement.
        const violations = await lintInLayer(
          layer,
          "import { getPage } from '@core/index';"
        );
        expect(violations).toHaveLength(1);
        expect(violations[0]?.message).toContain(
          `generation surface may only be imported as types in @${layer}`
        );
      });
    }
  });

  describe("the ways around core's split", () => {
    // Each spelling below reaches the same module, and the two rules divide the
    // work: the gitignore groups hold the canonical `@core` alias, where
    // `allowTypeImports` has to be exact, and regexes hold every relative path
    // and every non-canonical alias spelling. Every case here was found by
    // running `allowed/../forbidden` and its siblings, not by reading patterns.

    const ALIAS = 'import core through its @core alias in @engine';
    const CANONICAL = 'import core by its canonical module path in @engine';
    const DYNAMIC = 'may not be imported dynamically in @engine';

    it('rejects a relative import of the generation surface', async () => {
      const violations = await lintInLayer(
        'engine',
        "import { getPage } from '../core/library';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(ALIAS);
    });

    it('rejects a relative import of the address model too', async () => {
      // Not a generation question: this repository crosses layers through the
      // `@layer/*` aliases, and once a specifier is written that way the group
      // decides whether the module is allowed. Refusing every relative path is
      // what lets the groups cover the alias alone — and what keeps `**/core`,
      // which also matched `@stryker-mutator/core`, out of the config.
      const violations = await lintInLayer(
        'engine',
        "import { toLinear } from '../core/address';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(ALIAS);
    });

    it('rejects a relative import of the core directory, which resolves to the barrel', async () => {
      const violations = await lintInLayer(
        'engine',
        "import { getPage } from '../core';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(ALIAS);
    });

    it('rejects a relative path that escapes upward through an allowed module', async () => {
      // `!@core/address` is a gitignore pattern, so it frees everything *under*
      // a directory of that name. This spelling reached `getPage` from
      // `src/engine` with a clean lint and a clean typecheck, and generated
      // 3200 characters of real page text (ADR-0029).
      const violations = await lintInLayer(
        'engine',
        "import { getPage } from '../core/address/../library';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(ALIAS);
    });

    it('rejects a relative import written from a deeper directory', async () => {
      const violations = await lintInLayer(
        'engine',
        "import { getPage } from '../../src/core/library';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(ALIAS);
    });

    it('rejects a dynamic relative import', async () => {
      const violations = await lintInLayer('engine', "void import('../core/library');");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(ALIAS);
    });

    it('rejects a type-only relative import, which has the alias available too', async () => {
      const violations = await lintInLayer(
        'engine',
        "import type { PadMode } from '../core/library';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(ALIAS);
    });

    it('rejects an alias spelled with a doubled slash', async () => {
      // Vite's alias is a prefix replacement, so `@core//library` resolves; a
      // doubled slash is not a path segment, so `*` never matches it.
      const violations = await lintInLayer(
        'engine',
        "import { getPage } from '@core//library';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(CANONICAL);
    });

    it('rejects an alias that escapes upward through an allowed module', async () => {
      const violations = await lintInLayer(
        'engine',
        "import { getPage } from '@core/address/../library';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(CANONICAL);
    });

    it('rejects the alias with a trailing slash', async () => {
      const violations = await lintInLayer(
        'engine',
        "import { getPage } from '@core/';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(CANONICAL);
    });

    it('names the spelling, not generation, when the module is the address model', async () => {
      // code-style §5: an error message must not misinform. `@core//address` is
      // the address model, which every layer may import at runtime, so a
      // message about the generation surface would be false for this input.
      const violations = await lintInLayer(
        'engine',
        "import type { Address } from '@core//address';"
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(CANONICAL);
      expect(violations[0]?.message).not.toContain('generation surface');
    });

    it('rejects a dynamic import written with backticks', async () => {
      // A no-substitution template literal is a TemplateLiteral, not a Literal,
      // and Rollup resolves it statically: an ordinary specifier, not a
      // computed one.
      const violations = await lintInLayer('engine', 'void import(`@core/library`);');
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(DYNAMIC);
    });

    it('rejects a backtick dynamic import of a relative path', async () => {
      // The spelling rules cover every form, and the backtick form needs its
      // own selector: a TemplateLiteral is not a Literal. Deleting that
      // selector turned no test red until this case existed.
      const violations = await lintInLayer('engine', 'void import(`../core/library`);');
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(ALIAS);
    });

    it('rejects a backtick dynamic import of a non-canonical alias, twice', async () => {
      // This one is both non-canonical and generation, so both selectors fire
      // and it is reported twice. Both messages are true of it and both point
      // at the same fix, so the overlap is left as it is and asserted here
      // rather than contorting a regex to partition them.
      const violations = await lintInLayer('engine', 'void import(`@core//library`);');
      expect(violations).toHaveLength(2);
      const messages = violations.map((v) => v.message).join('\n');
      expect(messages).toContain(CANONICAL);
      expect(messages).toContain(DYNAMIC);
    });

    it('allows a dynamic backtick import of the address model', async () => {
      const violations = await lintInLayer('engine', 'void import(`@core/address`);');
      expect(violations).toHaveLength(0);
    });

    it('leaves the canonical alias spellings alone', async () => {
      const violations = await lintInLayer(
        'engine',
        "import { toLinear } from '@core/address';\nimport { RADIX } from '@core/bignum';"
      );
      expect(violations).toHaveLength(0);
    });

    it('allows a type-only use of the generation surface through import()', async () => {
      // `typeof import(...)` is a TSImportType, not an ImportExpression: a type
      // costs nothing at runtime, so the selectors must not reach it.
      const violations = await lintInLayer(
        'engine',
        'export type Page = typeof import("@core/library").getPage;'
      );
      expect(violations).toHaveLength(0);
    });

    it('allows a package whose last segment is core', async () => {
      // `@stryker-mutator/core` is a devDependency of this repository. The
      // gitignore group that used to cover relative paths had to be `**/core`,
      // which matched it and refused it with a message about page generation —
      // false in every clause (code-style §5). Relative paths moved to a regex
      // that can tell the two apart, so the group covers the alias alone.
      for (const specifier of ['@stryker-mutator/core', '@babel/core']) {
        const violations = await lintInLayer(
          'engine',
          `import pkg from '${specifier}';\nexport const x = pkg;`
        );
        expect(violations, specifier).toHaveLength(0);
      }
    });

    it('does not refuse a dynamic three import in @motion — a recorded gap', async () => {
      // The second rule matches core specifiers only, so the dynamic form of
      // every other refusal is still open. ADR-0029's residue list says so, and
      // this pins it: close the gap and this test goes red, which is the prompt
      // to update the record rather than let the two drift.
      const violations = await lintInLayer('motion', "void import('three');");
      expect(violations).toHaveLength(0);
    });

    it('holds @worker to the spelling, though it may generate', async () => {
      const refused = await lintInLayer(
        'worker',
        "import { getPage } from '@core//library';"
      );
      expect(refused).toHaveLength(1);
      expect(refused[0]?.message).toContain('canonical module path in @worker');

      const allowed = await lintInLayer(
        'worker',
        "import { getPage } from '@core/library';"
      );
      expect(allowed).toHaveLength(0);
    });
  });
});
