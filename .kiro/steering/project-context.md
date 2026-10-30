---
inclusion: always
---

# Project context and language convention

This document is the entry point for anyone working on the Job_Tool. It states what the
Job_Tool is for, who uses it, how it runs and which language each kind of text is written
in. Requirements 16.2, 16.8, 16.9 and 16.10 are what it answers; the acceptance criteria
themselves live in `.kiro/specs/job-search-tool/requirements.md`, and the glossary at the
top of that file defines every capitalised term used here.

`inclusion: always` is deliberate. The language convention and the German-text ownership
rule below decide the wording of almost every file in this repository — a GraphQL field, a
German label, a code comment — so there is no file pattern that could sensibly scope them.
The other Steering_Docs cover topics that only apply while a particular area is being
touched; this one applies to every change.

## Purpose

The Job_Tool is a job search tool that retrieves job postings from four job platforms
(Glassdoor, Jobvector, Indeed, Stepstone) with Playwright, normalizes each one into a
Job_Posting, has it assessed for relevance by a Large Language Model through the
AI_Provider, determines the commute from a configurable home address to the work location
through the Routing_Provider, and stores the result in the Posting_Store so the user can
review it in the Web_App.

The user reviews Job_Posting in the Web_App, reads the Relevance_Reason of each one, sets
an Interest_Flag, inspects the effective search criteria read-only, starts a Scrape_Run and
watches its progress in the Log_View.

## The single target user

There is exactly one user, and that user is not a technical person. Three consequences
shape the product and should be kept in mind for every change:

- **No configuration through the user interface.** Search criteria are TypeScript
  constants: `DEFAULT_SEARCH_PROFILE` and `PLATFORM_OVERRIDES` in
  `packages/domain/src/search-profile/constants.ts`. A developer edits that file and
  restarts the API_Service; the Web_App shows the effective Criterion_Field values
  read-only. The same holds for which Platform is activated and for the Commute_Threshold
  and the home address, which come from the environment file.
- **Every text the user sees must be a complete, self-explanatory German sentence.** A
  Platform_Status, a Run_Outcome, a failure or a Partial_Result reaches the user as German
  prose, never as an enum value, an exception class or an HTTP status code.
- **No multi-user concern.** There are no accounts, no roles and no authentication layer,
  which is only acceptable because of the operating model below.

## Operating model: local, one machine, no cloud deployment

The Job_Tool runs on one developer machine. There is no deployment target, no hosting, no
container registry and no CI-driven release of the application itself.

- **Posting_Store.** PostgreSQL 16 in a Docker container, defined in `docker-compose.yml`
  as the container `job-tool-postgres` with the Compose project `job-tool`. It is the only
  container the Job_Tool needs. Data lives in the named volume
  `job-tool-postgres-data`, so a Job_Posting, a Scrape_Run and a stored relevance
  assessment survive a container restart or recreation.
- **Ports are bound to the loopback interface only.** The container publishes
  `127.0.0.1:${POSTGRES_PORT}:5432`, the API_Service binds `API_HOST = '127.0.0.1'` in
  `apps/api/src/main.ts`, and the Vite server binds `host: '127.0.0.1'` with
  `strictPort: true` in `apps/web/vite.config.ts`. Nothing the Job_Tool opens is reachable
  from the network. That is what makes the absent authentication layer tolerable in front
  of a GraphQL endpoint that can start browser automation, and it must stay true.
- **The host port of the Posting_Store is 55432, not 5432.** On a development machine the
  PostgreSQL default port is regularly taken by another PostgreSQL, and the Job_Tool must
  not compete for it. `DATABASE_URL` in `.env` is the single source of truth for the
  connection; `POSTGRES_PORT` must name the same port and exists so a plain
  `docker compose up -d` binds what the connection string says.
- **"Local" does not mean offline.** Platform requests, Routing_Provider queries and
  AI_Provider requests leave the machine by design. Only the data and the services stay
  here.
- **Configuration.** Copy `.env.example` to `.env` and fill it in. `.env` is never
  committed. All 15 keys in `REQUIRED_ENV_KEYS`
  (`apps/api/src/config/env.schema.ts`) are required: a missing or empty one stops the
  start and is reported by name. `POSTGRES_PORT` is read by `docker-compose.yml` only, and
  `SCRAPER_FIXTURE_MODE` is the E2E test switch, which is the one key the API_Service reads
  without requiring it and which nobody should set by hand.
- **Start.** `pnpm start` runs the Start_Script (`scripts/start.mjs`), which checks the
  configuration and then performs seven fixed steps up to serving the Web_App. The steps,
  the `--offline` switch and the quality commands are described in the Steering_Doc on
  local development and the start flow.

## Repository layout

Turborepo with pnpm workspaces; internal packages are referenced as `workspace:*`.

| Path                 | Contents                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `apps/api`           | API_Service: NestJS, GraphQL code-first, Prisma. `schema.gql` is generated, never hand-edited |
| `apps/web`           | Web_App: React, Vite, TanStack Router, Apollo Client, generated typed hooks, Playwright E2E   |
| `packages/domain`    | Closed vocabularies, Search_Profile constants and the Profile_Resolver, shared by both apps  |
| `packages/scrapers`  | Scraper_Service runtime, every Platform_Adapter, robots handling, Platform fixtures          |
| `scripts`            | The Start_Script and its step modules under `scripts/lib`                                     |
| `packages/*-config`  | Shared ESLint and TypeScript configuration                                                    |
| `.kiro/specs`        | Requirements, design and tasks of the Job_Tool                                                 |
| `.kiro/steering`     | The Steering_Docs, including this file                                                         |

A domain type or an enum belongs in `packages/domain` and is never re-declared in an app.

Two further topics have their own Steering_Doc in `.kiro/steering/` and are deliberately not
repeated here: the conventions every Platform_Adapter follows, and the conventions of the
Relevance_Service together with the search profile constants.

## Language convention (16.8, 16.10)

**English:** the requirements, the design, the Steering_Docs, all source code, all
identifiers and all code comments. Commit messages and pull request descriptions as well.

**German:** everything the user reads. Every label, heading, button caption, status text and
error message of the Web_App, and every Relevance_Reason.

The requirements are written in English and therefore demand German output explicitly
wherever the user sees the text. When adding a user-visible string, write it in German and
name the acceptance criterion it satisfies in a comment above it.

Use the glossary terms of `requirements.md` unchanged, in code comments as much as in
documents: `Job_Posting`, not "posting record"; `Best_Commute_Time`, not "best travel
time"; `Relevance_Reason`, `Platform_Status`, `Run_Outcome`, `Partial_Result`,
`Interest_Flag`, `Criterion_Field`, `Commute_Threshold`, `Log_Stream`, `Log_View`,
`Posting_Store`, `Platform_Adapter`, `Platform_Override`, `Default_Search_Profile`,
`Scrape_Run`, `Start_Script`, `Steering_Docs`, `AI_Provider`, `Routing_Provider`,
`Relevance_Service`, `API_Service`, `Web_App`. One term per concept keeps a requirement,
the code that implements it and the test that checks it searchable as one unit.

## Who owns which German sentence

German text has one owner per sentence. This is the rule most easily broken by accident, and
the mistake it prevents is a contributor adding a Platform_Status label to the Web_App.

**The API_Service owns every German sentence that explains a failure or states a stored
value.** It travels over the wire in a GraphQL field:

| German text                                                            | Where it lives                                                               |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Failure of a Scrape_Run, a Platform, an enrichment stage or a write     | `apps/api/src/common/error-mapping.ts`                                       |
| Platform_Status labels (14 values)                                      | `PLATFORM_STATUS_LABELS_DE`, on the wire as `platformStatusLabelDe`          |
| Run_Outcome labels (3 values)                                           | `RUN_OUTCOME_LABELS_DE`, on the wire as `runOutcomeLabelDe`                  |
| The Partial_Result hint shown above an incomplete result list           | `RESULT_INCOMPLETE_HINT_DE` in `error-mapping.ts`                            |
| Log_Stream message text                                                 | `LogMessage.messageDe`                                                       |
| Best_Commute_Time as a line, including "unknown"                        | `JobPosting.bestCommuteLabelDe`                                              |
| Relevance_Reason                                                        | `JobPosting.relevanceReason`, written by the AI_Provider                     |
| A resolved Criterion_Field value                                        | `EffectiveCriterion.valueText`                                               |
| Startup console output: invalid Default_Search_Profile, missing env key | `apps/api/src/profile/profile.messages.ts`, `apps/api/src/config/config.messages.ts` |

**The Web_App owns its own captions, headings and browser-side transport hints**, all of
them in `apps/web/src/i18n/de.ts`: labels, column titles, button captions, filter and sort
option labels, empty states, and the two Log_Stream connection texts — those are the
Web_App's because the connection breaks in the browser and the server logs nothing about
it.

The manual Relevance_Verdict control of 15.15 (`de.postings.verdictControl`) is the clearest
example of where that line runs. The Web_App owns the group heading, the field label for the
reason and the three button captions, and it builds each caption from
`de.vocabulary.relevanceVerdict` rather than spelling a verdict a second time. What it does
**not** own is the reason that gets stored: `JobPosting.relevanceReason` is an API_Service
field, so the user types their own sentence or none at all, and an empty field stores `null`.
A German sentence invented in the Web_App and written into that column would be shown under
"Begründung" forever as though somebody had meant it.

Two rules follow from the split:

1. **Never copy a German sentence across the line.** A Platform_Status or Run_Outcome label
   in `de.ts` would be a second wording of a closed value list and will drift from the
   first. Take the label from the API_Service field instead, the same way the commute line
   arrives as `bestCommuteLabelDe`.
2. **No German literal inside a React component.** It goes into `de.ts`, where it can be
   reviewed against the requirement named in the comment above it.

`de.ts` carries this ownership table at the top and `error-mapping.ts` records which
failures are deliberately unmapped; read both before adding German text on either side.
