import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ESLint } from 'eslint';
import { writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';

/**
 * The layer rules are enforced by ESLint glob patterns over real file paths
 * under src/<layer>/. To exercise them we write a throwaway file into each
 * layer directory, lint it through the real ESLint Node API, and clean up.
 */
describe('layer boundaries', () => {
  let eslint: ESLint;
  const tempFiles: string[] = [];

  beforeAll(() => {
    eslint = new ESLint({
      baseConfig: undefined,
      overrideConfigFile: './eslint.config.js',
    });
  });

  afterAll(() => {
    for (const file of tempFiles) {
      rmSync(file, { force: true });
    }
  });

  async function lintInLayer(layer: string, code: string) {
    const filePath = resolve(`src/${layer}/__layer_boundary_test__.ts`);
    writeFileSync(filePath, code);
    tempFiles.push(filePath);
    const results = await eslint.lintText(code, { filePath });
    return results[0]?.messages.filter(
      (m) => m.ruleId === '@typescript-eslint/no-restricted-imports'
    ) ?? [];
  }

  describe('@core layer', () => {
    it('rejects a runtime three import', async () => {
      const violations = await lintInLayer('core', "import * as THREE from 'three';");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('three is not allowed in @core layer');
    });

    it('allows a type-only three import', async () => {
      const violations = await lintInLayer('core', "import type { Vector3 } from 'three';");
      expect(violations).toHaveLength(0);
    });

    it('rejects a runtime gsap import', async () => {
      const violations = await lintInLayer('core', "import { gsap } from 'gsap';");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('gsap is not allowed in @core layer');
    });

    it('allows a type-only gsap import', async () => {
      const violations = await lintInLayer('core', "import type { Tween } from 'gsap';");
      expect(violations).toHaveLength(0);
    });

    it('rejects a runtime import from other layers', async () => {
      const violations = await lintInLayer('core', "import { something } from '@ui/index';");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('layers may only be imported as types');
    });

    it('allows a type-only import from other layers', async () => {
      const violations = await lintInLayer('core', "import type { Something } from '@ui/index';");
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
      const violations = await lintInLayer('motion', "import type { Vector3 } from 'three';");
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
      const violations = await lintInLayer('engine', "import { component } from '@ui/index';");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('@ui is not allowed in @engine layer');
    });

    it('allows a type-only @ui import', async () => {
      const violations = await lintInLayer('engine', "import type { Component } from '@ui/index';");
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
      const violations = await lintInLayer('ui', "import type { Vector3 } from 'three';");
      expect(violations).toHaveLength(0);
    });

    it('rejects a runtime @core import', async () => {
      const violations = await lintInLayer('ui', "import { something } from '@core/index';");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('layers may only be imported as types');
    });

    it('allows a type-only @core import', async () => {
      const violations = await lintInLayer('ui', "import type { Something } from '@core/index';");
      expect(violations).toHaveLength(0);
    });
  });

  describe('@worker layer', () => {
    it('allows a runtime @core import', async () => {
      const violations = await lintInLayer('worker', "import { something } from '@core/index';");
      expect(violations).toHaveLength(0);
    });

    it('rejects a runtime @ui import', async () => {
      const violations = await lintInLayer('worker', "import { component } from '@ui/index';");
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('layers may only be imported as types in @worker');
    });

    it('allows a type-only @ui import', async () => {
      const violations = await lintInLayer('worker', "import type { Component } from '@ui/index';");
      expect(violations).toHaveLength(0);
    });
  });
});