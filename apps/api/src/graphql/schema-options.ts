/**
 * The GraphQL schema generation settings, in one place.
 *
 * `app.module.ts` hands them to `GraphQLModule.forRoot`, and the schema test builds a schema from
 * the very same values. Keeping them here rather than inline in the module is what makes the test
 * a statement about the schema the API_Service actually serves, not about a second configuration
 * that happens to look similar.
 */

import { join } from 'node:path';

import { type BuildSchemaOptions, type SubscriptionConfig } from '@nestjs/graphql';

import { DOMAIN_ENUM_REFS } from './domain-enums';

/**
 * Where Nest writes the generated schema (design: `apps/api/src/schema.gql`, generated at startup
 * and never hand-edited — it is in `.prettierignore` and in the ESLint ignore list).
 *
 * The path is derived from `__dirname` rather than from `process.cwd()` so that it does not depend
 * on the directory the process was started from. This file sits two levels below the package root
 * in both forms it is loaded in: `src/graphql/schema-options.ts` when type-checked or run by
 * Vitest, and `dist/graphql/schema-options.js` after `tsc`. Both resolve to the same target.
 */
export const SCHEMA_FILE_PATH = join(__dirname, '..', '..', 'src', 'schema.gql');

/** Where the GraphQL endpoint is mounted. The Web_App and the subscriptions share this path. */
export const GRAPHQL_PATH = '/graphql';

export const GRAPHQL_BUILD_SCHEMA_OPTIONS: BuildSchemaOptions = {
  /**
   * The nine domain vocabularies. They are listed as orphaned types because no root field
   * references them yet; a registered enum that nothing references would otherwise be left out of
   * the generated schema.
   */
  orphanedTypes: [...DOMAIN_ENUM_REFS],

  /**
   * Every number the Job_Tool exposes is a count, a duration in whole minutes or a page index, so
   * `Int` is the correct default. `float` would silently widen them.
   */
  numberScalarMode: 'integer',
};

/**
 * The realtime transport of the Log_Stream (12.4).
 *
 * `graphql-ws` only, and nothing else:
 *
 * - it is the protocol Apollo Client speaks, so queries, mutations and the subscription of the
 *   Log_View share one transport and the Web_App has no second connection to configure;
 * - the legacy `subscriptions-transport-ws` stays off. Nest can serve both side by side, but the
 *   older protocol is unmaintained and would open a second WebSocket server for a client the
 *   Job_Tool does not have.
 *
 * The path is the same `/graphql` the HTTP endpoint uses: the WebSocket server runs with
 * `noServer` and takes the upgrade from the HTTP listener, so it inherits the loopback binding of
 * `main.ts` instead of opening a port of its own (1.16).
 */
export const GRAPHQL_SUBSCRIPTION_OPTIONS: SubscriptionConfig = {
  'graphql-ws': { path: GRAPHQL_PATH },
};
