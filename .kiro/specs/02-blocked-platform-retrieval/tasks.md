# Tasks — Blocked Platform retrieval

> **Status: superseded in part, and the scope grew.** Tasks 1, 4, 5, 6 and 7 are done. Two things
> changed after this plan was written, both because the goal moved from "Stepstone contributes
> something" to "every Platform's result list is read to its end":
>
> - **Requirements 13.3 and 13.10 – 13.14 are new** in `../01-job-search-tool/requirements.md`. The
>   old hard cap of 10 Result_Page became the Page_Safety_Limit of 100, a safety net rather than the
>   intended depth, and 13.13 is what lets "read to the end" and "respect robots.txt" both hold.
> - **Glassdoor now paginates through its `load-more` control** (13.12), which this plan recorded
>   only as an observation. `GLASSDOOR_RESULT_PAGE_LIMIT` is gone; `AdapterPage.loadMore` and
>   `GLASSDOOR_LOAD_MORE_SELECTOR` replaced it, and that Platform reports `COMPLETED` over a full
>   walk instead of `PAGE_LIMIT_REACHED` after one page.
>
> Still open: tasks 2, 3, 8 and 9 — the Jobvector capture and deactivation, the Stepstone Result_Page
> capture that decides 1.11, the no-evasion guard property, and the terms-of-use review. The design
> document beside this one describes the plan as written, not the state as built; read
> `docs/adapters/stepstone.md`, `docs/adapters/glassdoor.md` and
> `.kiro/steering/platform-adapter-conventions.md` for what the code actually does.

## Overview

Nine tasks in four waves. Wave 1 establishes the facts the rest depends on — the stored robots.txt and
the captured Jobvector refusal — because task 3 answers the one behavioural unknown (does `?q=`
narrow the Stepstone result list?) and 1.11 branches on it. Wave 2 is the Stepstone change itself,
compiler-driven: the capability edit of task 4 makes the override removal of task 5 a type error
rather than something to remember. Wave 3 is the two repository-wide guard properties, which are the
only parts of this spec that constrain code nobody has written yet. Wave 4 is documentation and the
quality gate.

Task 3 is the one that can change the plan. If the capture shows `q` narrowing the list, task 6 emits
the bare path for every profile and `titleSynonyms` leaves the Stepstone declaration in task 4 as
well. Do not write the expectation files before reading that capture.

Jobvector gets no retrieval work. Tasks 2 and 9 characterise the refusal and deactivate the Platform;
there is no task that defeats the block, and tasks 7 and 8 are what keep one from being added later.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "wave": 1,
      "rationale": "Establish the measured facts. Task 3 answers the q-narrowing unknown that 1.11 branches on, so nothing in wave 2 may be written before it.",
      "tasks": ["1", "2", "3"]
    },
    {
      "wave": 2,
      "rationale": "The Stepstone change, in compiler order: the capability edit turns the stale override into a type error, and the URL builder is what the page limit and the adapter cap follow from.",
      "tasks": ["4", "5", "6"]
    },
    {
      "wave": 3,
      "rationale": "The repository-wide guards. Independent of each other and of the Stepstone work, but they must land in the same change set, because they are what make Requirement 2 more than a convention.",
      "tasks": ["7", "8"]
    },
    {
      "wave": 4,
      "rationale": "Documentation of what the earlier waves measured and decided, then the full quality gate including the two suites pnpm test does not run.",
      "tasks": ["9"]
    }
  ]
}
```

## Tasks

- [ ] 1. Store the Stepstone robots.txt as a reviewable fixture
  - Retrieve `https://www.stepstone.de/robots.txt` with the honest user agent and store the body
    byte-identically at `packages/scrapers/src/adapters/stepstone/__fixtures__/robots.txt`
  - Write the `robots.txt.capture.json` sidecar with the capture date, the requested URL, the HTTP
    status and `provenance: 'CAPTURED'`
  - Record in `__fixtures__/README.md` that this copy decides the URL test only, never a real
    Scrape_Run, which the live gate decides
  - Confirm the body states no `Crawl-delay` for this user agent, so the 2-second floor of 13.2
    remains the gap in force
  - _Requirements: 1.9, 6.4_

- [ ] 2. Capture Jobvector's refusal once
  - Request `https://www.jobvector.de/robots.txt` and the result list entry point with the honest
    user agent, recording the HTTP status, the response headers and the body
  - Store both as `jobvector/__fixtures__/blocked-403.*` with `provenance: 'CAPTURED'` and the date
  - Read the captured body and headers for a named mechanism — a Cloudflare ray ID, a WAF product
    name, a `Retry-After`, a geo message — and note which, if any, is present
  - Send no second request after the refusal, per 7.8
  - _Requirements: 4.1, 4.2_

- [ ] 3. Capture one real Stepstone Result_Page through the Permitted_Query_Shape
  - Capture `/jobs/<title-slug>/in-<location-slug>` bare, and the same path with
    `?q=<the OR expression>`, one request each, 2 seconds apart
  - Compare the two: the number of readable Job_Posting, and whether the `q` variant is a subset of
    the bare variant
  - **Decide 1.11 from that comparison and record the decision**: `q` when synonyms exist, or the
    bare path for every profile
  - Store the chosen variant as `result-list-page-1.html` with its capture sidecar, keeping the
    existing hand-authored fixtures untouched
  - _Requirements: 1.3, 1.4, 1.11_

- [ ] 4. Reduce the Stepstone capability declaration
  - Remove `searchRadiusKm`, `employmentType` and `publicationPeriodDays` from
    `PLATFORM_CAPABILITIES.STEPSTONE.supportedFields` in
    `packages/domain/src/search-profile/capabilities.ts`
  - Remove `titleSynonyms` as well if and only if task 3 decided the bare path
  - Leave `mandatoryFields` as `['jobTitle', 'searchLocation']`: both still reach the URL through the
    path
  - Write the reason above the entry in the manner of the existing `INDEED` comment, naming the
    deciding robots.txt lines `Disallow: /jobs/*?*` and `Disallow: /jobs/*?q*&*`
  - _Requirements: 1.5, 6.1_

- [ ] 5. Remove the now-unsupported Stepstone Platform_Override
  - Delete `STEPSTONE: { searchRadiusKm: 30 }` from `PLATFORM_OVERRIDES` in
    `packages/domain/src/search-profile/constants.ts`, which task 4 has just made a type error
  - Confirm `pnpm check-types` passes and that the `JOBVECTOR` override is left alone for now
  - Update the domain tests that assert the override map's contents
  - _Requirements: 1.6_

- [ ] 6. Build the Permitted_Query_Shape and cap the page budget
  - In `packages/scrapers/src/adapters/stepstone/result-list-url.ts`: reduce `QUERY_PARAMS` to
    `keywords: 'q'`, emit the bare path when no synonyms exist, and emit `q` as the only parameter
    otherwise — per task 3's decision
  - Delete `STEPSTONE_RADIUS_STEPS_KM`, `STEPSTONE_AGE_BUCKETS_DAYS`, `STEPSTONE_CONTRACT_TYPES` and
    `raiseToStep`, and the unit tests that cover them
  - Add `STEPSTONE_RESULT_PAGE_LIMIT = 1` with the reason beside it, replacing the file's
    "provisional until the fixture capture" section with the measured decision
  - Add `effectivePageBudget` to `stepstone/index.ts` as `Math.min(RESULT_PAGE_BUDGET,
    STEPSTONE_RESULT_PAGE_LIMIT)`, copied from the Indeed adapter
  - Reword the page-limit line in `stepstone/messages.ts` to name the pages actually read, and note
    that this is now the ordinary end of a successful retrieval
  - Write Properties 1, 2 and 4 as tests: fast-check over profiles against the stored robots.txt via
    `robots-parser`, the at-most-one-parameter assertion, and the page-request count against the
    `FixtureServer`
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.7, 1.8, 1.9, 5.1, 5.2, 5.3, 6.1_

- [ ] 7. State the negotiation headers once and pin them
  - Add `accept-language: de-DE,de;q=0.9` and `accept: text/html,application/xhtml+xml` to the
    `BrowserContext` construction in `packages/scrapers/src/runtime/browser.ts`, beside the user
    agent, with the comment stating why these are negotiation and not disguise
  - Keep them non-configurable per Platform_Adapter
  - Write Properties 5 and 7 as `runtime/__tests__/request-headers.test.ts`: the user agent equals
    `buildUserAgent` exactly and contains none of `Mozilla`, `Chrome`, `Safari`, `Gecko`,
    `Googlebot`, `bingbot`; the two negotiation headers are byte-identical across every adapter; no
    `sec-ch-ua*` header is sent
  - _Requirements: 2.1, 2.4, 3.1, 3.2, 3.3, 3.4_

- [ ] 8. Make the no-evasion boundary fail when crossed
  - Write `packages/scrapers/src/__tests__/no-evasion.test.ts` as Property 6, in the shape of
    `apps/api/src/__tests__/ai-provider-use.test.ts`: assert the dependency closure of
    `packages/scrapers` contains none of `playwright-extra`, `puppeteer-extra`,
    `puppeteer-extra-plugin-stealth`, `playwright-stealth`, `2captcha`, `anti-captcha`, `capsolver`
  - Assert no source file under `packages/scrapers/src` assigns `navigator.webdriver`,
    `navigator.plugins`, or patches the canvas, WebGL or font fingerprint
  - Write Property 3 as `packages/scrapers/src/__tests__/capability-url-coverage.test.ts`: for all
    four adapters, every declared Criterion_Field is observable in the emitted URL
  - Name Requirement 2 and the Access_Control_Evasion glossary entry in the file header, so a
    contributor who hits the failure finds the reasoning rather than a list
  - _Requirements: 2.2, 2.5, 1.5, 1.11_

- [ ] 9. Deactivate Jobvector, document both Platform, run the full gate
  - Set `PLATFORM_ACTIVATION.JOBVECTOR` to `false` in
    `packages/domain/src/search-profile/constants.ts` with the reasoning beside it in the manner of
    the `INDEED` entry, citing the capture date from task 2 — unless task 2 found a
    Published_Machine_Interface, in which case record that instead and leave the Platform activated
  - Keep the Jobvector `@live` smoke test in place, skipped by default
  - Write Property 8 as a test: a deactivated Platform costs zero requests including the robots.txt
    retrieval, reports `DISABLED`, and leaves stored Job_Posting untouched
  - Rewrite the robots.txt and retrieval-scope sections of `docs/adapters/stepstone.md` with the
    measured decision, the one-page limit and the three dropped Criterion_Field; replace "has not
    been read in this repository yet"
  - Fill in or explicitly leave open the terms-of-use review date in both adapter documents — never
    invent one
  - Record in `docs/adapters/jobvector.md` the captured status, the date, the host and path, and the
    outcome per candidate Published_Machine_Interface
  - Update the capability table of `.kiro/steering/platform-adapter-conventions.md` to the new
    Stepstone row, per 16.11
  - Run the gate in order: `pnpm format`, `pnpm lint`, `pnpm check-types`, `pnpm build`, `pnpm test`,
    then `pnpm test:integration` and `pnpm test:e2e`
  - _Requirements: 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 5.4, 6.2, 6.3, 6.4_

## Notes

**The finding this spec rests on.** Stepstone's robots.txt permits its result list and permits one
query parameter on it. Verified on 2026-10-29 against the live body (HTTP 200, 3250 bytes, header
`last updated 06 08 26 JM`, no `Crawl-delay`) using the same `robots-parser` the Job_Tool uses. The
Job_Tool was sending four parameters. Nothing about the robots gate needs to change, and
Property 13 of the parent design must stay green throughout — it is the proof that the input to the
gate was fixed rather than the gate.

**What was considered and rejected for Stepstone.** Putting `q` last, renaming the filter parameters,
or encoding them into the path to produce a URL the rules do not literally name. All three request
exactly what `Disallow: /jobs/*?q*&*` exists to prevent, and the repository has already written down
why that is circumvention rather than compliance — see the `Disallow: /*&start=` discussion in
`packages/scrapers/src/adapters/indeed/result-list-url.ts`. 2.5 is that reasoning as an acceptance
criterion.

**What was considered and rejected for Jobvector.** A browser user agent, a Googlebot user agent,
`playwright-extra` with the stealth plugin, and a Captcha-solving service. Each defeats a technical
access control rather than honouring a convention, each contradicts 14.5 or 7.6 of the parent
requirements, and together they would move the user's exposure from terms of use to circumventing a
protection measure. Tasks 7 and 8 exist so that adding one later fails a named test instead of
passing review as a header change.

**Order that matters.** Task 3 before tasks 4 and 6, because 1.11 branches on what it measures. Task
4 before task 5, because the compiler is what finds the stale override. Tasks 7 and 8 are
independent of everything else and can be done first if the Stepstone capture has to wait for a
quiet moment on the Platform.

**What this spec does not touch.** `RobotsCache`, the robots gate in `ScraperService`, the
normalization layer, the `PlatformQueue`, the Prisma schema, the GraphQL schema, `REQUIRED_ENV_KEYS`,
and every German string in the Web_App. No migration, no `pnpm codegen`, no new configuration key.

**Expected result after task 9.** Stepstone contributes roughly one Result_Page of Job_Posting per
Scrape_Run, unfiltered by radius, contract type and posting age, with the Commute_Service and the
Relevance_Service doing the narrowing the query no longer does. Jobvector contributes nothing and
costs nothing. Glassdoor is unchanged. Indeed stays deactivated. Two of four Platform retrieving, up
from one.
