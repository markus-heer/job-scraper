import js from '@eslint/js';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Paths that are generated and therefore never linted: the Prisma client output, the GraphQL code-first
 * schema, the generated TanStack router tree and the generated GraphQL hooks, plus build and test artefacts.
 */
export const generatedAndBuildPaths = [
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/node_modules/**',
  '**/.turbo/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/generated/**',
  '**/__generated__/**',
  '**/*.gen.ts',
  '**/*.generated.ts',
  '**/schema.gql',
];

/**
 * Shared flat config for every workspace package.
 *
 * Two conventions are enforced here rather than left to review:
 * - imports and exports are sorted by `simple-import-sort`, so an import block never causes a merge conflict
 *   over ordering;
 * - `any` is an error. The escape hatches the design allows (Playwright DOM evaluation results, raw
 *   AI_Provider JSON) use `unknown` plus a Zod parse, which this rule permits.
 */
export const baseConfig = tseslint.config(
  { ignores: generatedAndBuildPaths },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
    plugins: { 'simple-import-sort': simpleImportSort },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',

      // The `any` ban. `unknown` is the intended replacement.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      '@typescript-eslint/no-wrapper-object-types': 'error',

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
      'no-var': 'error',
      'object-shorthand': ['error', 'properties'],
      'prefer-const': 'error',
    },
  },
);

export default baseConfig;
