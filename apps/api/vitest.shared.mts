import { createRequire } from 'node:module';

// `.mts` rather than `.ts`: the API_Service package is CommonJS, because that is what Nest's
// dependency injection and the GraphQL code-first decorators need. The extension tells Vite to load
// this one file as ESM anyway.

const require = createRequire(import.meta.url);

/** Files that need a PostgreSQL container, run by `pnpm test:integration` only. */
export const INTEGRATION_TEST_GLOB = 'src/**/__tests__/**/*.integration.test.ts';

/**
 * One `graphql` instance for the whole test run.
 *
 * The `graphql` package ships both a CommonJS and an ESM build. Nest is CommonJS and `require`s the
 * former; Vite would resolve a test's own `import ... from 'graphql'` to the latter. The two builds
 * are the same version but separate module realms, and every `instanceof`-based helper in the
 * library (`isEnumType`, `printSchema`, …) then rejects a schema that was built by the other realm.
 * Pinning the bare specifier to the CommonJS entry makes both sides share one instance.
 *
 * The `find` is anchored because Vite performs prefix replacement on a string alias, which would
 * corrupt subpath imports such as `graphql/utilities`.
 *
 * Shared by both configurations: the integration tests of task 15.10 build the same Nest module
 * graph as the unit tests, so they need the same single realm.
 */
export const graphqlCommonJsAlias = [
  { find: /^graphql$/, replacement: require.resolve('graphql') },
];
