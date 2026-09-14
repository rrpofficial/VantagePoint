// @ts-check
import tseslint from 'typescript-eslint';

/**
 * US-8.1 — layering and strictness enforced at build time.
 *
 * The guard tests in tests/functional/platform/toolchain.spec.ts assert the same
 * invariants from the outside; this config is what makes a violation fail fast in
 * the editor and in CI rather than at test time.
 */

/** Pure domain packages: no I/O, no ambient clock, no infrastructure imports. */
const PURE_DOMAIN = [
  'packages/shared-kernel/src/**',
  'packages/core-domain/src/**',
  'packages/fx-itbr/src/**',
  'packages/tax-engine/src/**',
  'packages/snapshot/src/**',
  'packages/ingestion/src/**',
  'packages/compliance/src/**',
  'packages/pii-masker/src/**',
];

const INFRASTRUCTURE = [
  '@porttrack/persistence',
  '@porttrack/adapters-fx',
  '@porttrack/app-services',
  '@porttrack/platform',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'tests/fixtures/**',
      'eslint.config.js',
      // Build scripts and worker entry points run under plain Node and sit
      // outside the TS project. The KDF worker in particular MUST stay a real
      // .mjs file on disk — a worker is loaded by path at runtime, so it cannot
      // be compiled or bundled away.
      '**/build.mjs',
      '**/kdf-worker.mjs',
      'tests/fixtures/**/*.mjs',
      // Operator tools, run with bare `node` against the built dependencies.
      // `vault:diagnose` in particular must stay runnable from a checkout whose
      // TypeScript has never been compiled — it exists for the case where the
      // application will not start.
      'scripts/*.mjs',
    ],
  },

  ...tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // ADR-002 / DoD D4: escape hatches are defects, not style.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // DoD D6: an empty catch silently swallows a failure.
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },

  {
    name: 'porttrack/pure-domain-boundaries',
    files: PURE_DOMAIN,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...INFRASTRUCTURE.map((name) => ({
              name,
              message:
                'Pure domain packages must not import infrastructure. Inject a port instead (see ARCHITECTURE §4).',
            })),
            {
              name: 'node:fs',
              message: 'Domain packages perform no I/O. Move this to an adapter.',
            },
            {
              name: 'node:child_process',
              message: 'Domain packages perform no I/O. Move this to an adapter.',
            },
          ],
          patterns: [
            { group: ['**/apps/**'], message: 'Domain packages must not depend on applications.' },
          ],
        },
      ],
      // ADR-008: AMBIENT time is banned so snapshots are reproducible. Calendar
      // arithmetic on explicit arguments — `new Date(Date.UTC(y, m, d))` — is
      // deterministic and permitted; only the zero-argument forms read the clock.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Inject the Clock port instead of calling Date.now().',
        },
        {
          selector: 'NewExpression[callee.name="Date"][arguments.length=0]',
          message: 'Inject the Clock port instead of constructing the current date.',
        },
        {
          selector: "CallExpression[callee.name='fetch']",
          message: 'All outbound calls go through the EgressGateway (ADR-010).',
        },
      ],
    },
  },

  {
    name: 'porttrack/api-must-not-mask',
    files: ['apps/api/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/pii-masker/src/regex-rules*', '**/pii-masker/src/ner*'],
              message:
                'ADR-013: masking runs in the browser bundle. The API may import only PiiVerifier.',
            },
          ],
        },
      ],
    },
  },

  {
    name: 'porttrack/tests',
    files: ['**/test/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);
