/**
 * Writing `apps/api/src/schema.gql` without starting the API_Service.
 *
 * The schema is the contract between the two apps: the API_Service generates it from its decorators
 * (code-first, never hand-edited) and the Web_App's code generator reads it to produce typed hooks.
 * Until this file existed, only a booting API_Service could refresh it, so a stale schema turned
 * into silently missing hooks — a `type Mutation` absent from the file produces a generated client
 * without a single mutation, and nothing fails while that is the case.
 *
 * What is reproduced here is exactly what `GraphQLSchemaBuilder` does for `autoSchemaFile`: build
 * the schema with `GraphQLSchemaFactory` from the same `GRAPHQL_BUILD_SCHEMA_OPTIONS` the
 * `GraphQLModule.forRoot` call in `app.module.ts` passes, sort it lexicographically (`sortSchema:
 * true` there), prefix Nest's own "do not modify" header and write it to `SCHEMA_FILE_PATH`. The
 * resolver classes come from the module graph of `AppModule` (see `./resolver-discovery.ts`), and
 * `GraphQLSchemaFactory` reads their decorator metadata without constructing them.
 *
 * Consequence worth stating: generation needs neither the environment file nor the Posting_Store.
 * `pnpm --filter @job-scraper/api schema:generate` runs on a fresh clone with no container up, which
 * is what lets the Web_App's `codegen` task depend on it in the Turborepo graph.
 */

import { writeFile } from 'node:fs/promises';

import { NestFactory } from '@nestjs/core';
import {
  GRAPHQL_SDL_FILE_HEADER,
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
} from '@nestjs/graphql';
import { type GraphQLSchema, lexicographicSortSchema, printSchema } from 'graphql';

import { AppModule } from '../app.module';
import { discoverResolverClasses, type ResolverClass } from './resolver-discovery';
import { GRAPHQL_BUILD_SCHEMA_OPTIONS, SCHEMA_FILE_PATH } from './schema-options';

/** The result of a schema build, with the resolvers it was built from. */
export interface GeneratedSchema {
  readonly schema: GraphQLSchema;
  readonly resolvers: readonly ResolverClass[];
}

/**
 * Builds the schema the API_Service serves.
 *
 * The temporary application context holds Nest's schema factory and nothing else — the
 * `GraphQLSchemaBuilderModule` is the library's own module for this purpose — and is closed again
 * before returning, so no handle is left behind when this runs inside a test file.
 */
export async function buildGeneratedSchema(): Promise<GeneratedSchema> {
  const resolvers = discoverResolverClasses(AppModule);
  const context = await NestFactory.createApplicationContext(GraphQLSchemaBuilderModule, {
    logger: false,
  });

  try {
    const schema = await context
      .get(GraphQLSchemaFactory)
      // The factory accepts the resolver classes it reads metadata from; `ResolverClass` is
      // deliberately `abstract new`, which the library's own `Function[]` parameter accepts.
      .create([...resolvers], GRAPHQL_BUILD_SCHEMA_OPTIONS);

    return { schema, resolvers };
  } finally {
    await context.close();
  }
}

/**
 * Renders the SDL file content for a schema, byte-identical to what Nest writes at startup.
 *
 * Three details have to match, or every generation would produce a diff: Nest's header comment,
 * the lexicographic sort (`sortSchema: true` in `app.module.ts`) and the absence of a trailing
 * newline (`addNewlineAtEnd` is not set). Every `schema.gql` is listed in `.prettierignore`, so no
 * formatter disagrees with the last one.
 */
export function renderSchemaFile(schema: GraphQLSchema): string {
  return GRAPHQL_SDL_FILE_HEADER + printSchema(lexicographicSortSchema(schema));
}

/** Builds the schema and writes it to `apps/api/src/schema.gql`. */
export async function writeSchemaFile(): Promise<GeneratedSchema> {
  const generated = await buildGeneratedSchema();

  await writeFile(SCHEMA_FILE_PATH, renderSchemaFile(generated.schema), 'utf8');

  return generated;
}
