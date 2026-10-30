# Design — Blocked Platform retrieval

> **Status: this is the plan as written, not the state as built.** The Stepstone half was
> implemented as described. The scope then grew to "every Platform's result list is read to its
> end", which added requirements 13.3 and 13.10 – 13.14 and replaced the Glassdoor one-page cap with
> the `load-more` pagination of 13.12 — so this document's references to `GLASSDOOR_RESULT_PAGE_LIMIT`
> and to a ten-page budget are historical. See the status note at the top of `tasks.md`, and
> `.kiro/steering/platform-adapter-conventions.md` for the conventions as they now stand.

## Overview

Two Platform report nothing. One is a Job_Tool defect with a complete fix; the other is a Platform
refusal with no fix this project is willing to build. The design treats them separately throughout,
and the only thing they share is the Log_View line the user reads.

**Stepstone.** The robots.txt of `www.stepstone.de` allows the result list path and allows it to
carry the single query parameter `q`. The Job_Tool builds four parameters, every one of which is
forbidden in combination, so `ScraperService` resolves the ten intended Result_Page paths, finds them
disallowed and ends the Platform with `EXCLUDED_BY_ROBOTS_TXT` before any page request. The fix is to
build the Permitted_Query_Shape. Three Criterion_Field and nine Result_Page are lost; the Platform
starts contributing Job_Posting. This is task 24.3 applied to a second Platform, and the Indeed files
are the pattern to copy rather than a precedent to argue about.

**Jobvector.** Both `/robots.txt` and the result list answer HTTP 403 to the honest user agent. The
Platform admits indexing crawlers and refuses this client, which is a technical access control rather
than a politeness convention. Requirements 14.5 and 7.6 already forbid the three ways past it —
imitating a browser, patching the automation fingerprint, answering a Captcha — so Requirement 2 of
this spec writes that boundary down as a testable property instead of leaving it as a convention, and
Requirement 4 does the two things that remain useful: read an interface Jobvector publishes *for*
machines if it has one, and otherwise deactivate the Platform the way Indeed already is.

What this design deliberately does not contain: a robots.txt override key, a per-Platform user agent,
a stealth layer, a Captcha path, and any change to `RobotsCache` or to the robots gate in
`ScraperService`. The gate was right. The URL was wrong.

## Architecture

Nothing moves between layers. Four of the five edited areas are inside one Platform_Adapter, and the
fifth is a header pair in the shared Playwright runtime.

```text
packages/domain/src/search-profile/
  capabilities.ts ....... STEPSTONE.supportedFields loses three fields       (R1.5)
  constants.ts .......... PLATFORM_OVERRIDES.STEPSTONE removed               (R1.6)
                          PLATFORM_ACTIVATION.JOBVECTOR -> false             (R4.5)

packages/scrapers/src/adapters/stepstone/
  result-list-url.ts .... the Permitted_Query_Shape, STEPSTONE_RESULT_PAGE_LIMIT  (R1.1-1.4, 1.7)
  index.ts .............. effectivePageBudget caps at that limit             (R1.7, 1.8)
  messages.ts ........... the page-limit line names pages read               (R5.2)
  __fixtures__/ ......... stepstone robots.txt stored for the URL test       (R1.9)

packages/scrapers/src/runtime/
  browser.ts ............ Accept-Language and Accept, stated once            (R3.1-3.4)

packages/scrapers/src/adapters/jobvector/
  __fixtures__/ ......... the captured 403                                   (R4.1)

docs/adapters/stepstone.md, docs/adapters/jobvector.md                       (R1.10, 4.2, 4.3, 6.3, 6.4)
.kiro/steering/platform-adapter-conventions.md                               (R6.2)
```

The robots gate stays exactly as it is. `RobotsCache` keeps fetching once per Platform before the
first page request, `robotsPlatformStatus` keeps mapping a disallowed path to
`EXCLUDED_BY_ROBOTS_TXT`, and Property 13 of the parent design keeps holding. The reason the Stepstone
retrieval starts working is that the paths handed to the gate become permitted ones — the gate's
answer changes because its input does.

### Why the capability declaration shrinks rather than the URL silently dropping parameters

Rule 2 of the adapter conventions: a declared Criterion_Field must actually reach the URL. The
alternative — keeping `searchRadiusKm` declared and quietly not sending it — makes the read-only
criteria view of 4.11 display "30 km" for a filter the retrieval never applied. For the single
non-technical user that is worse than the current state: today Stepstone reports an honest exclusion,
whereas a declared-but-dropped radius would report a successful retrieval under a criterion that was
never used. So the declaration follows the URL, and the compiler enforces it: removing the three
fields from `supportedFields` turns `PLATFORM_OVERRIDES.STEPSTONE = { searchRadiusKm: 30 }` into a
type error, which is how 1.6 is discovered rather than remembered.

### What the Stepstone retrieval loses, and what absorbs the loss

| Lost                            | Was                 | What absorbs it                                                        |
| ------------------------------- | ------------------- | ---------------------------------------------------------------------- |
| `searchRadiusKm`                | 30 km around Munich | The Commute_Service rates every work location anyway (8.1), and the Commute_Threshold is the filter the user actually reads |
| `employmentType`                | `PERMANENT`         | The Relevance_Service judges staffing-agency placement versus direct permanent employment as one of its four factors (15.2) |
| `publicationPeriodDays`         | 30 days             | `publishedAt` is parsed per Job_Posting (6.4), so age is available for sorting and filtering after retrieval |
| Result_Page 2 … 10              | up to 10 pages      | Nothing. One page is roughly 25 Job_Posting per Scrape_Run from this Platform |

The first three widen the result list rather than narrowing it, which costs requests, commute lookups
and relevance assessments but not correctness — the same trade the Indeed and Glassdoor decisions
already made. The fourth is a real loss with no compensation, and it is the price of the Platform
publishing no permitted pagination parameter.

### The one behavioural unknown

Whether `?q="Projektmanagerin" OR "Project Manager"` *intersects* with the path's title slug
`/jobs/projektmanagerin/` or *replaces* it is not readable from the robots.txt and not knowable
without a real response. Both shapes are permitted, so this is a tuning question and not a
compliance one:

- If `q` intersects, a profile with synonyms gets a narrower list than the bare path, and the
  synonyms are wasted effort.
- If `q` replaces or widens, carrying the synonyms is strictly better.

The fixture capture of task 3 answers it, and 1.11 is the branch: bare path for every profile, and
`titleSynonyms` leaves the Stepstone declaration too. Until the capture, the builder emits `q` only
when synonyms exist (1.3, 1.4), which is the shape that keeps both outcomes one edit apart.

## Components and Interfaces

### `stepstoneResultListUrl(profile, pageNumber)` — unchanged signature

The exported signature stays, so `PlatformAdapter.resultListUrl` and every caller are untouched. What
changes is the body and the two deletions around it.

```ts
/** The single query parameter a Stepstone result list URL may carry. */
const QUERY_PARAMS = { keywords: 'q' } as const;

/**
 * At most one Result_Page per Scrape_Run: `Disallow: /jobs/*?*` forbids `?page=2` and
 * `Disallow: /jobs/*?q*&*` forbids `?q=…&page=2`, so the second Result_Page has no address the
 * Job_Tool may request (14.2). The same shape as INDEED_RESULT_PAGE_LIMIT, and the one constant
 * that changes if Stepstone ever publishes a permitted pagination parameter.
 */
export const STEPSTONE_RESULT_PAGE_LIMIT = 1;
```

Deleted in the same change, because nothing reads them once the parameters are gone:
`STEPSTONE_RADIUS_STEPS_KM`, `STEPSTONE_AGE_BUCKETS_DAYS`, `STEPSTONE_CONTRACT_TYPES`, the
`raiseToStep` helper, and the four `QUERY_PARAMS` entries other than `keywords`. Their unit tests go
with them. `stepstoneSlug` and `stepstoneKeywordQuery` both stay and are both still exercised: the
slug builds the path, the keyword query builds `q`.

A page number above `STEPSTONE_RESULT_PAGE_LIMIT` still yields a URL rather than throwing, because
`ScraperService` resolves all ten intended paths of 13.3 before the first request; the adapter simply
never requests them. The emitted URL for page 2 is identical to page 1, which is correct — there is no
permitted second address — and the `effectivePageBudget` cap is what guarantees it is never fetched.

### `effectivePageBudget(pageBudget)` in the Stepstone adapter

Copied verbatim from the Indeed adapter, with `INDEED_RESULT_PAGE_LIMIT` replaced:

```ts
const upperBound = Math.min(RESULT_PAGE_BUDGET, STEPSTONE_RESULT_PAGE_LIMIT);
```

A test may shrink the budget below the bound — which keeps the `PAGE_LIMIT_REACHED` path observable —
and nothing can raise it.

### The runtime headers

Stated once in `packages/scrapers/src/runtime/browser.ts` beside the user agent, applied to every
`BrowserContext` and therefore to every Platform:

```ts
/**
 * Content negotiation, not disguise (R3.1 - R3.4). Both headers state something true about this
 * client: it reads German result lists and it reads HTML. Neither claims to be a browser, and no
 * Sec-Ch-Ua* header is sent — those are a browser's statements about itself and sending them would
 * be the Access_Control_Evasion of Requirement 2.
 */
const NEGOTIATION_HEADERS = {
  'accept-language': 'de-DE,de;q=0.9',
  accept: 'text/html,application/xhtml+xml',
} as const;
```

Deliberately not per-adapter configurable (3.3): a header map an adapter could override is a
per-Platform disguise with extra steps.

### What is not added

No `ROBOTS_OVERRIDE` key, no `SCRAPER_USER_AGENT` key, no `playwright-extra`, no `puppeteer-stealth`,
no Captcha path, no proxy configuration. `REQUIRED_ENV_KEYS` is unchanged, so `.env`, `.env.example`
and `scripts/lib/env-check.mjs` are all untouched by this spec.

## Data Models

No Prisma schema change, no migration, no GraphQL schema change, no code generation.

Every value this spec touches is a compile-time constant or a stored fixture:

| Artefact                                      | Shape                                           | Where                       |
| --------------------------------------------- | ----------------------------------------------- | --------------------------- |
| `STEPSTONE_RESULT_PAGE_LIMIT`                 | `1`                                             | `stepstone/result-list-url.ts` |
| `PLATFORM_CAPABILITIES.STEPSTONE.supportedFields` | `['jobTitle', 'titleSynonyms', 'searchLocation']` | `capabilities.ts`      |
| `PLATFORM_CAPABILITIES.STEPSTONE.mandatoryFields` | `['jobTitle', 'searchLocation']` — unchanged | `capabilities.ts`           |
| `PLATFORM_OVERRIDES.STEPSTONE`                | removed                                         | `constants.ts`              |
| `PLATFORM_ACTIVATION.JOBVECTOR`               | `false`                                         | `constants.ts`              |
| `stepstone/__fixtures__/robots.txt`           | the retrieved body plus a `.capture.json` sidecar | `stepstone/__fixtures__/` |
| `jobvector/__fixtures__/blocked-403.*`        | status, headers, body, `provenance: 'CAPTURED'` | `jobvector/__fixtures__/`   |

The existing `ScrapeRunPlatformResult` rows and every stored Job_Posting stay as they are. 4.8 is
satisfied by doing nothing: a deactivated Platform runs no status sweep, and the gate of 9.5 is
already closed for a Platform whose status is not `COMPLETED`.

One read-path consequence worth naming: the criteria view at `/criteria` will show three fewer rows
for Stepstone after this change, and that is the view telling the truth. `PlatformConfigurationService`
resolves in its constructor, so the change takes effect on the next API_Service start with no cache to
invalidate.

## Error Handling

| Condition                                                    | Detection                                            | Behaviour                                                         | Platform_Status           | German text                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------- |
| Stepstone page 1 read, a further page offered                 | the reader reports `hasNextPage` with budget spent   | retrieval ends, postings kept                                     | `PAGE_LIMIT_REACHED`      | existing label; the adapter line names pages read (5.2)        |
| Stepstone page 1 read, result list complete                   | no further page offered                              | retrieval ends                                                    | `COMPLETED`               | existing label                                                 |
| Stepstone robots.txt forbids the permitted shape after all     | the gate reports a disallowed path                   | Platform skipped, remaining Platform keep running                 | `EXCLUDED_BY_ROBOTS_TXT`  | existing sentence, now reserved for a genuine refusal (5.1)    |
| Stepstone robots.txt unreachable                               | the 10 s budget or an unparsable body                | Platform skipped                                                  | `ROBOTS_TXT_UNAVAILABLE`  | existing sentence                                               |
| Jobvector deactivated                                          | `PLATFORM_ACTIVATION.JOBVECTOR === false`            | no request at all, no browser page                                | `DISABLED`                | existing label (4.6)                                           |
| Jobvector reactivated and still refusing                       | HTTP 403 or a bot-check document                     | left unanswered, no further request in the run                    | `PLATFORM_BLOCKED`        | existing sentence                                               |

Every German sentence involved already exists in `PLATFORM_STATUS_LABELS_DE` and
`error-mapping.ts`. No row is added, which is what 5.4 asks for — and the one substantive change to
the user's experience is that `EXCLUDED_BY_ROBOTS_TXT` stops appearing for Stepstone and `DISABLED`
replaces `PLATFORM_BLOCKED` for Jobvector.

The status change for Jobvector is the honest one. `PLATFORM_BLOCKED` says the Platform ended the
retrieval; once the Platform is deactivated it is the Job_Tool that ends it, and telling the user
"Jobvector hat den automatischen Abruf blockiert. Bitte später erneut versuchen." would ask them to
retry something no retry can change.

## Correctness Properties

### Property 1 — Every emitted Stepstone URL is permitted by the Platform's own robots.txt

For every effective Search_Profile the Stepstone capability can produce and every page number from 1
to `RESULT_PAGE_BUDGET`, `robots-parser` evaluated against the stored `www.stepstone.de` robots.txt
and the Job_Tool user agent answers `true` for `stepstoneResultListUrl(profile, pageNumber)`.

The oracle is the Platform's stored rules, not a restatement of the builder, which is what makes the
property worth more than the unit cases: a parameter added to the builder later fails this property
without anyone remembering to extend a list.

**Validates: Requirements 1.1, 1.2, 1.9**

### Property 2 — The emitted URL carries at most the one parameter `q`

For every profile and page number, the emitted URL's `searchParams` has either zero entries or
exactly one, whose key is `q`. Stated independently of Property 1 because it is the
Single_Parameter_Rule itself rather than one robots.txt's expression of it: a Stepstone rule change
that happened to permit two parameters would not make a second parameter something this builder
should emit without a new decision.

**Validates: Requirements 1.1, 1.2, 1.3, 1.4**

### Property 3 — Every declared Criterion_Field reaches the emitted URL

For every Platform in `PLATFORM_CAPABILITIES` and every effective Search_Profile, each
Criterion_Field in that Platform's `supportedFields` is observable in the URL its adapter emits —
in the path, in a query parameter value, or both. Run across all four adapters rather than Stepstone
alone, since rule 2 of the adapter conventions is repository-wide and this spec is the second time it
has been violated.

**Validates: Requirements 1.5, 1.11**

### Property 4 — At most one Result_Page is requested per Stepstone Scrape_Run

For every page budget handed to the adapter, including values above `RESULT_PAGE_BUDGET`, negative
values and non-finite values, the number of page requests the adapter issues is at most
`STEPSTONE_RESULT_PAGE_LIMIT`, and where the page read offers a further one the reported
Platform_Status is `PAGE_LIMIT_REACHED` with `partialResult` true.

**Validates: Requirements 1.7, 1.8, 5.3**

### Property 5 — Every outgoing request carries the honest user agent

For every Platform_Adapter and every request recorded by the `FixtureServer` — the robots.txt
retrieval and every page request alike — the `user-agent` header equals `buildUserAgent(contact)`
exactly, and contains none of the tokens `Mozilla`, `Chrome`, `Safari`, `Gecko`, `Googlebot` or
`bingbot`.

This is Requirement 2 made mechanical. The token list is the point: a future change that sets a
browser user agent for one Platform fails here by name rather than passing review as a header tweak.

**Validates: Requirements 2.1, 2.2, 2.4**

### Property 6 — No Access_Control_Evasion dependency is installed

The dependency closure of `packages/scrapers` contains none of `playwright-extra`,
`puppeteer-extra`, `puppeteer-extra-plugin-stealth`, `playwright-stealth`, `2captcha`,
`anti-captcha` or `capsolver`, and no source file under `packages/scrapers/src` patches
`navigator.webdriver`, `navigator.plugins`, or the canvas, WebGL or font fingerprint.

A property over the repository rather than over a function, in the manner of
`apps/api/src/__tests__/ai-provider-use.test.ts`, which already constrains where a credential may
appear. The same shape works here: the boundary of Requirement 2 is only real if something fails when
it is crossed.

**Validates: Requirements 2.2, 3.4**

### Property 7 — The negotiation headers are identical for every Platform

For every Platform_Adapter, the `accept-language` and `accept` headers recorded by the
`FixtureServer` are byte-identical across Platform, and no `sec-ch-ua`, `sec-ch-ua-mobile` or
`sec-ch-ua-platform` header is sent.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

### Property 8 — A deactivated Platform costs nothing and loses nothing

With `PLATFORM_ACTIVATION.JOBVECTOR` false, a Scrape_Run records zero requests to that Platform —
including the robots.txt retrieval — opens no browser page for it, reports it as `DISABLED`, and
leaves every stored Jobvector Job_Posting's `Posting_Status`, Relevance_Verdict and
Best_Commute_Time unchanged.

**Validates: Requirements 4.6, 4.7, 4.8**

## Testing Strategy

Four of the eight properties are plain unit tests over pure functions and need neither a browser nor
a network. Nothing in this spec requires a new test suite.

| Property | Where                                                                   | Runs in       |
| -------- | ----------------------------------------------------------------------- | ------------- |
| 1, 2     | `stepstone/__tests__/result-list-url.test.ts`, fast-check over profiles  | `pnpm test`   |
| 3        | `packages/scrapers/src/__tests__/capability-url-coverage.test.ts` (new)  | `pnpm test`   |
| 4        | `stepstone/__tests__/fixture-adapter.test.ts` against `FixtureServer`    | `pnpm test`   |
| 5, 7     | `packages/scrapers/src/runtime/__tests__/request-headers.test.ts` (new)  | `pnpm test`   |
| 6        | `packages/scrapers/src/__tests__/no-evasion.test.ts` (new)               | `pnpm test`   |
| 8        | `apps/api/src/scraper/__tests__/` plus the existing sweep integration     | `pnpm test` and `pnpm test:integration` |

The robots.txt of `www.stepstone.de` is stored as a fixture with its capture date rather than fetched
in a test, so Property 1 stays offline and a Stepstone rule change is a reviewable diff instead of a
test that starts failing for an invisible reason. The `@live` smoke test of each Platform is what
notices the stored copy going stale, which is the division of labour the repository already uses.

**Fixtures to capture, in order.** The Stepstone robots.txt and one real `result-list-page-1` through
the Permitted_Query_Shape; the Jobvector 403. The Stepstone capture is the one that answers the
behavioural unknown of 1.11, so it comes before the expectation files are written. Every existing
Stepstone fixture stays as it is — the parser is untouched by this spec, only the URL is — but
`result-list-page-2.html` becomes a fixture for a page the adapter no longer requests, and the
`__fixtures__/README.md` says so rather than the file being deleted: it still exercises the reader,
and it is what a future permitted pagination parameter would need.

**What the existing suite already protects.** Property 13 of the parent design (robots.txt fetched
once per Platform, before anything else, gating retrieval) is untouched and must stay green —
it is the proof that this spec fixed the input to the gate rather than the gate. Property 28 (exactly
one Platform_Status per Platform per run) covers the `DISABLED` path for Jobvector. Property 10
(adapter order confluence) covers `PAGE_LIMIT_REACHED` as a terminal status.

**The quality gate closes the work**, in the order of `local-development.md`: `pnpm format`,
`pnpm lint`, `pnpm check-types`, `pnpm build`, `pnpm test`. Then `pnpm test:integration`, because
Jobvector's deactivation touches the gated status sweep of Property 09, and `pnpm test:e2e`, because
the criteria view loses three Stepstone rows.

## Risk Assessment

| Risk                                                                                      | Likelihood | Impact | Mitigation                                                                                                 |
| ----------------------------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| Stepstone's terms of use forbid automated retrieval regardless of robots.txt               | medium     | high   | 6.3 keeps the review date honest rather than invented. robots.txt compliance is necessary, not sufficient, and this spec does not claim otherwise. The user's decision, recorded in `docs/adapters/stepstone.md` |
| `?q=` intersects with the path slug and narrows the result list                             | medium     | medium | The capture of task 3 measures it before the expectation files are written; 1.11 is the pre-agreed branch to the bare path |
| One Result_Page is too few to be useful from Stepstone                                     | medium     | medium | Measured after the first real run. If ~25 postings per run is too thin, the remaining lever is the Search_Profile — a second job title produces a second permitted path — not a second page |
| Losing the radius widens the list enough to strain the relevance budget                     | medium     | low    | `RELEVANCE_MAX_PER_RUN` already bounds it at 200 and the Log_Stream names the skipped count. Oldest-first ordering means skipped postings lead the next run |
| Stepstone changes its robots.txt and the stored copy goes stale                              | high       | low    | The live gate decides every real run regardless of the fixture; the stored copy only decides the test. The `@live` smoke test is what notices |
| Jobvector serves no Published_Machine_Interface and stays unavailable                       | high       | medium | Accepted. The Platform is deactivated, its stored postings are kept, and `pnpm test:live` detects a change of heart. Three of four Platform remain |
| A later contributor adds a browser user agent or a stealth plugin to "fix" Jobvector         | medium     | high   | Properties 5 and 6 fail by name. This is the main reason Requirement 2 is written as testable properties rather than left as a convention in a document |
| The deactivation of Jobvector hides its stored postings from the user                       | low        | medium | Property 8 asserts the stored rows are untouched; the gated sweep of 9.5 is already closed for a Platform whose status is not `COMPLETED` |

**The risk this spec explicitly refuses to take.** Overcoming Jobvector's access control would move
the user's exposure from a civil question about terms of use — which Requirement 1 keeps them in, and
which they have said they accept — to a question about circumventing a technical protection measure,
which in Germany is the territory of §202a StGB and is not the user's to waive on a contributor's
behalf. The distinction is not a formality: Stepstone's robots.txt is a *request* the Job_Tool now
honours precisely, while Jobvector's 403 is a *barrier*. This design honours the first and respects
the second.
