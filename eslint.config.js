import js from '@eslint/js';
import typescriptEslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default typescriptEslint.config(
  {
    ignores: [
      'dist',
      'dist-ssr',
      'coverage',
      'node_modules',
      '*.local',
      'e2e/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  // Source files use strict type checking
  ...typescriptEslint.configs.strictTypeChecked.map(cfg => ({
    ...cfg,
    files: cfg.files ? (Array.isArray(cfg.files) ? cfg.files : [cfg.files]) : ['src/**/*.ts'],
  })),
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
  },
  // Exclude test files from strict checking
  {
    files: ['src/**/*.test.ts', 'src/**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },
  // Config files use basic JS rules only, not strict type checking
  {
    files: ['eslint.config.js', 'vite.config.ts', 'vite.aliases.ts', 'playwright.config.ts', 'commitlint.config.js'],
  },
  // @core layer: nothing but types from other layers, no three, no gsap
  {
    files: ['src/core/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['three'],
              message: 'three is not allowed in @core layer',
              allowTypeImports: true,
            },
            {
              group: ['gsap'],
              message: 'gsap is not allowed in @core layer',
              allowTypeImports: true,
            },
            {
              group: ['@worker/*', '@engine/*', '@motion/*', '@state/*', '@ui/*', '@app/*'],
              message: 'other layers may only be imported as types in @core',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  // @motion layer: can import gsap, no three at runtime, can import types from three
  {
    files: ['src/motion/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['three'],
              message: 'three may only be imported as types in @motion layer',
              allowTypeImports: true,
            },
            {
              group: ['@worker/*', '@engine/*', '@state/*', '@ui/*', '@app/*'],
              message: 'other layers may only be imported as types in @motion',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  // @engine layer: can import three, no @ui, no gsap
  {
    files: ['src/engine/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['gsap'],
              message: 'gsap is not allowed in @engine layer',
              allowTypeImports: true,
            },
            {
              group: ['@ui/*'],
              message: '@ui is not allowed in @engine layer',
              allowTypeImports: true,
            },
            {
              group: ['@worker/*', '@motion/*', '@state/*', '@app/*'],
              message: 'other layers may only be imported as types in @engine',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  // @ui layer: no three, core only through @worker client
  {
    files: ['src/ui/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['three'],
              message: 'three is not allowed in @ui layer',
              allowTypeImports: true,
            },
            {
              group: ['@core/*', '@worker/*', '@engine/*', '@motion/*', '@state/*', '@app/*'],
              message: 'other layers may only be imported as types in @ui',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  // @worker layer: core is allowed at runtime (only place)
  {
    files: ['src/worker/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@engine/*', '@ui/*', '@app/*'],
              message: 'other layers may only be imported as types in @worker',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  eslintConfigPrettier,
);
