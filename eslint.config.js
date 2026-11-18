import js from '@eslint/js';
import typescriptEslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

/**
 * The layer rules of `docs/architecture.md` §1, which calls this file the
 * specification and itself the explanation. Every one of the seven layer
 * directories has a block below, and so does the composition root `src/*.ts`.
 * A layer with no block, or a block that leaves a refusal out, is a boundary
 * that reads as enforced and is not (ADR-0029).
 *
 * Two rules carry **`core`'s split**, and only that one. `no-restricted-imports`
 * holds the static import forms of every boundary in this file;
 * `no-restricted-syntax` holds the dynamic `import()` and the non-canonical
 * spellings of `core`'s generation surface, which the first rule cannot reach.
 *
 * Every other refusal here — `three`, `gsap`, `@ui/*` and the cross-layer
 * groups — is held by the static rule alone, so the dynamic form of each is
 * still open: `void import('three')` in `@motion` lints clean today. That gap
 * predates this file's current shape, belongs to all eight blocks, and is
 * recorded in ADR-0029 rather than half-closed. `core`'s split is the one
 * boundary with both rules behind it, because it is the one whose breach costs
 * a frame.
 *
 * `src/__tests__/` deliberately has none. The four files there are the suite's
 * own meta-tests — they read this config, the aliases, the budgets and the
 * built bundles — and holding them to a layer's rule would be holding them to a
 * layer they are not in. The bundle test imports `@core/prf` for `DOMAIN_TAG`,
 * which is the generation surface, and that is the exemption doing its job
 * rather than a hole in it: it asserts where that surface ends up, so it has to
 * be able to name it (ADR-0032).
 *
 * The groups are matched against the import string, gitignore-style, so they
 * are phrased on the `@layer/*` aliases that every import in this repository
 * uses. `core`'s split below is phrased on the relative forms as well, because
 * it is the one boundary whose breach costs a frame rather than a review
 * comment.
 */

/**
 * The modules of `core` that every layer may import at runtime (ADR-0029).
 *
 * Arithmetic on small values: the five-field address and its linearisation,
 * the radix codec, the alphabet tables, the structural constants, the domain
 * errors and the format version. `core` imports nothing and these cost nothing
 * to call, so ADR-0005's argument for the worker thread — a direct `getPage`
 * on the main thread is a dropped frame waiting for the right moment — does
 * not reach them.
 */
const CORE_ADDRESS_MODEL = ['address', 'alphabet', 'bignum', 'errors', 'format'];

// Everything else in `core` is the generation surface: `prf`, `feistel`,
// `library`, and the `index` barrel that re-exports them.
//
// An allow-list rather than those four names, so that a module added to `core`
// tomorrow is refused until someone decides it is address arithmetic -- the safe
// default for the boundary ADR-0005 exists to hold. It covers the barrel by the
// same stroke, which is the point: a group naming `@core/library` alone is
// defeated by an import of `@core/index`, and `src/app/url.ts` was reaching the
// generation module through exactly that route for a constant.
//
// These are gitignore patterns over the import string, and they cover the
// `@core` alias **only**. Every relative spelling is held by a regex below. The
// division is not arbitrary: this syntax cannot anchor "relative paths only", so
// the group that used to cover them had to be `**/core`, which also matched any
// package whose last segment is `core` -- it refused `@stryker-mutator/core`, a
// real devDependency, with a message about page generation. A regex can tell the
// two apart. What gitignore is good at, and the regex is not, is
// `allowTypeImports`: a type costs nothing and the canonical alias form is where
// that exemption has to be exact, so it stays here.
const CORE_GENERATION_SURFACE = [
  '@core/*',
  ...CORE_ADDRESS_MODEL.map((module) => `!@core/${module}`),
];

/**
 * The generation restriction for one layer. Shared rather than copied into the
 * six blocks that carry it, so the list of modules it covers has one home
 * (ADR-0013) and only the layer named in the message changes.
 */
function noRuntimeGeneration(layer) {
  return {
    group: CORE_GENERATION_SURFACE,
    message: `core's generation surface may only be imported as types in ${layer}: only @worker may generate at runtime (ADR-0005). The address model — @core/address, @core/alphabet, @core/bignum, @core/errors, @core/format — is unrestricted (ADR-0029)`,
    allowTypeImports: true,
  };
}

// What `no-restricted-imports` cannot reach. Three regexes, each a different
// claim, so that each can carry a message that is true of what it fires on
// (code-style section 5). A slash is written as its escape throughout, because a
// literal one would end the regex inside an esquery attribute selector.
const SLASH = '\\x2f';

// 1. A relative path that reaches into `core` from anywhere: `../core/library`,
//    `../core/`, `./core/x`, `../../src/core/library`, and the one that escapes
//    upward through an allowed module, `../core/address/../library`. That last
//    one reached `getPage` from `src/engine` with a clean lint and a clean
//    typecheck, because `!@core/address` is a gitignore pattern and frees
//    everything *under* a directory of that name.
//
//    All of them are refused, address model included, because the rule here is
//    about spelling: this repository crosses layers through the `@layer/*`
//    aliases, and once a specifier is written that way the group above decides
//    whether the module is allowed, with `allowTypeImports` handled properly.
//    So this closes the relative route for `core` entirely rather than trying to
//    sort generation from arithmetic a second time.
const CORE_RELATIVE = `^\\.{1,2}${SLASH}(?:[^${SLASH}]+${SLASH})*core(?:${SLASH}.*)?$`;

// 2. The alias spelled non-canonically: `@core//library` (a doubled slash is not
//    a path segment `*` matches) and `@core/address/../library` (the same
//    upward escape, in alias form). Also about spelling, and its message says
//    so -- `@core//address` names the address model, which every layer may
//    import, so a message about the generation surface would be false for it.
const CORE_ODD_SPELLING = `^@core${SLASH}(?:${SLASH}.*|(?:[^${SLASH}]+${SLASH})*\\.\\.(?:${SLASH}.*)?)?$`;

// 3. The alias naming the generation surface, for the dynamic forms only -- the
//    static ones are the group above. `no-restricted-imports` has no
//    `ImportExpression` visitor at all in ESLint 10.9.1, so a dynamic
//    `import('@core/library')` was lint-clean in every layer.
const CORE_GENERATION = `^@core(?:$|${SLASH}(?!(?:${CORE_ADDRESS_MODEL.join('|')})$).*)$`;

// The static import forms whose specifier is a direct `Literal` child, which is
// what the selectors below match on.
//
// `TSImportEqualsDeclaration` is deliberately absent. Its specifier sits under a
// `TSExternalModuleReference`, so `> Literal` can never reach it, and listing it
// would be a selector that looks like enforcement and is not — verified by
// linting `import cl = require('@core//library')`, which reports nothing. What
// refuses that form is `npm run typecheck`: under `module: "ESNext"` it is
// TS1202, and `verify` runs `typecheck` before `lint`. Same asymmetry as the
// bare `@core` alias, recorded the same way in ADR-0029.
const STATIC_IMPORT_FORMS =
  'ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration';

/** Every import form, static and dynamic, as one selector prefix pair. */
function everyFormOf(pattern, message) {
  return [
    {
      selector: `:matches(${STATIC_IMPORT_FORMS}) > Literal[value=/${pattern}/]`,
      message,
    },
    { selector: `ImportExpression > Literal[value=/${pattern}/]`, message },
    {
      selector: `ImportExpression > TemplateLiteral[quasis.0.value.raw=/${pattern}/]`,
      message,
    },
  ];
}

/**
 * How `core` must be spelled, in one layer. Every block carries this, `@core`
 * and `@worker` included: a non-canonical spelling is wrong wherever it appears,
 * and `@worker` being allowed to generate is a question about the module, not
 * about how its path is written.
 *
 * There is no type-only exemption here, deliberately. `import type { X } from
 * '../core/library'` is refused too, because the rule is that cross-layer
 * imports use the alias, and a type import has the same alias available.
 */
function coreSpelling(layer) {
  return [
    ...everyFormOf(
      CORE_RELATIVE,
      `import core through its @core alias in ${layer}: a relative path into another layer is not how this repository crosses layers (ADR-0029)`
    ),
    ...everyFormOf(
      CORE_ODD_SPELLING,
      `import core by its canonical module path in ${layer}: write @core/address, not a doubled slash, a trailing slash, or a path through '..' (ADR-0029)`
    ),
  ];
}

/**
 * The generation restriction for the dynamic forms, in one layer. The static
 * forms are `noRuntimeGeneration` above, which is where `allowTypeImports`
 * lives; `typeof import('@core/library')` is a `TSImportType` rather than an
 * `ImportExpression` and is deliberately not reached, because a type costs
 * nothing.
 *
 * What remains out of reach is a genuinely computed specifier --
 * `import('@core/' + name)`. ADR-0029 records that as residue, not as covered.
 */
function noDynamicGeneration(layer) {
  const message = `core's generation surface may not be imported dynamically in ${layer}: only @worker may generate at runtime (ADR-0005, ADR-0029)`;
  return [
    { selector: `ImportExpression > Literal[value=/${CORE_GENERATION}/]`, message },
    {
      selector: `ImportExpression > TemplateLiteral[quasis.0.value.raw=/${CORE_GENERATION}/]`,
      message,
    },
  ];
}

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
  ...typescriptEslint.configs.strictTypeChecked.map((cfg) => ({
    ...cfg,
    files: cfg.files
      ? Array.isArray(cfg.files)
        ? cfg.files
        : [cfg.files]
      : ['src/**/*.ts', 'scripts/**/*.ts'],
  })),
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
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
    files: [
      'eslint.config.js',
      'vite.config.ts',
      'vite.aliases.ts',
      'playwright.config.ts',
      'commitlint.config.js',
    ],
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
              group: [
                '@worker/*',
                '@engine/*',
                '@motion/*',
                '@state/*',
                '@ui/*',
                '@app/*',
              ],
              message: 'other layers may only be imported as types in @core',
              allowTypeImports: true,
            },
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...coreSpelling('@core')],
    },
  },
  // @worker layer: all of core at runtime — the only layer that may generate
  {
    files: ['src/worker/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['three'],
              message: 'three may only be imported as types in @worker layer',
              allowTypeImports: true,
            },
            {
              group: ['gsap'],
              message: 'gsap may only be imported as types in @worker layer',
              allowTypeImports: true,
            },
            {
              group: ['@engine/*', '@motion/*', '@state/*', '@ui/*', '@app/*'],
              message: 'other layers may only be imported as types in @worker',
              allowTypeImports: true,
            },
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...coreSpelling('@worker')],
    },
  },
  // @engine layer: three and core's address model at runtime, no @ui, no gsap
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
            noRuntimeGeneration('@engine'),
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...coreSpelling('@engine'),
        ...noDynamicGeneration('@engine'),
      ],
    },
  },
  // @motion layer: gsap and core's address model at runtime, no three (ADR-0004)
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
            noRuntimeGeneration('@motion'),
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...coreSpelling('@motion'),
        ...noDynamicGeneration('@motion'),
      ],
    },
  },
  // @state layer: core's address model at runtime, and nothing else
  {
    files: ['src/state/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['three'],
              message: 'three may only be imported as types in @state layer',
              allowTypeImports: true,
            },
            {
              group: ['gsap'],
              message: 'gsap may only be imported as types in @state layer',
              allowTypeImports: true,
            },
            {
              group: ['@worker/*', '@engine/*', '@motion/*', '@ui/*', '@app/*'],
              message: 'other layers may only be imported as types in @state',
              allowTypeImports: true,
            },
            noRuntimeGeneration('@state'),
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...coreSpelling('@state'),
        ...noDynamicGeneration('@state'),
      ],
    },
  },
  // @ui layer: @state, the worker client and core's address model at runtime
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
              group: ['gsap'],
              message: 'gsap may only be imported as types in @ui layer',
              allowTypeImports: true,
            },
            {
              // The client is the whole of @worker that @ui may call. The
              // protocol, the handler, the loop and the barrel that re-exports
              // them are the thread's own business (architecture §1 rule 4).
              group: ['@worker/*', '!@worker/client'],
              message:
                'only @worker/client may be imported at runtime in @ui layer; the rest of @worker is types only',
              allowTypeImports: true,
            },
            {
              group: ['@engine/*', '@motion/*', '@app/*'],
              message: 'other layers may only be imported as types in @ui',
              allowTypeImports: true,
            },
            noRuntimeGeneration('@ui'),
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...coreSpelling('@ui'),
        ...noDynamicGeneration('@ui'),
      ],
    },
  },
  // @app layer and the composition root: everything but generation
  {
    files: ['src/app/**/*.ts', 'src/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          // `src/*.ts` is `src/main.ts`, which composes the layers and is held
          // to @app's rule for that reason. It had no block at all, and it is
          // the one file that runs on page load.
          patterns: [noRuntimeGeneration('@app')],
        },
      ],
      'no-restricted-syntax': [
        'error',
        ...coreSpelling('@app'),
        ...noDynamicGeneration('@app'),
      ],
    },
  },
  eslintConfigPrettier
);
