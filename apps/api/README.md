# @job-scraper/api

The API_Service. At this point the package contains the Posting_Store schema with its migrations and client access
layer, plus the NestJS application skeleton with the code-first GraphQL layer. Configuration validation, the startup
checks and the feature services follow in later tasks.

## NestJS application

`src/main.ts` binds the listener to `127.0.0.1` and nothing else. The Job_Tool runs on a single machine with no
deployment target (1.16), so there is no authentication layer; an endpoint that can start browser automation must
therefore not be reachable from the network. The port comes from `API_PORT` with a fallback to 4000 — a placeholder
until task 5.2 replaces it with the Zod configuration schema that reports every missing or invalid key by name and exits
non-zero (1.15).

`src/app.module.ts` wires the code-first GraphQL module at `/graphql`. Feature modules are added here as the later tasks
bring them.

Start the built application with `pnpm start` after `pnpm build`; the Start_Script does the same in its step 6.

## GraphQL schema

`src/schema.gql` is generated: Nest writes it from the resolver and model decorators every time the application starts.
It is never hand-edited, which is why it sits in `.prettierignore` and in the shared ESLint ignore list. The Web_App's
code generator reads this file, so it is tracked in Git and does not require a running API_Service.

### Refreshing it without starting the application

`pnpm schema:generate` (after `pnpm build`) rewrites the file offline — no environment file, no Posting_Store, no
listener:

- `src/graphql/resolver-discovery.ts` walks the module graph of `AppModule` through decorator metadata and collects
  every `@Resolver()` class. Nothing is constructed and no lifecycle hook runs, so the walk is free of side effects.
  Deriving the set from the module graph rather than from a hand-kept list is what makes a newly added resolver appear
  in the schema without a second place to remember.
- `src/graphql/schema-file.ts` builds the schema from those classes with the same `GRAPHQL_BUILD_SCHEMA_OPTIONS`
  `app.module.ts` passes to `GraphQLModule.forRoot`, then writes Nest's header, the lexicographically sorted SDL and no
  trailing newline — the exact bytes Nest writes at startup.

`src/graphql/__tests__/schema-file.test.ts` keeps all of that honest: it asserts that resolver discovery finds every
`*.resolver.ts` class in the sources, that the schema carries all nine queries, four mutations and the Log_Stream
subscription, and that the committed `src/schema.gql` equals what the generator produces. A stale schema is therefore a
failing test in `pnpm test`, not a silently incomplete set of hooks in the Web_App.

The Web_App's `codegen` task depends on this script in the Turborepo graph, so `pnpm build`, `pnpm check-types` and
`pnpm test` can never run the frontend against a schema that predates a resolver change.

`src/graphql/domain-enums.ts` derives a GraphQL enum from each of the nine closed value lists of `@job-scraper/domain`.
The domain declares them as `const` tuples, `registerEnumType` wants the object shape a TypeScript string `enum`
compiles to, and the helper there bridges the two — so no value list is typed out a second time. The enums are passed as
`orphanedTypes` as well, because Nest drops a registered enum that no field references yet, and the Web_App needs the
full value lists to render the named states of 2.2.

The only query so far is `health`, which answers `ok`. It is a liveness probe: the Start_Script polls it to confirm the
API_Service is ready before it serves the Web_App. Readiness with a real subject — valid configuration, a reachable
Posting_Store — arrives with tasks 5.2 to 5.5.

## Posting_Store schema

`prisma/schema.prisma` is the single source of truth for the database. Schema changes go through
`pnpm prisma migrate dev --name <change>` only, never through hand-written SQL against a running database, so every
change is a versioned migration that runs exactly once in ascending order and keeps stored data (9.6).

`prisma/migrations/` is tracked. `migration.sql` is generated and never hand-edited — a correction to a schema change is
a new migration, so the ascending order and the "exactly once" guarantee hold on every machine.

Seven models: `JobPosting`, `ScrapeRun`, `ScrapeRunPlatformResult`, `LogMessage`, `CommuteCacheEntry`,
`LocationNormalization` and `Setting`.

Two unique keys carry requirements rather than convenience:

- `JobPosting @@unique([platform, postingId])` is the identity of a Job_Posting (9.2) and the conflict target of the
  upsert (9.3).
- `LogMessage @@unique([runId, sequence])` makes the per-run sequence strictly monotonic in the database, which is what
  the gapless Log_View reload relies on (12.2).

Every other index answers a named query of the design's index rationale table — the default overview predicate, the
Platform filter and sweep, the four sort orders and the lookup of the most recently completed Scrape_Run.
`relevanceRank` is a denormalized sort key because PostgreSQL orders an enum by declaration order, not by the order
Requirement 10.7 prescribes.

## Enum parity

The 9 enums `Platform`, `PlatformStatus`, `PostingStatus`, `InterestFlag`, `RelevanceVerdict`, `RunOutcome`,
`RunStatus`, `CommuteMode` and `CommutePrecision` mirror the closed value lists of `packages/domain/src/enums.ts` member
for member. `LogLevel` and `NormalizationSource` exist only in the database and have no domain counterpart.

## Client access layer

Two files in `src/prisma/`, both small on purpose:

- `prisma.types.ts` is the only import path for the generated client. Repositories, services, resolvers and tests import
  `PrismaClient`, the `Prisma` namespace, the model types and the database enums from here, never from `@prisma/client`.
  The generated client is build output; routing it through one re-export means regenerating it or moving its output
  touches exactly one file.
- `json-types.d.ts` declares the `PrismaJson` namespace that `prisma-json-types-generator` binds the `Json` columns to.
  `ScrapeRunPlatformResult.effectiveProfile` becomes `EffectiveSearchProfileJson` (the effective Search_Profile of one
  Platform in one run, 3.8) and `LogMessage.detail` becomes `LogMessageDetailJson` (structured log context with every
  secret already masked, 14.9). The field vocabulary is not restated there: `Platform`, `CriterionField` and the
  per-field value types come from `@job-scraper/domain`.

The generator is declared after the client generator in `schema.prisma`, because it rewrites the types the client
generator just emitted.

## Generating the client

`postinstall` runs `prisma generate`, so a fresh `pnpm install` leaves a client that matches the schema. That is also
what makes `pnpm check-types` and `pnpm build` work on a fresh clone: both compile against the generated types.

Generated and never hand-edited: the Prisma client output and `prisma/migrations/**/migration.sql`.

## Scripts

| Script                  | Purpose                                                        |
| ----------------------- | -------------------------------------------------------------- |
| `pnpm prisma:format`    | Normalize the schema layout                                    |
| `pnpm prisma:validate`  | Check the schema; needs `DATABASE_URL` in the env              |
| `pnpm prisma:generate`  | Regenerate the Prisma client                                   |
| `pnpm prisma:migrate`   | Create and apply a migration from the current schema           |
| `pnpm prisma:deploy`    | Apply pending migrations without generating one (Start_Script) |
| `pnpm schema:generate`  | Rewrite `src/schema.gql` offline; needs `pnpm build` first     |
| `pnpm check-types`      | `tsc --noEmit` over `src`                                      |
| `pnpm build`            | Emit `dist/` from `src`                                        |
| `pnpm start`            | Run the built application on `127.0.0.1:$API_PORT`             |
| `pnpm lint`             | ESLint with auto-fix                                           |
| `pnpm test`             | Vitest: unit and property tests, no Docker, no network         |
| `pnpm test:integration` | Vitest against a throwaway PostgreSQL container; needs Docker  |

## Integration tests

`*.integration.test.ts` files run only under `pnpm test:integration`, never under `pnpm test`. Each of them calls
`usePostgres()` from `src/testing/postgres-harness.ts`, which starts its own `postgres:16-alpine` container for that
file, applies `prisma migrate deploy` to it and hands the tests a `PrismaService` connected to it. Every table except
Prisma's migration bookkeeping is truncated before each test, so no test sees another's rows.

The development Posting_Store is never touched: the connection string comes from the container, not from `.env`. If no
Docker daemon can be reached, the suite fails with an explicit message instead of falling back to another engine — the
behaviour under test is PostgreSQL's (9.6).

`src/testing/` holds the harness and its seed data. It is type-checked with the sources but excluded from `dist/`,
because it imports devDependencies.

## Local database

The Posting_Store runs in the Compose service at the repository root. `POSTGRES_PORT` chooses the host port when 5432 is
already taken, and `DATABASE_URL` must name the same port:

```sh
POSTGRES_PORT=55432 docker compose up -d --wait postgres
```
