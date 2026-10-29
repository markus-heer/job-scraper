---
inclusion: always
---

# Local development and start flow

This document answers Requirement 16.4: the steps of the Start_Script, how the PostgreSQL
container and the Prisma migrations are handled, and the five quality steps with the
command for each. It is written for a developer who has just cloned the repository.
Capitalised terms are defined in the glossary of
`.kiro/specs/job-search-tool/requirements.md` and are used unchanged (16.10).

`inclusion: always` is deliberate. The quality gate below is the closing step of **every**
change in this repository, and the two gotchas at the end cost real time whenever they are
rediscovered. There is no file pattern that would scope "run these five commands before you
call the work done", so a `fileMatch` doc would be loaded exactly when it is not needed.
`scripts/README.md` is the complement to this file: it is for someone editing the
Start_Script, this one is for someone running it.

## Local development and start flow

### First run after cloning

1. Node 22 or newer and pnpm 11.4.0 (`packageManager` in the root `package.json`).
2. A container runtime that answers `docker info`. Docker Desktop on macOS.
3. `cp .env.example .env`, then fill in every key. `.env` is never committed. All keys of
   `REQUIRED_ENV_KEYS` (`apps/api/src/config/env.schema.ts`) must be present and non-empty;
   `POSTGRES_PORT` is read by `docker-compose.yml` only and `SCRAPER_FIXTURE_MODE` is the
   E2E switch, which stays empty.
4. `pnpm start`.

### The configuration check before step 1

Before step 1 runs, `scripts/lib/env-check.mjs` reads the local environment file and names
**every** missing or empty key at once (1.15). It is not one of the seven steps and prints
no progress line. It runs first on purpose: without it a missing `DATABASE_URL` would be
noticed in step 4, after a pull, an install and possibly a browser download. The list of
required keys is not kept in the Start_Script — it is read out of
`apps/api/src/config/env.schema.ts`, the same declaration the API_Service validates
against, so the two cannot drift apart. No configuration **value** ever reaches the
console, only key names.

### The seven steps of `pnpm start`

`pnpm start` runs `scripts/start.mjs`, which performs these steps in exactly this order and
begins each one only after the preceding one has confirmed itself ready (1.1). The
numbering is authoritative in `scripts/lib/steps.mjs` (`START_STEPS`, `TOTAL_STEP_COUNT`),
the order in `scripts/lib/run-start.mjs`. Each step prints one German progress line
("Schritt 3 von 7 …", 1.2).

| # | Step                     | What it does                                                                                      | Module               |
| - | ------------------------ | ------------------------------------------------------------------------------------------------- | -------------------- |
| 1 | `git pull --ff-only`     | Updates the project. Skipped with a warning when the working tree is dirty or the pull fails; the start continues with step 2. Nothing destructive: no `reset`, no forced checkout, no `clean`, no merge commit (1.3 – 1.5) | `git-step.mjs`       |
| 2 | `pnpm install`           | Installs dependencies. A failure ends the start (1.6)                                              | `dependency-step.mjs`|
| 3 | Playwright browser files | Asks Playwright for its own install plan for **Chromium** and installs only the locations that are missing. Presence is decided by Playwright's completion marker, not by a directory existing. A failure ends the start (1.7) | `browser-step.mjs`   |
| 4 | PostgreSQL container     | Probes the container runtime first, then starts or reuses `job-tool-postgres` and waits for its health check                                       | `postgres-step.mjs`  |
| 5 | Prisma migrations        | `prisma migrate deploy` against the Posting_Store                                                  | `prisma-step.mjs`    |
| 6 | API_Service              | Builds through Turborepo, starts `node dist/main.js`, then confirms readiness with the GraphQL `health` query                                        | `api-step.mjs`       |
| 7 | Web_App                  | Serves the Web_App and prints its complete callable local URL within 5 seconds of it accepting requests (1.9)                                           | `web-step.mjs`       |

`pnpm start` does not return. Steps 6 and 7 run as children of the Start_Script, which stays
as their supervisor; Ctrl+C ends all three. A readiness gate looks every 2 seconds and gives
up after 60 (1.11), and a failed gate stops the start and also stops the services this run
had already launched. A service that was only *found* running is reused and never stopped.

`pnpm start --offline` is the switch of 1.8: it skips step 1 and step 2 — the only two that
need the network — and begins with step 3.

### Container handling

`docker-compose.yml` describes the single container the Job_Tool needs.

- Compose project `job-tool`, container name `job-tool-postgres`, image
  `postgres:16-alpine`. A second container of that name cannot exist.
- `restart: unless-stopped`, so a later start finds it already accepting connections and
  reuses it (1.10). Step 4 reads the service state first and runs no `up` at all when the
  container is running and healthy; where an `up` does run, it runs with `--no-recreate`.
- Data lives in the named volume `job-tool-postgres-data` and outlives the container. Step 4
  contains no `down`, no `--force-recreate`, no `--volumes` and no `rm`.
- The port is published as `127.0.0.1:${POSTGRES_PORT}:5432` — **loopback only**, never
  reachable from the network.
- **The host port is 55432, not 5432.** On a development machine 5432 is regularly taken by
  another PostgreSQL. `DATABASE_URL` in `.env` is the single source of truth for the
  connection: the Start_Script derives the port, user, password and database name it hands
  to Compose from it. `POSTGRES_PORT=55432` is written out in `.env.example` next to a
  `DATABASE_URL` naming 55432 so that a plain `docker compose up -d` binds the same port.
- Credentials and the database name are applied by PostgreSQL on **first** start only.
  Changing them after the volume exists has no effect until the volume is removed.

### Migration handling

- `apps/api/prisma/schema.prisma` is the single source of truth for the database;
  migrations live in `apps/api/prisma/migrations/`.
- Step 5 runs **`prisma migrate deploy`**, never `migrate dev`. `deploy` applies each
  pending migration once in ascending order and never generates, resets or drops anything.
  `migrate dev` would offer to reset the user's own Posting_Store, which 1.10 and 1.14
  forbid. The integration harness (`apps/api/src/testing/postgres-harness.ts`) uses the
  same command, so the start and the test suite migrate identically.
- A failed migration stops the start before the API_Service and the Web_App are started,
  names the failed migration and leaves the stored data unchanged (1.14).
- To author a new migration, run `pnpm --filter @job-scraper/api prisma:migrate` by hand.
  It is deliberately not part of the start flow.

### Troubleshooting by exit code

The Start_Script exits with a distinct code per cause (`EXIT_CODES` in
`scripts/lib/errors.mjs`), so a failure is identifiable without reading the German text.

| Code | Cause                                          | First thing to try                                     |
| ---- | ---------------------------------------------- | ------------------------------------------------------ |
| 2    | `pnpm install` failed                          | Read the reported cause; check the lockfile            |
| 3, 4 | Browser files unreadable / install failed      | `pnpm --filter @job-scraper/scrapers exec playwright install chromium` |
| 5    | Container runtime unreachable                  | Start Docker                                           |
| 6, 7 | Container could not start / did not become healthy | `docker compose ps`, `docker compose logs postgres` |
| 8    | A Prisma migration failed                      | The message names it; a half-applied row may need `prisma migrate resolve` |
| 9    | A required configuration key is missing or empty | Compare `.env` against `.env.example`                |
| 10   | `API_PORT` or `WEB_PORT` is not a usable port   | Fix the value in `.env`                                |
| 11   | The required-key declaration could not be read | A defect in the repository, not a configuration error  |
| 12   | The API_Service did not compile                | `pnpm check-types`, then `pnpm build`                  |
| 13, 14 | API_Service / Web_App not ready in 60 s      | The message says unreachable or port occupied; free the port |
| 15   | A service that was ready ended on its own      | Read its output above the error line                   |
| 70   | Unclassified failure                           | A defect in the Start_Script                           |

### The five quality steps

Run these, in this order, before calling any change complete. Every command is a script of
the root `package.json` and is run from the repository root.

| # | Step       | Command            | Behind it                           |
| - | ---------- | ------------------ | ----------------------------------- |
| 1 | Format     | `pnpm format`      | `prettier --write .`                |
| 2 | Lint       | `pnpm lint`        | `turbo run lint`; ESLint with `--fix` per package |
| 3 | Type-check | `pnpm check-types` | `turbo run check-types`; `tsc --noEmit` per package |
| 4 | Build      | `pnpm build`       | `turbo run build`                   |
| 5 | Test       | `pnpm test`        | `turbo run test -- --run`; Vitest, one run, no watch |

`.kiro/` is listed in `.prettierignore`, so a change to a Steering_Doc or a spec document is
not reformatted by step 1 — but run it anyway, because it is one command and it catches a
stray file elsewhere. Other paths excluded from formatting are the generated artefacts and
the captured Platform fixtures, which must stay byte-identical to the retrieved page.

### Suites that `pnpm test` does not run

`pnpm test` is the suite that needs nothing but Node. These three are separate and will
never run on their own, so run them deliberately when you touch what they cover.

| Command                | Needs                    | What it covers                                                                                   |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `pnpm test:integration`| Docker                   | Starts throwaway PostgreSQL containers through Testcontainers. **Six correctness properties run only here** — see below |
| `pnpm test:e2e`        | Docker                   | Playwright against the Web_App. Runs the API_Service in `SCRAPER_FIXTURE_MODE` against a throwaway `jobtool_test` container, so no request to a Platform, the Routing_Provider or the AI_Provider leaves the machine |
| `pnpm test:live`       | Network and real API keys| The six `@live` smoke tests, skipped by default. Four perform one real Result_Page request per Platform; two ask the Routing_Provider and the AI_Provider. They answer the one question a frozen fixture cannot: does the third party still speak the shape the fixtures were written against |

**Six correctness properties of the design are proven by `pnpm test:integration` and by nothing
else**, because each one is a statement about what PostgreSQL does rather than about a pure
function: 07 (upsert idempotence), 08 (upsert preservation), 09 (the gated status sweep), 24
(conjunctive filters), 27 (the new-marking set) and 29 (the reported counters). A green
`pnpm test` proves none of them. Run the integration suite after touching
`apps/api/src/posting/`, the status sweep, the read layer or the run counters — and read the
count it reports rather than only its exit code.

`test:e2e` never touches the developer's Posting_Store: fixture mode refuses to start unless
`DATABASE_URL` names a database whose name ends in `_test`. `test:live` needs one opt-in
variable per provider — `SCRAPER_LIVE_SMOKE` plus `USER_AGENT_CONTACT` for the four Platform,
`ROUTING_LIVE_SMOKE` plus `ROUTING_API_KEY` for HeiGIT, `RELEVANCE_LIVE_SMOKE` plus
`ANTHROPIC_API_KEY` for Anthropic — and all six are declared for the task in `turbo.json`.
Because this repository forbids a `VAR=value` command prefix (see below), put the `export`
lines and the `pnpm test:live` call into a script file and run that file. The details of the
Platform half are in `packages/scrapers/README.md`.

### Code generation

Run `pnpm codegen` **from the repository root** after changing the GraphQL schema or a
GraphQL operation. The task generates `apps/api/src/schema.gql` from the resolver decorators
first (code-first NestJS) and then the typed hooks of the Web_App from that file.

These files are generated and must never be hand-edited:
`apps/api/src/schema.gql`, every `*.generated.ts` under `apps/web/src`, and
`apps/web/src/routeTree.gen.ts`. The Prisma client is generated too, by the `postinstall`
hook of `apps/api`.

### Two gotchas

- **`pnpm test --force` fails.** The root script is `turbo run test -- --run`, so the flag is
  forwarded past Turborepo and reaches Vitest, which does not know it. To bypass the
  Turborepo cache, run `pnpm turbo run test --force`.
- **Never prefix a command with an environment variable assignment.** `VAR=value cmd` and
  `env VAR=value cmd` are both out. A command starts with the name of the program. Put the
  value in `.env`, use a native flag of the tool, add a script to `package.json`, or write
  the `export` lines into a script file and run that. The Start_Script follows the same rule
  structurally: it spawns without a shell and hands values through the child environment of
  the runner, so a prefix would not even be parsed. A corollary that applies to any shell
  command here: multi-line shell logic goes into a file, never inline.

## Related Steering_Docs

- Project context, the operating model and the language convention: `project-context.md`.
- The conventions every Platform_Adapter follows, including the steps for adding one.
- The conventions of the Relevance_Service and the Search_Profile constants, including where
  the Default_Search_Profile and every Platform_Override live and how a change takes effect.
