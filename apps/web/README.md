# @job-scraper/web

The Web_App. At this point the package contains the Vite application shell with strict TypeScript from the shared
config, TanStack Router file-based routing, the Apollo Client transport, the German string module and the GraphQL code
generator. The real shell and landing page (task 16.5) follow in the next task; `__root.tsx` and `index.tsx` exist as
placeholders so that the router has a tree to mount.

## Entry point and router

`index.html` declares `lang="de"` — the interface is German throughout (2.1) — and loads `src/main.tsx`, which mounts
the router inside the GraphQL provider and does nothing else. The shell itself belongs in `src/routes/__root.tsx`, so a
component test can render the same tree without the entry point.

`src/router.ts` exports `createAppRouter(history?)`, a factory rather than a module-level singleton. Tests create their
own instance per test and pass a memory history to start on a route other than `/`; the browser passes nothing and gets
the default browser history. The same file registers the route tree with the library's type registry, which is what
makes `Link`, `useParams` and `navigate` typed against the real routes: an unknown path is a compile error, not a 404 at
runtime.

## GraphQL transport

`src/apollo/` holds the client: one `ApolloClient`, one normalized cache, two transports.

| File        | Contents                                                                             |
| ----------- | ------------------------------------------------------------------------------------ |
| `links.ts`  | HTTP link, `graphql-ws` client, the split by operation type, the reconnection budget |
| `cache.ts`  | `InMemoryCache` with the `LogMessage` type policy                                    |
| `client.ts` | `createApolloClient({ webSocketClient?, cache? })`, a factory like `createAppRouter` |

Both links address the **relative** path `/graphql`, and the WebSocket URL is derived from `window.location` (`ws://` or
`wss://` to match the page). That is what keeps the browser on one origin: the dev-server proxy forwards both the POST
requests and the `graphql-ws` upgrade, so the API_Service needs no CORS allowance. An absolute URL to the API port would
need one.

Queries and mutations take the HTTP link, subscriptions the WebSocket link; `split` decides per operation. One client
over two transports rather than two clients, so a message arriving over the socket lands in the same normalized entry as
the same message loaded by the history query.

`LogMessage` is keyed by `['runId', 'sequence']` instead of by `id`. After a reconnect the Log_View re-runs
`logMessages(runId, afterSequence)` and then re-subscribes, so history and live stream overlap and deliver messages
twice (12.9); the key collapses the duplicate into one entry, and it also rejects two different rows claiming the same
position in the run.

The `graphql-ws` client retries at most `LOG_STREAM_MAX_RECONNECT_ATTEMPTS` (5) times, waiting
`LOG_STREAM_RECONNECT_DELAY_MS` (2000) between attempts — the budget of Requirement 12.11. The library default is a
randomised backoff starting below 2 seconds, which would break the lower bound, so both values are set explicitly and
exported for the hook that renders the interruption hint.

It connects lazily: the socket opens with the first subscription, so a session that never starts a Scrape_Run holds no
connection open.

`ApolloProvider` is wired in `src/main.tsx`, not in `__root.tsx`. It renders no markup, and a component test supplies
its own client — a provider inside the root route would force every test through the real transports.

### What task 18.2 needs from this

`createApolloClient()` creates its own `graphql-ws` client when none is passed. The `useLogStream` hook needs the
connection lifecycle (`client.on('connected' | 'closed' | 'error')`) for its connection-state union and for re-running
the history query before re-subscribing, so build the socket client explicitly with `createGraphQLWsClient()`, keep the
reference, and hand it to `createApolloClient({ webSocketClient })`. Two clients would mean two sockets.

The cache deduplicates `LogMessage` entries but does not merge the `logMessages` field across different `afterSequence`
arguments — Apollo caches that field per argument set. Assembling history plus live messages into one gapless list is
the hook's job (or a `Query.logMessages` field policy with `keyArgs: ['runId']`, which is a decision for 18.2, not for
the transport).

`src/testing/graphql-ws-fake.ts` holds `FakeWebSocketClient`, a `graphql-ws` client that opens no socket, records the
subscribe payloads and replays fixed results. Repeat a `(runId, sequence)` pair in those results to simulate a reconnect
overlap.

## German strings

`src/i18n/de.ts` exports one `const` object, `de`, with every German string the Web_App writes itself (2.1). No German
literal belongs in a component: a string in a component is one nobody can review against a requirement, and a dozen
wordings are pinned literally by the requirements.

The module holds **only** the strings no backend value carries — labels, headings, button captions, column titles, the
option labels of the filters and of the sorting, the empty states of 10.12 and 10.13, the hint 11.6 shows in place of
the run counters, the pointer to the Steering_Docs of 4.13, and the two Log_Stream connection texts of 12.11 and 12.12,
which are the Web_App's because the connection breaks in the browser and the server logs nothing about it.

Everything that explains a failure or states a stored value already arrives in German over GraphQL and is rendered
unchanged:

| Text                                                                         | Source                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Failure of a run, a Platform, an enrichment stage or a write (2.5)           | GraphQL error message or payload field, from `common/error-mapping.ts`                                  |
| Platform_Status label, Run_Outcome label, incompleteness hint of 7.4         | API_Service (`PLATFORM_STATUS_LABELS_DE`, `RUN_OUTCOME_LABELS_DE`)                                      |
| `38 Min. (Fahrrad)` / `Erreichbarkeit unbekannt`                             | `JobPosting.bestCommuteLabelDe` (8.4, 8.13, 10.1)                                                       |
| Relevance_Reason, log message text                                           | `JobPosting.relevanceReason`, `LogMessage.messageDe`                                                    |
| "A Scrape_Run is already running", rejected cancellation, private-use notice | `StartScrapeRunPayload.hintDe`, `CancelScrapeRunPayload.rejectedReasonDe`, `AppInfo.privateUseNoticeDe` |
| A resolved Criterion_Field value                                             | `EffectiveCriterion.valueText`                                                                          |

### Conventions for tasks 17 to 19

1. **Need a string? Add it to `de.ts` first.** Put it in the namespace of the view that renders it, with a doc comment
   naming the requirement that asks for it. Then reference `de.<namespace>.<key>` in the component.
2. **Check first whether the API_Service already sends it.** A German sentence about a failure or about a stored value
   has an owner on the server; render that value instead of writing a second wording of it.
3. **Need a German label for Platform_Status or Run_Outcome?** Do not add one here. Add a resolved field on the API side
   that re-exports the existing label map — the way `JobPosting.bestCommuteLabelDe` does — so the closed vocabularies
   keep exactly one German wording. This affects the run summary of 18.3, the counters of 11.5 and the per-Platform
   block of 19.1.
4. **Numbers go through a function.** `de.pagination.position(2, 7)` returns `Seite 2 von 7`; a component that assembled
   it from a format string would hold the German word `von`.
5. **Maps over a closed vocabulary carry `satisfies Readonly<Record<X, string>>`** with `X` imported **as a type** from
   `@job-scraper/domain`, so a missing or an extra key fails `pnpm check-types`. The import must stay type-only: that
   package reaches `node:crypto` and `fast-check` through its index, which have no business in a browser bundle.
   Vocabularies that exist only in the GraphQL schema (reachability, the sort keys, the sort direction) are plain
   `as const` maps — the generated enum of task 16.3 is their authority, and indexing the map with a generated value is
   what checks it.

## Routing conventions

Routes are files under `src/routes`, named after the URL segment in kebab-case. The route tree is derived from the file
names; there is no route table to keep in sync.

```text
src/routes/
├── __root.tsx          shell: skip link, focus indicator, error boundary, landing hint (16.5)
├── index.tsx           landing page at /
├── postings/
│   ├── index.tsx       /postings
│   └── $postingId.tsx  /postings/:postingId
├── criteria.tsx        /criteria
└── runs.$runId.log.tsx /runs/:runId/log
```

Colocated tests live in `src/routes/**/__tests__/`. The generator is configured with
`routeFileIgnorePattern: '__tests__|\.test\.'`, so a test file next to a route is never mistaken for a route of its own.

## GraphQL operations and typed hooks

The API_Service is code-first NestJS: `apps/api/src/schema.gql` is generated from its resolver decorators and is the
contract between the two apps. `codegen.ts` reads that file and turns every `.graphql` operation under `src` into typed
React hooks, so a field the API_Service does not have, or a variable of the wrong type, fails `pnpm check-types` instead
of the browser.

### Adding an operation

1. Write the operation into a `.graphql` file next to the component that sends it —
   `src/routes/postings/postings.graphql` next to `src/routes/postings/index.tsx`. One file may hold several operations;
   name each one in `PascalCase`, because the hook name is derived from it (`query JobPostings` →
   `useJobPostingsQuery`).
2. Run `pnpm codegen` from the repository root. It refreshes `apps/api/src/schema.gql` first and then generates, so a
   resolver added minutes ago is already visible.
3. Import the hook from the generated file next to the operation:
   `import { useJobPostingsQuery } from './postings.generated'`.

For a query the generator emits `use…Query`, `use…LazyQuery` and `use…SuspenseQuery`; for a mutation `use…Mutation`; for
a subscription `use…Subscription`. The document (`…Document`) and the result and variable types (`…Query`,
`…QueryVariables`) are exported from the same file, which is what a non-hook call site — an Apollo Client `cache.watch`,
a Playwright fixture, a test — uses.

`src/graphql/health.graphql` is the one operation that belongs to the transport rather than to a view: it is the
liveness probe of the API_Service and is what the Apollo Client setup and
`src/graphql/__tests__/generated-hooks.test.ts` use to prove the connection and the generator work.

### Schema types

`src/graphql/schema.generated.ts` holds the schema types once for the whole app: every object and input type, and every
closed value list as a string union (`Platform`, `PostingStatus`, `InterestFlag`, `RelevanceVerdict`, `RunStatus`, …).
They are string unions rather than TypeScript `enum` objects on purpose — the value lists are declared in
`packages/domain` and travel through the schema from there, so the browser bundle carries no second runtime copy of
them. The German string module maps those union members to their labels.

`DateTime` arrives as `string`: ISO 8601 text, exactly as it is on the wire. `strictScalars` is on, so a new custom
scalar in the schema fails generation instead of becoming an untyped value.

### Keeping it current

Generation is wired into the Turborepo graph, not left to memory: `codegen` depends on
`@job-scraper/api#schema:generate`, and the `build`, `check-types`, `test` and `lint` tasks of this package depend on
`codegen`. Running any of them — or `pnpm codegen` on its own — produces current output; there is no state in which the
generated files can be older than the schema or the operations.

## Generated files

`src/graphql/schema.generated.ts` and every `<name>.generated.ts` next to a `.graphql` file are written by GraphQL Code
Generator and never hand-edited; each one carries a header saying so. They are tracked in Git so that a fresh clone
type-checks before anything is generated, and they are excluded from Prettier and from ESLint (`**/*.generated.ts` in
`.prettierignore` and in the shared ESLint ignore list).

The per-operation files additionally carry `@ts-nocheck`. The reason is in `codegen.ts`: the hook generator still emits
the Apollo Client 3 shape of the `useSuspenseQuery` overloads, which does not type-check against the Apollo Client 4
this app uses, and it emits a type-only namespace import that an operation without enum arguments never uses. Both are
properties of the generated text. Nothing is lost at the call sites — the operations are validated against the schema by
the generator, every exported type is checked wherever it is used, and `src/graphql/__tests__/generated-hooks.test.ts`
asserts with `@ts-expect-error` that a wrong result shape, an unknown field and an invalid hook option are still errors.

`src/routeTree.gen.ts` is generated by the TanStack Router Vite plugin and never hand-edited. It is tracked in Git so
that `pnpm check-types` works on a fresh clone without a build step first, and it is excluded from Prettier and from
ESLint (`**/*.gen.ts` in `.prettierignore` and in the shared ESLint ignore list). The plugin rewrites it whenever
`pnpm dev`, `pnpm build` or `pnpm test` runs, so adding a route file is enough — there is no separate generate step to
remember.

## Configuration

`vite.config.ts` is also the Vitest configuration. One file rather than two: the test run needs exactly the same
transform pipeline as the dev server, and a second file would have to repeat it and could drift.

The configuration reads the single environment file at the repository root (1.12): `WEB_PORT` for its own port,
`API_PORT` for the proxy target. `envPrefix` stays at the default `VITE_`, so no secret from that file can reach the
browser bundle even though the config itself reads the whole file in Node.

The dev server binds `127.0.0.1` with `strictPort`, like the API_Service does. There is no deployment target (1.16), and
an occupied port has to be reported as such by the Start_Script (1.11) rather than silently replaced by the next free
one.

`/graphql` is proxied to the API_Service with `ws: true`. Queries, mutations and the Log_Stream subscription share that
one path (`GRAPHQL_PATH` in `apps/api/src/graphql/schema-options.ts`), so the browser stays on a single origin: the
API_Service needs no CORS allowance, and the WebSocket upgrade of `graphql-ws` travels the same route.

`tsconfig.json` extends `@job-scraper/typescript-config/react.json`, the ESM/bundler variant of the shared strict base.
There is no `tsconfig.build.json` counterpart as in `apps/api`: Vite does the transpilation, so `tsc` only ever
type-checks.

`eslint.config.mjs` re-exports `@job-scraper/eslint-config/react`, which adds the `jsx-a11y` recommended rules and the
two `react-hooks` rules on top of the shared base config. The accessibility rules are the cheap half of Requirement 2.3
— a missing form label is caught at lint time instead of by the `@axe-core/playwright` checks much later.

## Tests

Component tests are Vitest with jsdom and Testing Library, at `src/**/__tests__/<name>.test.tsx`. Vitest runs with
`globals: false`, so `describe`, `it` and `expect` are imported from `vitest`. `src/testing/setup.ts` registers the
`jest-dom` matchers and the unmount after each test.

The Playwright specs of `apps/web/e2e` are `*.spec.ts` and are run by `pnpm test:e2e` (task 21.1). The Vitest `include`
pattern covers `src` only, so the two suites never pick up each other's files.

## Scripts

| Script             | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `pnpm dev`         | Vite dev server on `127.0.0.1:$WEB_PORT`, proxying `/graphql` |
| `pnpm build`       | Production bundle into `dist/`                                |
| `pnpm preview`     | Serve the built bundle on the same host and port              |
| `pnpm codegen`     | Regenerate the schema types and the typed hooks               |
| `pnpm check-types` | `tsc --noEmit` over `src`, `codegen.ts` and `vite.config.ts`  |
| `pnpm lint`        | ESLint with auto-fix                                          |
| `pnpm test`        | Vitest with jsdom; add `--run` for a single pass              |
