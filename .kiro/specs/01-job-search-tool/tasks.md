# Implementation Plan: Job Search Tool

## Overview

This plan turns the design into incremental coding steps for the Job_Tool: a local TypeScript monorepo that
retrieves Job_Posting from four Platform with Playwright, stores them in the Posting_Store, enriches them with
a Best_Commute_Time and a Relevance_Verdict, and presents them in a German-language Web_App that is started by
a single Start_Script.

The order follows the dependency structure of the design rather than the order of the requirements document:

1. Repository and tooling foundation, so that `format`, `lint`, `check-types`, `build` and `test` exist from
   the first commit.
2. `packages/domain` as the single place that declares the closed value lists, the Search_Profile types and
   the compile-time safe Platform_Override typing, followed by the pure Profile_Resolver with its four
   property-based tests.
3. Posting_Store foundation (Docker, `schema.prisma`, first migration, enum parity) and the NestJS API_Service
   skeleton with GraphQL code-first and fail-fast startup validation.
4. Log_Stream, the scheduling and etiquette primitives, the Platform_Adapter interface and the pure
   normalization layer — all testable without a network.
5. Stepstone and Jobvector adapters first, because the Risk Assessment rates them as the most accessible.
6. Persistence (upsert, status sweep), then the ScrapeRunCoordinator and Scraper_Service, then the two
   enrichment stages (Commute_Service, Relevance_Service), then the GraphQL read layer.
7. Web_App skeleton, posting overview, Log_View, read-only criteria view, Start_Script, E2E and accessibility
   checks, Steering_Docs.
8. Glassdoor and Indeed adapters as optional, best-effort work, followed by the final quality gate run.

Every task writes code, tests or documentation files inside this repository. Each task leaves the workspace in
a state where `pnpm check-types`, `pnpm build` and `pnpm test` still pass. Language convention per Requirement
16.8: the repository, the identifiers, the comments and all documents are English; only the Web_App strings,
the Start_Script console output and every Relevance_Reason are German.

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1.1"], "dependsOn": [] },
    { "wave": 2, "tasks": ["1.2", "1.3", "1.4"], "dependsOn": ["1.1"] },
    { "wave": 3, "tasks": ["2.1", "4.1"], "dependsOn": ["1.2", "1.3", "1.4"] },
    { "wave": 4, "tasks": ["2.2", "4.2"], "dependsOn": ["2.1", "4.1"] },
    { "wave": 5, "tasks": ["2.3", "2.4", "4.3"], "dependsOn": ["2.2", "4.2"] },
    {
      "wave": 6,
      "tasks": ["2.5", "3.1", "4.4"],
      "dependsOn": ["2.3", "2.4", "4.3"]
    },
    { "wave": 7, "tasks": ["3.2", "5.1"], "dependsOn": ["2.5", "3.1", "4.4"] },
    {
      "wave": 8,
      "tasks": [
        "3.3",
        "3.4",
        "3.5",
        "3.6",
        "3.7",
        "5.2",
        "5.3",
        "7.1",
        "7.2",
        "7.3"
      ],
      "dependsOn": ["3.2", "5.1"]
    },
    {
      "wave": 9,
      "tasks": ["5.4", "5.5", "6.1", "7.4", "7.5", "8.1", "8.2", "8.3"],
      "dependsOn": [
        "3.3",
        "3.4",
        "3.5",
        "3.6",
        "3.7",
        "5.2",
        "5.3",
        "7.1",
        "7.2",
        "7.3"
      ]
    },
    {
      "wave": 10,
      "tasks": ["5.6", "6.2", "6.3", "8.4", "8.5", "8.6", "11.1"],
      "dependsOn": ["5.4", "5.5", "6.1", "7.4", "7.5", "8.1", "8.2", "8.3"]
    },
    {
      "wave": 11,
      "tasks": ["6.4", "6.5", "6.6", "8.7", "8.8", "9.1", "10.1", "11.2"],
      "dependsOn": ["5.6", "6.2", "6.3", "8.4", "8.5", "8.6", "11.1"]
    },
    {
      "wave": 12,
      "tasks": ["9.2", "10.2", "11.3", "11.7"],
      "dependsOn": ["6.4", "6.5", "6.6", "8.7", "8.8", "9.1", "10.1", "11.2"]
    },
    {
      "wave": 13,
      "tasks": ["9.3", "9.4", "10.3", "10.4", "11.4", "11.5", "11.6", "12.1"],
      "dependsOn": ["9.2", "10.2", "11.3", "11.7"]
    },
    {
      "wave": 14,
      "tasks": ["9.5", "10.5", "12.2", "12.3", "12.5"],
      "dependsOn": [
        "9.3",
        "9.4",
        "10.3",
        "10.4",
        "11.4",
        "11.5",
        "11.6",
        "12.1"
      ]
    },
    {
      "wave": 15,
      "tasks": ["12.4", "13.1", "14.1"],
      "dependsOn": ["9.5", "10.5", "12.2", "12.3", "12.5"]
    },
    {
      "wave": 16,
      "tasks": ["12.6", "12.7", "12.8", "13.2", "13.3", "14.2"],
      "dependsOn": ["12.4", "13.1", "14.1"]
    },
    {
      "wave": 17,
      "tasks": ["12.9", "13.4", "14.3", "15.1"],
      "dependsOn": ["12.6", "12.7", "12.8", "13.2", "13.3", "14.2"]
    },
    {
      "wave": 18,
      "tasks": ["12.10", "13.5", "14.4", "15.2"],
      "dependsOn": ["12.9", "13.4", "14.3", "15.1"]
    },
    {
      "wave": 19,
      "tasks": ["13.6", "13.7", "13.8", "14.5", "14.6", "15.3"],
      "dependsOn": ["12.10", "13.5", "14.4", "15.2"]
    },
    {
      "wave": 20,
      "tasks": ["13.9", "14.7", "14.8", "14.9", "15.4", "16.1"],
      "dependsOn": ["13.6", "13.7", "13.8", "14.5", "14.6", "15.3"]
    },
    {
      "wave": 21,
      "tasks": ["14.10", "15.5", "15.6", "15.7", "16.2", "16.3"],
      "dependsOn": ["13.9", "14.7", "14.8", "14.9", "15.4", "16.1"]
    },
    {
      "wave": 22,
      "tasks": ["15.8", "15.9", "15.10", "16.4", "16.5"],
      "dependsOn": ["14.10", "15.5", "15.6", "15.7", "16.2", "16.3"]
    },
    {
      "wave": 23,
      "tasks": ["16.6", "17.1", "18.1", "19.1", "20.1", "22.1"],
      "dependsOn": ["15.8", "15.9", "15.10", "16.4", "16.5"]
    },
    {
      "wave": 24,
      "tasks": ["17.2", "17.3", "18.2", "19.2", "20.2", "22.2"],
      "dependsOn": ["16.6", "17.1", "18.1", "19.1", "20.1", "22.1"]
    },
    {
      "wave": 25,
      "tasks": ["17.4", "17.5", "18.3", "19.3", "20.3", "22.3"],
      "dependsOn": ["17.2", "17.3", "18.2", "19.2", "20.2", "22.2"]
    },
    {
      "wave": 26,
      "tasks": ["17.6", "17.7", "18.4", "20.4", "22.4", "22.5"],
      "dependsOn": ["17.4", "17.5", "18.3", "19.3", "20.3", "22.3"]
    },
    {
      "wave": 27,
      "tasks": ["21.1"],
      "dependsOn": ["17.6", "17.7", "18.4", "20.4", "22.4", "22.5"]
    },
    { "wave": 28, "tasks": ["21.2", "21.3"], "dependsOn": ["21.1"] },
    {
      "wave": 29,
      "tasks": ["21.4", "21.5", "23.1", "24.1"],
      "dependsOn": ["21.2", "21.3"]
    },
    {
      "wave": 30,
      "tasks": ["23.2", "23.3", "24.2", "24.3"],
      "dependsOn": ["21.4", "21.5", "23.1", "24.1"]
    },
    {
      "wave": 31,
      "tasks": ["23.4", "24.4"],
      "dependsOn": ["23.2", "23.3", "24.2", "24.3"]
    },
    { "wave": 32, "tasks": ["25.1"], "dependsOn": ["23.4", "24.4"] },
    { "wave": 33, "tasks": ["25.2"], "dependsOn": ["25.1"] }
  ]
}
```

## Tasks

- [x] 1. Monorepo foundation and tooling
  - [x] 1.1 Initialize the Turborepo workspace root
    - Create `package.json` with `packageManager: pnpm`, `pnpm-workspace.yaml` covering `apps/*` and
      `packages/*`, and the empty `apps/` and `packages/` directories
    - Add `turbo.json` with the task graph `check-types` and `test` depending on `^build`, and `build`
      depending on `^build`
    - Add root scripts `format`, `lint`, `check-types`, `build`, `test`, `test:e2e`, where `test` runs
      `vitest --run` so no watcher is ever started
    - _Requirements: 1.16, 16.4_
  - [x] 1.2 Create the shared TypeScript and ESLint config packages
    - `packages/typescript-config` with a strict base config (`strict: true`, no implicit `any`) plus
      library, Nest and React variants, referenced by every workspace package
    - `packages/eslint-config` as a flat config (`eslint.config.mjs`) with `eslint-plugin-simple-import-sort`
      and a rule that bans `any`
    - _Requirements: 16.4_
  - [x] 1.3 Add Prettier and wire the quality gate order
    - Root Prettier config with single quotes and trailing commas, plus `.prettierignore` that excludes
      generated files (`schema.gql`, `routeTree.gen.ts`, Prisma client output)
    - Verify the gate order format → lint → check-types → build → test runs on the empty workspace
    - _Requirements: 16.4_
  - [x] 1.4 Add `.env.example` and `.gitignore`
    - `.env.example` with every key the design names (`DATABASE_URL`, `HOME_ADDRESS`,
      `COMMUTE_THRESHOLD_MINUTES`, `ROUTING_PROVIDER`, `ROUTING_API_KEY`, `ANTHROPIC_API_KEY`,
      `ANTHROPIC_MODEL`, `RELEVANCE_ENABLED`, `RELEVANCE_CONCURRENCY`, `RELEVANCE_MAX_PER_RUN`,
      `ENRICHMENT_GRACE_MINUTES`, `USER_AGENT_CONTACT`, `API_PORT`, `WEB_PORT`) as placeholders without real
      secrets
    - `.gitignore` excluding `.env`, `node_modules`, build output, Playwright artefacts
    - _Requirements: 1.12, 14.9_

- [x] 2. `packages/domain` foundation: closed vocabularies and typed criteria
  - [x] 2.1 Declare every closed value list once
    - `packages/domain/src/enums.ts` with `PLATFORMS`, `PLATFORM_STATUSES` (all 14 values),
      `POSTING_STATUSES`, `INTEREST_FLAGS`, `RELEVANCE_VERDICTS`, `RUN_OUTCOMES`, `RUN_STATUSES`,
      `COMMUTE_MODES`, `COMMUTE_PRECISIONS` as `const` tuples with derived union types
    - Add `RELEVANCE_RANK` mapping the verdicts onto the sort order relevant < uncertain < not assessed <
      not relevant
    - _Requirements: 4.7, 7.4, 9.1, 10.7, 11.1, 15.14_
  - [x] 2.2 Define the Search_Profile types and the Platform capability declaration
    - `packages/domain/src/search-profile/types.ts` with `SearchProfile`, `CriterionField`,
      `EMPLOYMENT_TYPES`, `PlatformCapability`, `definePlatformCapability` (const type parameters) and
      `PlatformOverrideFor`
    - `PlatformOverrideMap` maps each Platform to `Partial<Pick<SearchProfile, SupportedFields[number]>>`
    - _Requirements: 4.1, 4.2, 4.5_
  - [x] 2.3 Declare the criteria constants
    - `packages/domain/src/search-profile/capabilities.ts` with `PLATFORM_CAPABILITIES` for all four Platform
      including their mandatory fields
    - `packages/domain/src/search-profile/constants.ts` with `DEFAULT_SEARCH_PROFILE` (job title
      "Projektmanagerin", at least the four required synonyms, industry "Pharma and Life Science", search
      location "München", radius 50, employment type, publication period), `PLATFORM_ACTIVATION` and
      `PLATFORM_OVERRIDES`
    - Export the public surface from `packages/domain/src/index.ts`
    - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.6_
  - [x] 2.4 Implement the content hash helper
    - `packages/domain/src/hash/content-hash.ts` with `computeContentHash(title, descriptionText)`: SHA-256
      hex over NFC-normalized, whitespace-collapsed title and description joined by a NUL separator
    - _Requirements: 15.5, 15.6_
  - [x] 2.5 Write the negative type test and the vocabulary unit tests
    - `packages/domain/__tests__/override-typing.test.ts` asserting with `@ts-expect-error` that a
      Platform_Override setting an unsupported Criterion_Field fails the type check, and that a mandatory
      field outside `supportedFields` is rejected
    - Unit tests for the tuple/union parity, `RELEVANCE_RANK` totality over `RELEVANCE_VERDICTS`, and content
      hash stability (whitespace reflow) versus sensitivity (changed title)
    - _Requirements: 4.5, 10.7, 15.5_

- [x] 3. Profile_Resolver and Default_Search_Profile validation
  - [x] 3.1 Implement the Profile_Resolver as a pure function
    - `packages/domain/src/search-profile/profile-resolver.ts` with `resolveSearchProfile`,
      `effectiveProfilesEqual` and `formatEffectiveProfile`
    - Override value wins per field, Default_Search_Profile fills the rest, each result criterion carries
      provenance `OVERRIDE` or `DEFAULT`, criteria are emitted in `supportedFields` order, unresolved
      mandatory fields return an error naming the Platform and every missing field
    - _Requirements: 5.1, 5.2, 5.3, 5.8_
  - [x] 3.2 Build the fast-check arbitraries for the criteria types
    - `packages/domain/src/testing/arbitraries.ts` with generators for a valid `SearchProfile`, a partial
      profile with randomly removed keys, and a Platform_Override over a random subset of a Platform's
      supported fields that also reports which keys it set
    - _Requirements: 5.4, 5.5_
  - [x] 3.3 Write the property test for resolution totality and support
    - **Property 1: Profile resolution is total over the supported fields**
    - **Validates: Requirements 5.1, 5.4, 5.7**
    - _Requirements: 5.1, 5.4, 5.7_
  - [x] 3.4 Write the property test for determinism and idempotence
    - **Property 2: Profile resolution is deterministic and idempotent**
    - **Validates: Requirements 5.5**
    - _Requirements: 5.5_
  - [x] 3.5 Write the property test for provenance
    - **Property 3: Every resolved value carries a correct provenance**
    - **Validates: Requirements 3.4, 4.3, 4.4, 5.2, 5.3, 5.6**
    - _Requirements: 3.4, 4.3, 4.4, 5.2, 5.3, 5.6_
  - [x] 3.6 Write the property test for unresolvable mandatory fields
    - **Property 4: Unresolvable mandatory fields produce a naming error and no profile**
    - **Validates: Requirements 4.8, 5.8**
    - _Requirements: 4.8, 5.8_
  - [x] 3.7 Implement `validateDefaultSearchProfile` with its unit tests
    - `packages/domain/src/search-profile/validate.ts` returning one issue per violation with a German
      message naming the permitted range and a stable English code
    - Enforce: job title, industry, search location non-empty and at most 100 characters; radius integer 1 to
      200; 4 to 20 synonyms of 2 to 100 characters; publication period integer 1 to 365
    - Unit tests for the valid profile and for every range violation
    - _Requirements: 3.1, 3.2, 3.5, 3.6_

- [x] 4. Posting_Store foundation: Docker, Prisma schema and enum parity
  - [x] 4.1 Add the PostgreSQL container definition
    - `docker-compose.yml` with PostgreSQL 16, a named volume so stored data survives a restart, a health
      check the Start_Script can probe, and the port from the environment file
    - _Requirements: 1.10, 1.16_
  - [x] 4.2 Write `apps/api/prisma/schema.prisma`
    - All models from the design: `JobPosting`, `ScrapeRun`, `ScrapeRunPlatformResult`, `LogMessage`,
      `CommuteCacheEntry`, `LocationNormalization`, `Setting`
    - All Prisma enums mirroring `packages/domain`, the unique keys `(platform, postingId)` and
      `(runId, sequence)`, and every index from the index rationale table
    - _Requirements: 9.1, 9.2, 11.1, 12.2_
  - [x] 4.3 Create the first migration and the client access layer
    - Generate the initial migration with `pnpm prisma migrate dev --name init`
    - Configure `prisma-json-types-generator`, declare `apps/api/src/prisma/json-types.d.ts` for
      `EffectiveSearchProfileJson` and `LogMessageDetailJson`, and re-export the generated client only through
      `apps/api/src/prisma/prisma.types.ts`
    - Add the `postinstall` hook that regenerates the Prisma client
    - _Requirements: 9.1, 9.6_
  - [x] 4.4 Write the enum parity test
    - `apps/api/src/prisma/__tests__/enum-parity.test.ts` asserting set equality between every
      `packages/domain` tuple and the matching Prisma enum, at compile time via mutual `satisfies` and at
      runtime via set comparison
    - _Requirements: 7.4, 9.1, 11.1, 15.14_

- [x] 5. API_Service skeleton with GraphQL code-first and fail-fast startup
  - [x] 5.1 Bootstrap the NestJS application with Apollo Server
    - `apps/api/src/main.ts` binding to `127.0.0.1` only, `apps/api/src/app.module.ts` with the code-first
      GraphQL module writing `apps/api/src/schema.gql`, and a `health` query
    - Register every domain enum with `registerEnumType` so the generated schema carries the closed value
      lists
    - _Requirements: 1.16, 2.2_
  - [x] 5.2 Implement Zod configuration validation with fail-fast
    - `apps/api/src/config/env.schema.ts` and a config module that parses the environment file at startup,
      prints the names of all missing or empty keys in German and exits non-zero
    - Validate `COMMUTE_THRESHOLD_MINUTES` as an integer from 5 to 240 and `HOME_ADDRESS` as non-empty; seed
      and read the last accepted pair through the `Setting` table so a rejected change retains the previous
      value
    - _Requirements: 1.12, 1.15, 8.10, 8.14, 14.9_
  - [x] 5.3 Add the Prisma module and repository base
    - `apps/api/src/prisma/prisma.module.ts` and `prisma.service.ts` with connect/disconnect lifecycle hooks
    - _Requirements: 9.1_
  - [x] 5.4 Validate the Default_Search_Profile before the listener binds
    - Lifecycle hook calling `validateDefaultSearchProfile`; on issues print every affected Criterion_Field
      with its permitted range in German and exit non-zero
    - On success write the Default_Search_Profile with every Criterion_Field value to the Log_Stream
    - _Requirements: 3.5, 3.6, 3.7_
  - [x] 5.5 Determine the per-Platform configuration state at startup
    - For every activated Platform resolve the effective Search_Profile; on unresolved mandatory fields set
      the Platform_Status `INCOMPLETE_CONFIGURATION`, write a German message with the platform name and the
      missing field names to the Log_Stream and keep serving the remaining Platform
    - Hold the resulting per-Platform state in an injectable singleton that the Scraper_Service and the
      `searchCriteria` query both read
    - _Requirements: 4.8, 4.9, 4.10, 5.8_
  - [x] 5.6 Write unit tests for configuration and startup behaviour
    - Missing key, invalid Commute_Threshold with retained previous value, invalid Default_Search_Profile with
      non-zero exit, one Platform with incomplete configuration while the others stay served
    - _Requirements: 1.15, 3.6, 4.9, 8.14_

- [x] 6. Log_Stream: persistence, sequencing, query and subscription
  - [x] 6.1 Implement `LogStreamService`
    - `apps/api/src/log-stream/log-stream.service.ts` with `emit`, `history`, `stream` and
      `initialiseCounter`
    - One in-memory counter per run initialised from `max(sequence)`, incremented synchronously before the
      persist so sequences stay strictly monotonic and gapless per Scrape_Run
    - Every message carries creation time, run identifier, optional platform name, level, English code and
      German text
    - _Requirements: 12.2, 12.3, 12.4_
  - [x] 6.2 Implement secret masking
    - Mask every value whose key matches `/key|token|secret|authorization/i` and every substring equal to a
      configured API key with a fixed mask, at any nesting depth, before persistence and before publication
    - _Requirements: 14.9_
  - [x] 6.3 Expose the Log_Stream over GraphQL
    - Query `logMessages(runId, afterSequence, limit = 500)` in ascending sequence order and subscription
      `logMessageAdded(runId)` over `graphql-ws`, both resolved through thin resolvers
    - _Requirements: 12.2, 12.4, 12.9_
  - [x] 6.4 Write the property test for sequencing and the gapless client view
    - **Property 22: Log_Stream sequence numbers are strictly monotonic and the client view is gapless**
    - **Validates: Requirements 12.2, 12.3, 12.4, 12.9**
    - _Requirements: 12.2, 12.3, 12.4, 12.9_
  - [x] 6.5 Write the property test for secret masking
    - **Property 15: Secrets never reach the Log_Stream or the Web_App unmasked**
    - **Validates: Requirements 14.9**
    - _Requirements: 14.9_
  - [x] 6.6 Write unit tests for emit and history
    - Emit with and without a platform name, history after a given sequence, limit default of 500, concurrent
      emission keeping `(runId, sequence)` unique
    - _Requirements: 12.2, 12.9_

- [x] 7. Scheduling and etiquette primitives in `packages/scrapers`
  - [x] 7.1 Implement the counting `Semaphore`
    - `packages/scrapers/src/scheduling/semaphore.ts` with `acquire(): Promise<Release>`, instantiated with 4
      permits by the caller, deadlock-free release in a `finally` block
    - _Requirements: 13.9_
  - [x] 7.2 Implement `PlatformQueue` with settle-time pacing
    - One instance per Platform, a single in-flight page request slot, `lastRequestSettledAt` recorded on
      response arrival or abort, and a wait of `max(2000, crawlDelaySeconds * 1000)` measured from settle time
    - _Requirements: 13.2, 13.9, 14.4_
  - [x] 7.3 Implement robots.txt evaluation
    - `packages/scrapers/src/robots/robots.ts` with `evaluateRobots` using `robots-parser` over `fetch` (not
      Playwright), one evaluation per Platform and Scrape_Run cached for that run
    - A fetch above 10 seconds or an unevaluable body yields status `UNAVAILABLE`, which maps to
      Platform_Status "robots.txt unavailable"
    - _Requirements: 14.1, 14.3, 14.4_
  - [x] 7.4 Write the property test for request pacing and retry bounds
    - **Property 11: Request pacing respects the minimum gap and the crawl-delay**
    - **Validates: Requirements 13.2, 13.4, 14.4**
    - _Requirements: 13.2, 13.4, 14.4_
  - [x] 7.5 Write the property test for the concurrency bounds
    - **Property 12: Concurrency bounds hold for every schedule**
    - **Validates: Requirements 13.9, 15.8**
    - _Requirements: 13.9, 15.8_

- [x] 8. Platform_Adapter interface, normalization and Playwright runtime
  - [x] 8.1 Define the uniform adapter interface and the registry
    - `packages/scrapers/src/adapter/types.ts` with `RawJobPosting`, `AdapterLogEvent`, `AdapterContext`,
      `AdapterResult` and `PlatformAdapter`
    - `packages/scrapers/src/registry.ts` exporting `ALL_PLATFORM_ADAPTERS` and
      `apps/api/src/scraper/platform-adapters.provider.ts` exposing it through a Nest multi-injection token,
      so a further Platform_Adapter takes effect by registration only
    - _Requirements: 6.1, 6.6_
  - [x] 8.2 Implement the pure normalization function
    - `packages/scrapers/src/normalize/normalize-posting.ts` with `FIELD_LIMITS` and `normalizePosting`
      producing `ACCEPTED` or `DISCARDED`
    - Truncate title to 200, employer and work location to 150 and description to 10,000 characters; discard a
      Job_Posting whose title, source URL or Posting_Id is missing or whitespace only; mark absent optional
      fields as empty and keep the Job_Posting
    - _Requirements: 6.3, 6.5, 6.8_
  - [x] 8.3 Implement publication date parsing
    - `parsePublicationDate` converting German relative forms ("heute", "gestern", "vor 3 Tagen", "vor einer
      Woche") and ISO dates relative to the Scrape_Run start time with `date-fns` and `date-fns/locale/de`
    - An unparsable non-empty value yields an empty publication date plus a Log_Stream note while the
      Job_Posting is retained
    - _Requirements: 6.4, 6.9_
  - [x] 8.4 Implement the Playwright runtime
    - One headless Chromium per Scrape_Run, one `BrowserContext` per Platform with a fresh storage state, the
      Job_Tool user agent from the environment file (tool name, private-use statement, contact detail, no
      browser imitation), request interception blocking `image`, `font`, `media` and `stylesheet`
    - 30-second per-Result_Page timeout, teardown of every page and context in a `finally` block, and an
      `AbortSignal` listener that closes the browser
    - Never fill or submit a sign-in or registration form and never answer a Captcha
    - _Requirements: 6.2, 7.1, 7.5, 12.7, 13.6, 14.5, 14.6_
  - [x] 8.5 Write the property test for normalization
    - **Property 5: Normalization is total and respects every field limit**
    - **Validates: Requirements 6.3, 6.5, 6.8**
    - _Requirements: 6.3, 6.5, 6.8_
  - [x] 8.6 Write the property test for date parsing
    - **Property 6: Publication date parsing is total and never looks into the future**
    - **Validates: Requirements 6.4, 6.9**
    - _Requirements: 6.4, 6.9_
  - [x] 8.7 Write the property test for the user agent
    - **Property 14: Every outgoing Platform request identifies the Job_Tool unchanged**
    - **Validates: Requirements 14.5**
    - _Requirements: 14.5_
  - [x] 8.8 Write the property test for robots.txt gating
    - **Property 13: robots.txt is fetched once per Platform, before anything else, and gates retrieval**
    - **Validates: Requirements 14.1, 14.2**
    - _Requirements: 14.1, 14.2_

- [x] 9. Stepstone Platform_Adapter
  - [x] 9.1 Implement `StepstoneAdapter`
    - `packages/scrapers/src/adapters/stepstone/index.ts` with `resultListUrl` built from the effective
      Search_Profile and `fetch` reading up to 10 Result_Page through the `PlatformQueue`
    - Emit German progress events per page (pages read, postings found) and return
      `postings`, `platformStatus`, `pagesFetched` and `partialResult`
    - Detect and report `SIGN_IN_REQUIRED`, `PLATFORM_BLOCKED`, `PAGE_LAYOUT_UNKNOWN`, `FETCH_RATE_LIMITED`
      and `PAGE_LIMIT_REACHED`, ending that Platform's retrieval within 5 seconds for a sign-in prompt or a
      Captcha and keeping the Partial_Result
    - _Requirements: 6.1, 6.2, 6.7, 7.2, 7.6, 7.7, 13.3, 13.5_
  - [x] 9.2 Add the fixture capture script and the fixture server
    - `scripts/fixtures-capture.mjs` (`pnpm fixtures:capture --platform stepstone`) performing exactly one
      real retrieval with the production user agent, stripping scripts, styles, tracking pixels and
      identifier-like query parameters, and writing the HTML plus a `captured-at` date
    - A local fixture HTTP server for the adapter tests plus a route that never responds, so the timeout path
      is exercised; the capture script never runs in a test or in CI
    - _Requirements: 6.2, 14.5_
  - [x] 9.3 Write the Stepstone parser tests against frozen fixtures
    - Fixtures `result-list-page-1`, `result-list-page-2`, `result-list-empty`, `layout-changed`,
      `sign-in-wall`, `captcha`, `rate-limited`, `relative-dates` with their expected `RawJobPosting[]` and
      expected Platform_Status
    - Assert pagination, the 2-second gap between page requests, the 10-page limit, discarding of postings
      without title, source URL or Posting_Id, and at most three attempts per Result_Page
    - _Requirements: 6.3, 6.5, 6.7, 6.10, 7.2, 7.6, 13.2, 13.3, 13.4, 13.8_
  - [x] 9.4 Write `docs/adapters/stepstone.md`
    - Source URL of the retrieved result list, retrieval scope with the retrieved paths, maximum pages per
      Scrape_Run, respected waiting time and the ISO 8601 date of the last terms-of-use review
    - _Requirements: 14.7_
  - [x] 9.5 Add the opt-in live smoke test _(optional)_
    - `live.smoke.test.ts` tagged `@live`, run only through `pnpm test:live`, performing exactly one real page
      retrieval and asserting either at least one readable Job_Posting or one of the permitted blocking
      Platform_Status values; excluded from `pnpm test` and from CI
    - _Requirements: 6.2, 7.6_

- [x] 10. Jobvector Platform_Adapter
  - [x] 10.1 Implement `JobvectorAdapter`
    - Same uniform interface and status detection as Stepstone, using the Jobvector capability declaration
      (industry supported, only job title mandatory)
    - _Requirements: 6.1, 6.2, 6.7, 7.2, 7.6, 7.7, 13.3, 13.5_
  - [x] 10.2 Capture the Jobvector fixtures
    - The same eight fixture cases through `pnpm fixtures:capture --platform jobvector`
    - _Requirements: 6.2, 14.5_
  - [x] 10.3 Write the Jobvector parser tests against frozen fixtures
    - Normalization, pagination, relative dates, sign-in, Captcha, layout change and rate-limit cases
    - _Requirements: 6.3, 6.4, 6.5, 6.7, 7.2, 7.6, 13.3_
  - [x] 10.4 Write `docs/adapters/jobvector.md`
    - Same content as the Stepstone documentation file including the review date
    - _Requirements: 14.7_
  - [x] 10.5 Add the opt-in live smoke test _(optional)_
    - One real page retrieval behind the `@live` tag, excluded from `pnpm test` and from CI
    - _Requirements: 6.2, 7.6_

- [x] 11. PostingRepository: upsert, status sweep and write failure handling
  - [x] 11.1 Implement the upsert path
    - `apps/api/src/posting/posting.repository.ts` with `upsert` on the unique key
      `(platform, trim(postingId))`, returning `created` and `contentChanged`
    - Overwrite title, employer, work location, publication date, source URL and description text; set the
      last sighting to the Scrape_Run start time; leave the time of first recording, the recording run
      identifier and the Interest_Flag unchanged; write `contentHash`
    - Reset a Job_Posting with Posting_Status "no longer listed" back to "listed" on reappearance while
      keeping the time of first recording
    - _Requirements: 9.2, 9.3, 9.8, 11.8_
  - [x] 11.2 Implement the "no longer listed" sweep
    - `markAbsentAsNoLongerListed` setting the Posting_Status for exactly the stored postings of that Platform
      absent from the result list, called only when both the Run_Outcome and the Platform_Status are
      "completed", retaining every other field
    - _Requirements: 9.5, 9.7_
  - [x] 11.3 Set up the Testcontainers integration harness
    - A Vitest setup that starts a throwaway PostgreSQL 16 container per integration file and applies
      `prisma migrate deploy`, failing fast with an explicit message when Docker is unavailable instead of
      falling back to another engine
    - An integration test replaying every migration against a seeded database and asserting stored
      Job_Posting, Scrape_Run and relevance assessments survive
    - _Requirements: 9.6_
  - [x] 11.4 Write the property test for upsert idempotence
    - **Property 7: Upsert into the Posting_Store is idempotent**
    - **Validates: Requirements 9.2, 9.4**
    - _Requirements: 9.2, 9.4_
  - [x] 11.5 Write the property test for preservation across upserts
    - **Property 8: Upsert preserves the first recording and the user's marking**
    - **Validates: Requirements 9.3, 10.10, 11.8**
    - _Requirements: 9.3, 10.10, 11.8_
  - [x] 11.6 Write the property test for the gated sweep
    - **Property 9: The "no longer listed" sweep is the gated set difference and round-trips**
    - **Validates: Requirements 9.5, 9.7, 9.8**
    - _Requirements: 9.5, 9.7, 9.8_
  - [x] 11.7 Write unit tests for the write failure path
    - A failing single upsert leaves the affected record in its pre-write state, reports platform name and
      Posting_Id to the Log_Stream and the remaining postings of the run continue
    - _Requirements: 9.9_

- [x] 12. ScrapeRunCoordinator and Scraper_Service
  - [x] 12.1 Implement the coordinator core
    - `apps/api/src/scrape-run/scrape-run.coordinator.ts` as a singleton holding one `ActiveRun` with an
      `AbortController`, guarded by an in-process async mutex so no second Scrape_Run is created
    - `start()` creates the Scrape_Run with a start time and status "running" and returns its identifier
      within 2 seconds; a start while a run is active returns the running identifier plus the already-running
      hint; `cancel()` ends running retrievals within 10 seconds, sets the Run_Outcome "cancelled by user"
      with an end time and rejects a cancellation for a run that is not running by returning its stored
      Run_Outcome
    - Retrieval deadline `startedAt + 30 min` and the enrichment grace deadline
      `retrievalEnd + ENRICHMENT_GRACE_MINUTES`
    - _Requirements: 12.1, 12.5, 12.7, 12.13, 12.14, 13.6_
  - [x] 12.2 Implement stale-run recovery at bootstrap
    - `recoverStaleRuns()` in `onApplicationBootstrap` closing every Scrape_Run left in status "running" with
      an end time, `runOutcome = CANCELLED_BY_TIME_LIMIT` and `closedByRecovery = true`
    - Retain every stored Job_Posting, perform no status sweep, mark no Job_Posting "neu" for that run, and
      write a German recovery message to the Log_Stream
    - _Requirements: 9.7, 11.7, 12.1_
  - [x] 12.3 Implement the Scraper_Service orchestration
    - `execute()` running every activated Platform_Adapter through the 4-permit semaphore and one
      `PlatformQueue` per Platform, skipping deactivated Platform with `DISABLED` and incomplete ones with
      `INCOMPLETE_CONFIGURATION` plus the missing field names
    - Write the effective Search_Profile of every activated Platform to the Log_Stream, persist it as the
      `ScrapeRunPlatformResult.effectiveProfile` snapshot, normalize and upsert each Job_Posting, run the
      gated sweep, and write per-Platform counters
    - Never let one Platform's failure end the Scrape_Run; make no further retrieval attempt for a Platform
      that reported "sign-in required" or "platform blocked"; keep every Partial_Result
    - Catch a rejected single upsert, report it as `ERROR` `posting.writeFailed` with platform name and
      Posting_Id to the Log_Stream, count it for the run summary and continue with the next Job_Posting; the
      repository only guarantees the pre-write state and propagates the error (see task 11.7)
    - On the retrieval deadline send no further Platform request, end running retrievals within 10 seconds and
      set `CANCELLED_BY_TIME_LIMIT` per unfinished Platform and as the Run_Outcome
    - _Requirements: 3.8, 4.7, 4.10, 7.3, 7.7, 7.8, 9.9, 12.3, 13.1, 13.6, 13.9_
  - [x] 12.4 Expose the run mutations and the end-of-run summary
    - Mutations `startScrapeRun` and `cancelScrapeRun` returning typed payloads with German hint fields
      instead of GraphQL errors
    - At the end of a Scrape_Run write the summary (Run_Outcome, runtime, per-Platform Platform_Status, new
      and updated counts) to the Log_Stream and persist one `ScrapeRunPlatformResult` per requested Platform
    - _Requirements: 7.4, 12.1, 12.5, 12.10, 12.13, 12.14_
  - [x] 12.5 Implement the central error mapping
    - `apps/api/src/common/error-mapping.ts` mapping the internal error union onto
      `{ platformStatus?, runOutcome?, userMessageDe, logCode, logLevel }` exactly as in the design's mapping
      table, with a test asserting the mapping is total over the union
    - Every German user message names the cause and exactly one recommended next step; technical detail stays
      in the Log_View
    - _Requirements: 2.5, 7.4, 13.1_
  - [x] 12.6 Write the property test for confluence over adapter orders
    - **Property 10: The final state is confluent over adapter execution orders**
    - **Validates: Requirements 13.7**
    - _Requirements: 13.7_
  - [x] 12.7 Write the property test for the single-run guarantee
    - **Property 23: At most one Scrape_Run is ever running**
    - **Validates: Requirements 12.1, 12.5**
    - _Requirements: 12.1, 12.5_
  - [x] 12.8 Write the property test for exactly one Platform_Status per Platform
    - **Property 28: Every requested Platform ends a Scrape_Run with exactly one Platform_Status**
    - **Validates: Requirements 4.7, 7.3, 7.4, 7.7, 7.8, 13.1**
    - _Requirements: 4.7, 7.3, 7.4, 7.7, 7.8, 13.1_
  - [x] 12.9 Write unit tests for the coordinator and the service
    - Start, double start, cancel of a finished run, stale-run recovery, all Platform completed, one adapter
      throwing, retrieval deadline reached, enrichment grace deadline reached
    - A rejected single upsert reaches the Log_Stream with platform name and Posting_Id and the run continues
      with the remaining Job_Posting (the caller half of 9.9; the repository half is task 11.7)
    - _Requirements: 9.9, 12.5, 12.7, 12.14, 13.1, 13.6_
  - [x] 12.10 Checkpoint - backend retrieval path green
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 13.1, 13.7_

- [x] 13. Commute_Service and the Routing_Provider port
  - [x] 13.1 Define the routing port and its response schemas
    - `apps/api/src/commute/routing-provider.port.ts` with `Coordinate`, `GeocodeResult`,
      `TravelDurationRequest` and `RoutingProvider`
    - Zod schemas for every provider response so an unexpected shape becomes "no route determined" instead of
      a crash
    - _Requirements: 8.1, 8.8_
  - [x] 13.2 Implement `HeigitRoutingProvider`
    - Geocoding, bicycle durations through the cycling profile and transit durations with an arrival-time
      preference, API key read from the environment file only and masked in every output
    - 10-second timeout per query with up to three attempts
    - _Requirements: 8.1, 8.8, 14.9_
  - [x] 13.3 Implement the time and location helpers
    - `nextWorkdayArrival(now)` returning 09:00 local time on the next Monday-to-Friday strictly after the
      input instant
    - `parseWorkLocation(raw)` extracting a geocodable place name by rule, reporting why a value carries no
      place reference below country level
    - _Requirements: 8.1, 8.5_
  - [x] 13.4 Implement `CommuteService.enrich` with the cache chain
    - Attempt order: `CommuteCacheEntry` lookup, rule-based parse, stored `LocationNormalization`, at most one
      AI_Provider normalization per distinct free-text work location, geocode, routing
    - Cache keyed by (Home_Address, target latitude, target longitude, mode) with coordinates rounded to four
      decimal places and a 30-day validity; re-determine when the stored `commuteLocationInput` differs from
      the current work location or the entry expired
    - _Requirements: 8.5, 8.6, 8.7, 8.9_
  - [x] 13.5 Persist the commute result and the degradation cases
    - Store both Commute_Time values rounded up in the range 1 to 600 minutes, the Best_Commute_Time with its
      mode, the precision and `commuteCheckedAt`; store a value above 600 minutes and every unresolved case as
      "unknown" and retry in the next Scrape_Run
    - Mark municipality or district centroid results as `IMPRECISE`
    - Run enrichment after persistence so a Job_Posting is visible before its result arrives and the retrieval
      runtime limit stays unaffected
    - _Requirements: 8.2, 8.5, 8.8, 8.12, 8.13_
  - [x] 13.6 Write the property test for the Best_Commute_Time
    - **Property 16: Best_Commute_Time is the admissible minimum and renders unambiguously**
    - **Validates: Requirements 8.2, 8.3, 8.4, 8.13**
    - _Requirements: 8.2, 8.3, 8.4, 8.13_
  - [x] 13.7 Write the property test for the transit reference point
    - **Property 17: The transit reference point is always 09:00 on the next working day**
    - **Validates: Requirements 8.1**
    - _Requirements: 8.1_
  - [x] 13.8 Write the property test for bounded enrichment calls
    - **Property 18: Enrichment calls are bounded by distinct inputs and cache validity**
    - **Validates: Requirements 8.7, 8.9**
    - _Requirements: 8.7, 8.9_
  - [x] 13.9 Write unit tests for the Commute_Service
    - Cache hit without a provider query, provider failure after three attempts degrading to "unknown",
      municipality-level precision, unresolvable location with the Relevance_Service deactivated
    - _Requirements: 8.5, 8.8, 8.9, 8.12_

- [x] 14. Relevance_Service
  - [x] 14.1 Define the assessor port and the response schema
    - `apps/api/src/relevance/relevance-assessor.port.ts` with `relevanceResponseSchema` (verdict from
      relevant/not relevant/uncertain, German reason of 1 to 300 characters), `RelevanceRequest`,
      `RelevanceOutcome` and `RelevanceAssessor`
    - _Requirements: 15.3, 15.12, 15.14_
  - [x] 14.2 Implement `AnthropicRelevanceAssessor`
    - Model from the environment file with the Claude Sonnet default, a single forced tool call
      `report_relevance` so the response is structured, and the English system prompt that demands a German
      reason of at most 300 characters naming the concrete decisive factor
    - Transmit title, employer, work location, publication date, the description truncated to 4,000 characters
      and the effective Search_Profile as the benchmark; parse the tool input with Zod and map any violation
      to `SCHEMA_VIOLATION` without a retry
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.12_
  - [x] 14.3 Implement the retry, budget, concurrency and no-key behaviour
    - 30-second per-request timeout, at most two retries with exponential backoff on timeout, rate limit and
      transport errors, then "not assessed" with a German note in the Relevance_Reason
    - At most `RELEVANCE_MAX_PER_RUN` (default 200) assessments per Scrape_Run with a deterministic selection
      order, at most `RELEVANCE_CONCURRENCY` (default 4) simultaneous requests
    - A `NoopRelevanceAssessor` when the API key is absent or the switch deactivates the service: no request,
      every Job_Posting "not assessed", every other function unaffected
    - _Requirements: 15.7, 15.8, 15.9, 15.10, 15.11_
  - [x] 14.4 Implement the content hash gate and the result write
    - Request a new assessment exactly when the Relevance_Verdict is not manual and `relevanceContentHash` is
      null or differs from `contentHash`; otherwise retain the stored assessment
    - Write verdict, reason, model name, assessment time, `relevanceContentHash` and the denormalized
      `relevanceRank` in the same statement
    - Use the AI_Provider only for the relevance assessment and for the work location normalization; derive
      every selector and Platform request from the adapter source code
    - _Requirements: 15.1, 15.5, 15.6, 15.17_
  - [x] 14.5 Write the end-of-run assessment counters to the Log_Stream
    - Number of assessed Job_Posting, number with "not relevant" and number with "not assessed", plus a German
      message when the run budget bound
    - _Requirements: 15.7, 15.16_
  - [x] 14.6 Implement the manual Relevance_Verdict override
    - `setRelevanceVerdictManually` in the repository and the `setRelevanceVerdict` mutation setting
      `relevanceSetManually = true`, so every following Scrape_Run keeps the manual verdict in place of a
      service assessment
    - _Requirements: 15.15_
  - [x] 14.7 Write the property test for the response parser
    - **Property 19: The relevance response parser is total**
    - **Validates: Requirements 15.3, 15.12, 15.14**
    - _Requirements: 15.3, 15.12, 15.14_
  - [x] 14.8 Write the property test for verdict totality over provider behaviours
    - **Property 20: Every Job_Posting carries exactly one Relevance_Verdict**
    - **Validates: Requirements 15.1, 15.7, 15.10, 15.11**
    - _Requirements: 15.1, 15.7, 15.10, 15.11_
  - [x] 14.9 Write the property test for the content hash gate
    - **Property 21: The content hash gate requests an assessment exactly when it must**
    - **Validates: Requirements 15.5, 15.6, 15.15**
    - _Requirements: 15.5, 15.6, 15.15_
  - [x] 14.10 Write unit tests against a mocked AI_Provider
    - Reason of exactly 300 and of 301 characters, verdict outside the value list, missing field, no tool call,
      prose instead of a tool call, never-resolving request with fake timers, two rate limits then success,
      missing key with zero client constructions, budget and concurrency caps, prompt construction
    - _Requirements: 15.2, 15.3, 15.7, 15.8, 15.10, 15.11, 15.12_

- [x] 15. GraphQL read layer for the posting overview
  - [x] 15.1 Implement filtering, sorting and pagination in the repository
    - `findPage` with conjunctive filters for Platform, reachability, Posting_Status, Interest_Flag,
      Relevance_Verdict and recording period, where marking and verdict filters act independently of the
      Posting_Status filter
    - Default view excludes "not relevant" and "not interesting" unless an explicit filter value is sent;
      sorting by recording time, publication date, Best_Commute_Time and Relevance_Verdict in both directions
      with recording time descending as the default, "unknown" commute values last and the prescribed verdict
      order through `relevanceRank`; pages of at most 25 entries with `totalCount` and `pageCount`
    - The reachability filter for well-reachable postings hides Best_Commute_Time "unknown"
    - _Requirements: 8.11, 10.5, 10.6, 10.7, 10.9, 10.11_
  - [x] 15.2 Derive the "neu" marking and the run counters
    - Query the most recently completed Scrape_Run, resolve `JobPosting.isNew` as
      `firstSeenRunId = latestCompletedRunId`, and apply the default grouping that places marked postings
      above unmarked ones with recording time descending inside both groups
    - `latestScrapeRun` returning start time, end time, Run_Outcome and the counts of first-recorded,
      re-sighted and total stored Job_Posting
    - _Requirements: 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_
  - [x] 15.3 Implement the read resolvers
    - `jobPostings`, `jobPosting`, `scrapeRuns`, `activeScrapeRun`, `latestScrapeRun`, `appInfo` and the
      read-only `searchCriteria` returning per Platform the activation state, the Platform_Status, every
      supported Criterion_Field with its provenance and the missing mandatory field names
    - DataLoader for `JobPosting.firstSeenRun` and `ScrapeRun.platformResults`; thin resolvers with the logic
      in services
    - _Requirements: 4.11, 4.12, 10.1, 10.2, 10.3, 14.8_
  - [x] 15.4 Implement the `setInterestFlag` mutation
    - Persist the Interest_Flag without touching the Posting_Status, return the updated Job_Posting, and on a
      write failure return a typed payload the Web_App turns into a German message while the posting stays
      listed as "unmarked"
    - _Requirements: 10.10, 10.14_
  - [x] 15.5 Write the property test for conjunctive filters and the default view
    - **Property 24: Filters are conjunctive and the default view hides the right postings**
    - **Validates: Requirements 8.11, 10.5, 10.6, 10.11**
    - _Requirements: 8.11, 10.5, 10.6, 10.11_
  - [x] 15.6 Write the property test for the sort order
    - **Property 25: Sorting is a total order and places unknown values and new postings correctly**
    - **Validates: Requirements 10.7, 11.3**
    - _Requirements: 10.7, 11.3_
  - [x] 15.7 Write the property test for pagination
    - **Property 26: Pagination partitions the filtered and sorted result**
    - **Validates: Requirements 10.9**
    - _Requirements: 10.9_
  - [x] 15.8 Write the property test for the "neu" set
    - **Property 27: The "neu" marking is exactly the postings of the most recently completed Scrape_Run**
    - **Validates: Requirements 11.2, 11.4, 11.6, 11.7**
    - _Requirements: 11.2, 11.4, 11.6, 11.7_
  - [x] 15.9 Write the property test for the reported counters
    - **Property 29: Reported counters equal the stored data**
    - **Validates: Requirements 11.5, 15.16**
    - _Requirements: 11.5, 15.16_
  - [x] 15.10 Write integration tests for the read layer against PostgreSQL
    - Filters, sorting and pagination compared against an independent in-memory reference predicate on the
      same seeded data, plus the `relevanceRank` consistency assertion for every verdict value
    - _Requirements: 10.5, 10.7, 10.9_

- [x] 16. Web_App skeleton
  - [x] 16.1 Scaffold the React application
    - `apps/web` with Vite, strict TypeScript from the shared config, TanStack Router file-based routing and
      the never-hand-edited `routeTree.gen.ts`
    - _Requirements: 1.16, 2.2_
  - [x] 16.2 Configure Apollo Client with the subscription transport
    - HTTP link for queries and mutations, `graphql-ws` link for subscriptions, split by operation type, and a
      `LogMessage` cache key of `['runId', 'sequence']` so a redelivered message collapses into one entry
    - _Requirements: 12.4, 12.9_
  - [x] 16.3 Set up GraphQL Code Generator
    - Generate typed hooks next to the `.graphql` operation files from `apps/api/src/schema.gql`, with a
      `codegen` script to rerun after any schema or operation change and the generated files documented as
      generated
    - _Requirements: 10.1_
  - [x] 16.4 Create the German string module
    - `apps/web/src/i18n/de.ts` as one typed `const` object with nested namespaces holding every German label,
      button text, hint, status and error message, so a missing key fails `check-types` and no German literal
      appears inside a component
    - _Requirements: 2.1_
  - [x] 16.5 Build the root layout and the landing page
    - `__root.tsx` with a skip link, a visible focus indicator, a global error boundary, and the landing hint
      visible without scrolling that names the private purpose of use and whether the Relevance_Service is
      activated
    - `index.tsx` with the four permanently visible, named controls "Suchlauf starten", "Treffer ansehen",
      "Suchkriterien ansehen" and "Log öffnen", each reachable with at most two activations and operable by
      keyboard
    - _Requirements: 2.1, 2.2, 2.3, 14.8_
  - [x] 16.6 Write component tests for the shell and the landing page
    - Keyboard reachability of the four controls, presence of the private-use hint with the AI activation
      state, and a missing-translation guard
    - _Requirements: 2.2, 2.3, 14.8_

- [x] 17. Posting overview and detail view
  - [x] 17.1 Build the posting list with its badges
    - `PostingList` with title, employer, work location, platform name, publication date, Best_Commute_Time in
      minutes with its mode and Posting_Status, rendering "unbekannt" for an unknown commute value
    - `NewBadge` with the text label "neu" plus a symbol, `CommuteBadge` with the "gut erreichbar" hint at or
      below the Commute_Threshold and "Erreichbarkeit unbekannt" otherwise, `RelevanceBadge` with the verdict
      as text plus the Relevance_Reason and the KI-or-manual marking
    - Every state identified by text or a symbol with a textual alternative, never by colour alone
    - _Requirements: 2.4, 8.3, 8.4, 8.13, 10.1, 10.2, 10.3, 10.4, 11.2_
  - [x] 17.2 Build the filter bar
    - Filters for Platform (all selectable, default all), reachability, Posting_Status, marking,
      Relevance_Verdict and recording period with a from and a to date, combined conjunctively, built with
      `react-hook-form` and labelled form fields
    - _Requirements: 2.3, 8.11, 10.5_
  - [x] 17.3 Build sorting and pagination controls
    - Sort selection over recording time, publication date, Best_Commute_Time and Relevance_Verdict in both
      directions with recording time descending preselected, and pagination showing the current page number
      and the total number of pages with previous and next navigation, opening on the first page
    - _Requirements: 10.7, 10.9_
  - [x] 17.4 Implement the Interest_Flag interaction
    - Mark a Job_Posting as "nicht interessant", confirm the stored flag within 2 seconds, offer the
      withdrawal, and on a failed write show the German error message with the next step while the posting
      stays listed as "unmarked"; preserve every entered input and keep the action repeatable
    - _Requirements: 2.6, 10.10, 10.11, 10.14_
  - [x] 17.5 Implement the empty states and the run summary block
    - Hint with the call to action "Suchlauf starten" for an empty Posting_Store, hint about the empty filter
      result with "Filter zurücksetzen" while the filters stay set, the "keine Treffer" hint pointing at the
      read-only criteria view after a run without hits, and the hint that no Scrape_Run has been completed yet
      instead of the run counters
    - _Requirements: 2.8, 10.12, 10.13, 11.5, 11.6_
  - [x] 17.6 Build the detail route
    - `postings/$postingId.tsx` showing the complete description text and a labelled link to the source URL,
      with a German hint about the missing description while still showing the link when the text is empty
    - _Requirements: 10.8, 10.15_
  - [x] 17.7 Write component tests for the overview and the detail view
    - Badge rendering for every verdict and commute case, empty states, filter reset keeping the filters,
      Interest_Flag failure path, detail view without a description text
    - _Requirements: 10.4, 10.13, 10.14, 10.15_

- [x] 18. Log_View and Scrape_Run control
  - [x] 18.1 Implement the run controls and the running status display
    - "Suchlauf starten" triggering the mutation and disabled while a Scrape_Run is running, "Suchlauf
      abbrechen" operable in the Log_View while running, a German progress display updated at least every 5
      seconds, and the German hint plus a link to the Log_View when a run is already running
    - _Requirements: 2.7, 12.1, 12.5, 12.6_
  - [x] 18.2 Implement the `useLogStream` hook
    - Load the history with `logMessages(runId, afterSequence)`, then subscribe to `logMessageAdded`, ignoring
      every message whose sequence is at or below the highest already held
    - Explicit discriminated-union connection state, at most five reconnects with at least 2 seconds between
      attempts, each reconnect re-running the history query before re-subscribing, the interruption hint while
      reconnecting and the "Übertragung erneut verbinden" call to action after the attempts are exhausted,
      leaving the Scrape_Run untouched
    - _Requirements: 12.4, 12.9, 12.11, 12.12_
  - [x] 18.3 Build the Log_View overlay and the end-of-run summary
    - `runs.$runId.log.tsx` rendered as a linkable, reloadable overlay over the current route, presenting
      messages in ascending creation order with at least the last 500 retrievable, reloading the history of a
      running run within 3 seconds completely and without duplication, continuing the run when closed, and
      showing the summary with Run_Outcome, runtime in minutes and seconds and per Platform the
      Platform_Status with the new and updated counts plus the incompleteness hint
    - _Requirements: 7.4, 12.2, 12.8, 12.9, 12.10_
  - [x] 18.4 Write component tests for the hook and the overlay
    - Deduplication across a reconnect overlap, gapless assembly of history plus subscription, the fifth
      failed reconnect showing the call to action, the disabled start control while running
    - _Requirements: 12.9, 12.11, 12.12_

- [x] 19. Read-only view of the search criteria
  - [x] 19.1 Build the criteria route
    - `criteria.tsx` showing within 3 seconds one block per supported Platform with the resolved value of
      every supported Criterion_Field, omitting unsupported fields, marking each field with exactly one of
      "aus Standardprofil" or "überschrieben", presenting everything read-only without an editable control,
      and referring the user to the Steering_Docs for how the constants are changed
    - Show the Platform_Status including "incomplete configuration" with the missing field names and
      "disabled" for a deactivated Platform
    - _Requirements: 4.7, 4.9, 4.11, 4.12, 4.13_
  - [x] 19.2 Write component tests for the criteria view
    - One block per Platform, both provenance labels, absence of editable controls, the Steering_Docs hint
    - _Requirements: 4.11, 4.12, 4.13_
  - [x] 19.3 Checkpoint - Web_App flows green
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 2.2, 2.3_

- [x] 20. Start_Script
  - [x] 20.1 Implement steps 1 to 3 of `scripts/start.mjs`
    - Fast-forward-only `git pull`, `pnpm install`, Playwright browser binary check and installation of
      missing binaries, each with exactly one German progress line
    - Skip `git pull` with a German warning naming the uncommitted changes when the working tree is dirty, and
      with a German warning naming the detected cause when no network is available or no fast-forward is
      possible, continuing with step 2 in both cases
    - Perform no `git reset`, `git checkout --force`, `git clean` or merge commit; exit non-zero with a German
      error when `pnpm install` or a browser installation fails
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_
  - [x] 20.2 Implement steps 4 and 5
    - Probe the container runtime before step 4 and stop with a German instruction to start it when
      unreachable, start the PostgreSQL container or reuse a running one without creating a second container
      and without touching stored data, then apply pending Prisma migrations
    - On a failed migration start neither the API_Service nor the Web_App, leave stored data unchanged, print
      the name of the failed migration and exit non-zero
    - _Requirements: 1.1, 1.10, 1.13, 1.14_
  - [x] 20.3 Implement steps 6 and 7 with the readiness gates
    - Start the API_Service, then serve the Web_App, each gated by a readiness probe at least every 2 seconds
      with a 60-second limit that on expiry skips the remaining steps, names the affected service and the
      detected cause (unreachable or port occupied) in German and exits non-zero
    - Validate the environment file first and exit non-zero naming every missing key; print the complete
      callable local URL within 5 seconds of the Web_App accepting requests; add the switch that skips steps 1
      and 2 and begins with step 3
    - _Requirements: 1.1, 1.8, 1.9, 1.11, 1.12, 1.15_
  - [x] 20.4 Extract and test the script decision logic
    - Move the branching rules (dirty tree, pull failure classification, readiness polling, port-occupied
      detection, exit code selection) into an importable module under `scripts/lib/` and cover them with
      Vitest using injected fakes for git, Docker and the probes
    - Keep every shell invocation single-line and file-based per the project rule on shell execution
    - _Requirements: 1.3, 1.4, 1.11, 1.13_

- [x] 21. Playwright E2E tests and accessibility checks
  - [x] 21.1 Set up the E2E harness
    - Playwright config for `apps/web/e2e`, a seeding helper for a known Posting_Store state, a
      `SCRAPER_FIXTURE_MODE` switch that swaps in fixture-backed Platform_Adapter, and mocks for the
      Routing_Provider and the AI_Provider so no E2E run issues a real external request
    - _Requirements: 10.1, 12.1_
  - [x] 21.2 Write the overview and run-control E2E flows
    - Filter by every dimension, combine two filters, sort by each key in both directions, page through more
      than 25 entries; start a Scrape_Run and assert the Log_View opens, messages arrive in order, the start
      control is disabled, the summary appears and closing the Log_View does not stop the run; cancel a
      running Scrape_Run and assert the German summary with the cancellation outcome; override a
      Relevance_Verdict manually and assert the "manuell gesetzt" marking survives a reload
    - _Requirements: 10.5, 10.7, 10.9, 12.1, 12.6, 12.7, 12.8, 12.10, 15.15_
  - [x] 21.3 Write the marking, empty-state and criteria E2E flows
    - Mark a Job_Posting as "nicht interessant", assert it disappears from the default view, make it visible
      again through the marking filter and withdraw the marking; empty Posting_Store, empty filter result with
      retained filters, run without hits, Job_Posting without a description text, Posting_Store without a
      completed Scrape_Run; read-only criteria view with both provenance labels and no editable control
    - _Requirements: 2.8, 4.11, 4.12, 4.13, 10.10, 10.11, 10.12, 10.13, 10.15, 11.6_
  - [x] 21.4 Add the axe accessibility checks
    - Run `AxeBuilder` with the `wcag2a`, `wcag2aa`, `wcag21a` and `wcag21aa` tags on every route each E2E
      spec visits and fail on any violation
    - _Requirements: 2.3, 2.4_
  - [x] 21.5 Add the focus and keyboard specs _(optional)_
    - Assert a visible focus indicator on every interactive control, a programmatically associated label on
      every form field, and keyboard-only traversal of the landing page reaching all four functions
    - _Requirements: 2.2, 2.3_

- [x] 22. Steering_Docs in `.kiro/steering`
  - [x] 22.1 Write the project context and language convention doc
    - Purpose of the Job_Tool, the single non-technical target user, German as the Web_App language, the local
      operating model with PostgreSQL in a Docker container on a developer machine without a cloud deployment
    - The language convention that requirements, Steering_Docs, source code and code comments are English
      while the user interface texts and every Relevance_Reason are German
    - Written in English, using the glossary terms unchanged, with a front matter `inclusion` value from
      `always`, `fileMatch`, `manual` or `auto`
    - _Requirements: 16.1, 16.2, 16.8, 16.9, 16.10_
  - [x] 22.2 Write the Platform_Adapter conventions doc
    - The uniform adapter interface, the normalization onto the eight Job_Posting fields, the Criterion_Field
      supported per Platform, the minimum waiting time of 2 seconds between page requests, the limit of 10
      Result_Page per Platform and Scrape_Run, and the tests required per Platform_Adapter with at least one
      success and one error case
    - The numbered sequence for adding a further Platform_Adapter, each step naming the file to create or
      change and the command to run
    - _Requirements: 16.1, 16.3, 16.5, 16.10, 16.11_
  - [x] 22.3 Write the local development and start flow doc
    - The seven Start_Script steps in order, the container and migration handling, and the quality steps
      formatting, linting, type checking, build and tests with the command for each
    - _Requirements: 16.1, 16.4, 16.10_
  - [x] 22.4 Write the Relevance_Service and search profile doc
    - Prompt construction, the expected structured response format, the caching of assessments through the
      content hash, the cost limits for assessments per Scrape_Run and simultaneous requests, and the
      behaviour without an API key
    - That the Default_Search_Profile and every Platform_Override live in the source code, the source file of
      each constant, and that a change takes effect by editing that file and restarting the API_Service
    - _Requirements: 16.1, 16.6, 16.7, 16.10_
  - [x] 22.5 Add a Steering_Docs lint test
    - Assert at least four Markdown files exist in `.kiro/steering`, that every front matter block sets
      `inclusion` to one of the four permitted values, and that a file without front matter is accepted
    - _Requirements: 16.1, 16.9_

- [x] 23. Glassdoor Platform*Adapter *(optional)\_
  - [x] 23.1 Implement `GlassdoorAdapter`
    - Same uniform interface and status detection as the earlier adapters, using the Glassdoor capability
      declaration
    - Risk note from the design: Glassdoor operates aggressive bot protection, so a permanent Platform_Status
      "platform blocked" or "sign-in required" is a realistic and acceptable outcome; answer no Captcha, fake
      no user agent and make no further attempt in the same run after a block
    - _Requirements: 6.1, 6.2, 7.2, 7.6, 7.7, 7.8_
  - [x] 23.2 Capture the Glassdoor fixtures
    - The standard fixture cases, including the `sign-in-wall` and `captcha` cases which are the expected
      outcome for this Platform
    - _Requirements: 6.2, 7.2, 7.6_
  - [x] 23.3 Write the Glassdoor parser tests against frozen fixtures
    - Normalization and pagination where readable, plus assertions that a block yields the Partial_Result and
      the correct Platform_Status instead of a failed Scrape_Run
    - _Requirements: 6.3, 6.7, 7.3, 7.7_
  - [x] 23.4 Write `docs/adapters/glassdoor.md`
    - Same content as the other adapter documentation files including the review date, plus the note that the
      Platform may be deactivated in the source code so it reports "disabled" instead of failing every run
    - _Requirements: 4.6, 4.7, 14.7_

- [x] 24. Indeed Platform*Adapter *(optional)\_
  - [x] 24.1 Implement `IndeedAdapter`
    - Same uniform interface and status detection, using the Indeed capability declaration including
      employment type and publication period
    - Same risk note as Glassdoor: a permanent "platform blocked" or "sign-in required" is an acceptable
      outcome and no protection is circumvented
    - _Requirements: 6.1, 6.2, 7.2, 7.6, 7.7, 7.8_
  - [x] 24.2 Capture the Indeed fixtures
    - The standard fixture cases including the blocking cases
    - _Requirements: 6.2, 7.2, 7.6_
  - [x] 24.3 Write the Indeed parser tests against frozen fixtures
    - Normalization, pagination, relative dates and the blocking paths with a retained Partial_Result
    - _Requirements: 6.3, 6.4, 6.7, 7.3, 7.7_
  - [x] 24.4 Write `docs/adapters/indeed.md`
    - Same content as the other adapter documentation files including the review date and the deactivation
      note
    - _Requirements: 4.6, 4.7, 14.7_

- [x] 25. Final quality gate
  - [x] 25.1 Run the full quality gate in order
    - `pnpm format`, `pnpm lint`, `pnpm check-types`, `pnpm build`, `pnpm test`, then `pnpm test:e2e`;
      `pnpm test:live` stays outside the gate
    - _Requirements: 16.4_
  - [x] 25.2 Fix every finding and re-run the gate
    - Resolve formatting, lint, type, build and test findings, then repeat the gate until all steps pass
    - _Requirements: 16.4_

## Notes

Recommended order and why Stepstone and Jobvector come first. The Risk Assessment rates Stepstone and
Jobvector as the most accessible publicly reachable result lists, while Glassdoor and Indeed commonly serve a
Captcha, a sign-in wall or an empty list to an honestly identified automation client. Getting the full
pipeline green against the two accessible Platform first means the retrieval, normalization, persistence,
enrichment and presentation path is proven before any time goes into the two Platform that may never return a
usable result. The uniform adapter interface and the registry make that a scheduling decision, not an
architectural one, so tasks 23 and 24 can be skipped entirely for a working system.

Environment variables before the first complete run. `DATABASE_URL`, `HOME_ADDRESS`,
`COMMUTE_THRESHOLD_MINUTES` and `USER_AGENT_CONTACT` are required: the user agent must carry a real contact
detail per Requirement 14.5, and the Start_Script refuses to start any service while a required key is missing.
`ROUTING_API_KEY` and `ANTHROPIC_API_KEY` are optional in the sense that the Job_Tool degrades instead of
failing: without a routing key every Best_Commute_Time stays "unknown", and without an Anthropic key or with
`RELEVANCE_ENABLED=false` every Job_Posting stays "not assessed", the landing page states that the
Relevance_Service is deactivated, and retrieval, storage and the posting overview work unchanged. Obtaining
the keys is an operator action, not a coding task.

Two requirements gaps carried as interim code. First, a process crash leaves a `ScrapeRun` row in status
"running" and the glossary's Run_Outcome list has no value for that case. Task 12.2 closes such a run on
startup with `runOutcome = CANCELLED_BY_TIME_LIMIT` plus `closedByRecovery = true`, retains every stored
Job_Posting, performs no status sweep and shows the honest German text "Suchlauf durch Neustart beendet". The
recommended resolution is a fourth Run_Outcome value in the glossary, after which the flag disappears. Second,
nothing in the requirements bounds the enrichment phase, so a hanging Routing_Provider or AI_Provider would
keep a Scrape_Run "running" forever and block the single-run rule. Task 12.1 adds a grace deadline after
retrieval (default 10 minutes) that leaves outstanding items at "unknown" and "not assessed" without changing
the Run_Outcome.

HTML fixtures age. Every Platform changes its markup, so the frozen fixtures under
`packages/scrapers/src/adapters/<platform>/__fixtures__/` will eventually stop matching reality. The signal is
a real Scrape_Run or an opt-in `@live` smoke test reporting `PAGE_LAYOUT_UNKNOWN`. The refresh is
`pnpm fixtures:capture --platform <name>` followed by a selector fix, `pnpm fixtures:accept --platform <name>`
to regenerate the expected JSON, a review of that diff rather than a blind overwrite, and an update of
`docs/adapters/<platform>.md` including the review date. The capture script issues real Platform requests, so
it never runs inside a test or in CI.

Quality gate. Every task runs `pnpm format`, `pnpm lint`, `pnpm check-types`, `pnpm build` and `pnpm test` in
that order, plus `pnpm test:e2e` for any frontend change. No task counts as done until all of them pass.
`pnpm test` uses `vitest --run` so no watcher is started, and `pnpm test:live` is never part of the gate
because it depends on the network and on the Platform not blocking that day. Sub-tasks marked with `*` are
optional for a faster first working system; tasks marked `*(optional)*` in the title are whole features that
can be skipped. Property-based tests use fast-check with at least 100 iterations and carry the tag comment
`// Feature: job-search-tool, Property N - <title>` so each design property maps to exactly one test.

Two records corrected by task 25.2, stated here because the checkmarks above do not show it. Task 13.4
was marked done claiming Requirements 8.5, 8.6, 8.7 and 8.9, and 8.6 was not implemented: the
`LOCATION_NORMALIZER` port existed, `CommuteService` consumed it, and no implementation was bound in
any module, so the Commute_Service always took the 8.5 path and the `locationNormalization` table had a
reader and a writer production never reached. Task 14 was expected to bind it — a test in
`apps/api/src/commute/__tests__/commute.module.test.ts` said so in a comment — and did not. Task 25.2
added `AnthropicLocationNormalizer`, its fixture double and the `RELEVANCE_ENABLED`-driven binding, so
the claim of 13.4 now holds. The lesson worth keeping is the test: an assertion that a token *throws*
is not a statement about a requirement, and the suite that would have caught this is
`commute.normalization-binding.test.ts`, which drives the 8.6 path through the real module graph.

Second, Requirement 15.15 was carried as two halves for the whole of section 17. The mutation, the
Posting_Store write, the content hash gate and the "manuell gesetzt" marking were all built; no React
component ever sent the mutation, and the only caller was the E2E harness, whose comment reported the
gap plainly. Task 25.2 added `apps/web/src/components/RelevanceVerdictControl`, so the "WHEN the user
overrides the Relevance_Verdict … in the Web_App" half is now driven through the user interface and
covered by an E2E spec. No task of section 17 ever asked for that control; the requirement did.
