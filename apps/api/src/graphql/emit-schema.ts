/**
 * Entry point of `pnpm --filter @job-scraper/api schema:generate`.
 *
 * Refreshes `apps/api/src/schema.gql` from the decorators of the API_Service, offline: no
 * environment file, no Posting_Store, no listener. The Web_App's `codegen` task depends on this
 * one in the Turborepo graph, so the generated hooks can never be produced from a schema that
 * predates a resolver change.
 *
 * Run as a compiled script (`node dist/graphql/emit-schema.js`) rather than through a TypeScript
 * runner: the schema is built from `emitDecoratorMetadata` output, which only `tsc` produces, and
 * the package has no TypeScript loader among its dependencies.
 */

import 'reflect-metadata';

import { writeSchemaFile } from './schema-file';
import { SCHEMA_FILE_PATH } from './schema-options';

export async function emitSchema(): Promise<void> {
  const { schema, resolvers } = await writeSchemaFile();

  const rootTypes = [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()];

  const rootFieldSummary = rootTypes
    .filter((rootType) => rootType != null)
    .map((rootType) => `${rootType.name} ${Object.keys(rootType.getFields()).length}`)
    .join(', ');

  console.log(
    `Wrote ${SCHEMA_FILE_PATH} from ${resolvers.length} resolvers (${rootFieldSummary} fields)`,
  );
}

/**
 * Only run when this file is the entry point. The schema test imports from `./schema-file`, and an
 * import must not write a file.
 */
if (require.main === module) {
  emitSchema().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
