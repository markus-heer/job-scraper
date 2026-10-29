import type { CodegenConfig } from '@graphql-codegen/cli';

/**
 * GraphQL Code Generator configuration of the Web_App (10.1).
 *
 * The backend is code-first NestJS: `apps/api/src/schema.gql` is generated from the resolver
 * decorators and is the contract between the two apps. This configuration reads that file and turns
 * every `.graphql` operation under `src` into typed React hooks, so a field that the API_Service
 * does not have, or a variable of the wrong type, is a `pnpm check-types` failure rather than a
 * runtime error in the browser.
 *
 * The schema is read from the file, never from a running server. Generation therefore needs no
 * API_Service, no Posting_Store and no environment file — `pnpm codegen` works on a fresh clone.
 * Keeping that file current is the job of `pnpm --filter @job-scraper/api schema:generate`, which
 * the Turborepo graph runs before this generator (see `turbo.json`).
 *
 * Output layout — every generated file ends in `.generated.ts`, the suffix `.prettierignore` and
 * the shared ESLint ignore list exclude, and none of them is ever hand-edited:
 *
 * - `src/graphql/schema.generated.ts` holds the schema types: every object type, input type, enum
 *   and scalar mapping, once for the whole app.
 * - next to each `<name>.graphql` sits `<name>.generated.ts` with the document, the operation's
 *   result and variable types and its hooks. Operations live next to the component that sends
 *   them, so a route and its data requirement are read together and move together.
 */

/** The generated, never-hand-edited schema of the API_Service. */
const SCHEMA_FILE = '../api/src/schema.gql';

/** Where the shared schema types go; the per-operation files import from here. */
const BASE_TYPES_FILE = 'src/graphql/schema.generated.ts';

/**
 * Header of the schema types file. States what wrote it, from what, and how to refresh it, because
 * the one mistake that is expensive here is editing a generated file by hand and losing the change
 * at the next generation.
 */
const BASE_TYPES_HEADER = [
  '/* eslint-disable */',
  '// GENERATED FILE — do not edit.',
  '//',
  '// Written by GraphQL Code Generator (`pnpm codegen`) from apps/api/src/schema.gql, which the',
  '// API_Service itself generates from its resolver decorators. To change a type here, change the',
  '// resolver or model in apps/api and run `pnpm codegen` again.',
].join('\n');

/**
 * Header of the per-operation files.
 *
 * `@ts-nocheck` is the one concession in this configuration and is deliberately limited to the
 * generated operation files. The hook generator is still on the Apollo Client 3 shape of the
 * `useSuspenseQuery` overloads, which does not type-check against the Apollo Client 4 of this app
 * (TS2394), and it emits a `Types` namespace import that an operation without enum or scalar
 * arguments does not use (TS6133 under `noUnusedLocals`). Both are properties of the generated
 * text, not of the schema: the operations themselves are validated against the schema by the
 * generator, and everything these files export stays fully checked at every call site — which is
 * what `src/graphql/__tests__/generated-hooks.test.ts` asserts, so the suppression cannot quietly
 * widen into the hand-written code.
 */
const OPERATION_HEADER = [
  '/* eslint-disable */',
  '// @ts-nocheck',
  '// GENERATED FILE — do not edit.',
  '//',
  '// Written by GraphQL Code Generator (`pnpm codegen`) from the .graphql operation of the same',
  '// name in this directory and from apps/api/src/schema.gql. To change an operation, edit that',
  '// .graphql file and run `pnpm codegen` again.',
  '//',
  '// @ts-nocheck covers two artefacts of the hook generator, not of this app: the Apollo Client 3',
  '// shape of the useSuspenseQuery overloads, and an unused type-only namespace import. Everything',
  '// exported from here is still type-checked wherever it is used.',
].join('\n');

/**
 * Settings that both outputs need, because the per-operation files reference the types the base
 * types file declares and the two would otherwise disagree.
 *
 * - `useTypeImports` is not optional here: the shared TypeScript config sets
 *   `verbatimModuleSyntax`, under which a type imported with a value import is an error.
 * - `strictScalars` turns an unmapped custom scalar into a failed generation instead of a silent
 *   `any`, which the repository bans. `DateTime` is the one custom scalar the schema has; it is
 *   ISO 8601 text on the wire, so `string` is what arrives in the browser.
 * - `enumsAsTypes` emits string union types rather than TypeScript `enum` objects. The closed value
 *   lists are declared in `packages/domain` and reach the schema from there; a second runtime copy
 *   of them in the browser bundle would be a second place to drift.
 * - `skipTypename` stays off. Apollo Client's cache normalizes by `__typename`, and the
 *   `LogMessage` cache key of the Log_View depends on it.
 */
const SHARED_CONFIG = {
  useTypeImports: true,
  strictScalars: true,
  scalars: { DateTime: 'string' },
  enumsAsTypes: true,
  skipTypename: false,
  dedupeFragments: true,
} as const;

const config: CodegenConfig = {
  schema: SCHEMA_FILE,
  documents: ['src/**/*.graphql'],

  // A generated file is overwritten, never merged into, so nothing of value can be lost by it.
  overwrite: true,

  generates: {
    [BASE_TYPES_FILE]: {
      plugins: [{ add: { content: BASE_TYPES_HEADER } }, 'typescript'],
      config: SHARED_CONFIG,
    },

    src: {
      preset: 'near-operation-file',
      presetConfig: {
        extension: '.generated.ts',

        // Relative to the output directory of this entry (`src`), not to the package root: the
        // preset resolves the import path of each generated file against it.
        baseTypesPath: 'graphql/schema.generated.ts',
      },
      plugins: [
        { add: { content: OPERATION_HEADER } },
        'typescript-operations',
        'typescript-react-apollo',
      ],
      config: {
        ...SHARED_CONFIG,

        /**
         * Apollo Client 4. `reactApolloVersion: 3` selects the modern, hook-based output; the two
         * import overrides then correct where that output imports from, because version 4 moved the
         * React bindings out of the package root into `@apollo/client/react`. `gql` itself stayed
         * in the root.
         */
        reactApolloVersion: 3,
        apolloReactCommonImportFrom: '@apollo/client/react',
        apolloReactHooksImportFrom: '@apollo/client/react',
        gqlImport: '@apollo/client#gql',

        /** Hooks only: no render-prop components, no higher-order components. */
        withHooks: true,
        withComponent: false,
        withHOC: false,

        /**
         * Off because Apollo Client 4 no longer exports the `MutationFunction` type this would
         * reference. The hooks themselves are unaffected — `useStartScrapeRunMutation` returns the
         * mutate function with its own inferred type.
         */
        withMutationFn: false,
      },
    },
  },
};

export default config;
