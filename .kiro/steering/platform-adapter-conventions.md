---
inclusion: fileMatch
fileMatchPattern: '{packages/scrapers/**,docs/adapters/**,apps/api/src/scraper/**,packages/domain/src/search-profile/capabilities.ts}'
---

# Platform_Adapter conventions

This document answers Requirement 16.3: the uniform adapter interface, the normalization of a
Job_Posting onto the eight fields of 6.3, the Criterion_Field supported per Platform, the minimum
waiting time of 2 seconds between two page requests, the upper limit of 10 Result_Page per Platform
and Scrape_Run, and the tests required per Platform_Adapter. It also answers Requirement 16.5 with
the numbered sequence for adding a further Platform_Adapter, where each step names the file to
create or change and the command to run.

Capitalised terms are the glossary terms of `.kiro/specs/job-search-tool/requirements.md` and are
used unchanged (16.10). Every number below is traceable to a named constant; the constant and its
file are stated where the number appears.

`inclusion: fileMatch` is deliberate. Everything here applies while adapter code, a Platform
fixture, the capability declaration or the retrieval wiring of the API_Service is being touched, and
to nothing else — a change to the Web_App or to the Commute_Service is never affected by it. The
pattern therefore covers `packages/scrapers/**`, `docs/adapters/**`, `apps/api/src/scraper/**` and
the capability declaration, which is exactly the set of files the numbered sequence below edits.
`project-context.md` and `local-development.md` are `always` for the opposite reason: they decide
the wording and the closing steps of every change.

## Platform_Adapter conventions

### The uniform adapter interface

Requirement 6.6 asks that a further Platform_Adapter take effect **solely by registering**, without
a change to the source of the Scraper_Service. The interface that makes that hold is
`PlatformAdapter` in `packages/scrapers/src/adapter/types.ts`:

| Member                              | Meaning                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `capability`                        | What this Platform can express in its result list query (4.2); the registry key check |
| `resultListUrl(profile, pageNumber)`| The Result_Page entry point, used for the robots.txt evaluation of 14.1 and documented per 14.7 |
| `fetch(context)`                    | Retrieves the publicly accessible result list and returns one `AdapterResult`          |

Everything an adapter needs arrives in one `AdapterContext`; everything it reports leaves in one
`AdapterResult`. There is no second channel: an adapter reads no clock, no configuration and no
environment of its own, which is what keeps a Scrape_Run reproducible from its inputs.

`AdapterContext` carries `runId`, `runStartedAt` (the reference point for a relative date, 6.4), the
already resolved effective `profile` (5.1), `openPage`, `pageBudget`, `pageTimeoutMs`, `log` and the
cancellation `signal` of 12.7 and 13.6.

Four responsibilities are deliberately **not** the adapter's:

- **Playwright.** An adapter sees `AdapterPage` — `load(url)`, `html()`, `close()` — and never a
  browser type. The Playwright runtime (`packages/scrapers/src/runtime/`) implements that port in
  production; the fixture page factory implements it over a frozen HTML file in the tests and in
  fixture mode. This is what makes a parser testable without a browser and without a network.
- **Pacing, repetition and the per-page time limit.** Every `page.load` goes through the
  `PlatformQueue` of that Platform. An adapter contains no sleep, no retry counter and no timeout.
- **Normalization.** An adapter returns `RawJobPosting`, whose seven fields are each nullable
  because the page is the source of truth for presence. The eight Job_Posting fields of 6.3 are
  produced once, in the shared normalization layer.
- **The German summary sentence per Platform_Status.** That is mapped once in the API_Service; see
  "German text" below.

#### Ending a retrieval: return, do not throw

Every end an adapter can observe is a result, not an exception. A sign-in wall (7.2), a bot check
(7.6), an unreadable layout (6.7), a reported fetch rate (13.5) and the page limit (13.3) all
**return** an `AdapterResult` carrying the Job_Posting read so far — that is what keeps the
Partial_Result of 7.7, because a thrown error would take the postings with it.

The error classes of `packages/scrapers/src/adapter/errors.ts` are still used, as the single place
that pairs an observation with its Platform_Status and its stable log code; they are constructed and
reported rather than thrown. `buildAdapterResult` derives `partialResult` from the Platform_Status,
so the 7.7 rule lives in one place: every end other than `COMPLETED` is a Partial_Result, including
the orderly `PAGE_LIMIT_REACHED` end of 13.3.

The one case that does throw is cancellation. An aborted Scrape_Run rejects, because only the
Scraper_Service knows whether the user cancelled (12.7) or the 30-minute limit struck (13.6), and
inventing a Platform_Status in the adapter would overwrite that knowledge.

A thrown error is still safe: `platformStatusForError(error)` is total over `unknown` and answers
the Platform_Status the error carries, or `FAILED` for every error that names none — the exhausted
attempt series of 13.8 and any unexpected fault alike. So the Scraper_Service can always close a
Platform with one of the 14 permitted values, whatever reaches its catch block (13.1). No call site
needs a chain of its own type checks; `isAdapterError` is the single recogniser.

#### Registration

`ADAPTERS` in `packages/scrapers/src/registry.ts` is the only place that changes when a
Platform_Adapter is added. It is a record keyed by Platform, so the "exactly one per Platform" rule
of 6.1 is a duplicate object key and therefore a compile error rather than two silently competing
adapters. The Scraper_Service receives the derived list through the `ADAPTER_REGISTRY` token
(`apps/api/src/scraper/scraper.module.ts`) and names no Platform itself.

Read the registry rather than listing Platform anywhere else. `registeredPlatforms()` and
`platformAdapters()` both iterate `PLATFORMS`, so the adapter order of a Scrape_Run is deterministic
and independent of the order the entries happen to be written in. `platformsWithoutAdapter()`
reports a Platform that has none yet as a value rather than as a build failure, because Glassdoor
and Indeed land later than Stepstone and Jobvector.

### Normalization onto the eight Job_Posting fields (6.3)

`normalizePosting` in `packages/scrapers/src/normalize/normalize-posting.ts` is pure and is the only
implementation of 6.3, 6.5, 6.8 and 6.9. It is never duplicated per adapter.

It returns one of exactly two outcomes and throws for no input:

- `DISCARDED` — one of the three fields of 6.5 is missing or whitespace only. Those three are
  `REQUIRED_POSTING_FIELDS = ['title', 'sourceUrl', 'postingId']`, checked in that order so a
  posting missing several of them always names the same field. Without them a Job_Posting can
  neither be shown, nor opened, nor upserted on `(platform, postingId)`.
- `ACCEPTED` — the Job_Posting plus any `NormalizationNote`. An absent optional field is `null`,
  which is the "marked as empty" of 6.8.

| Field             | Limit (`FIELD_LIMITS`) | Nullable | Rule        |
| ----------------- | ---------------------- | -------- | ----------- |
| `platform`        | —                      | no       | 6.3         |
| `postingId`       | none, never truncated   | no       | 6.3, 6.5    |
| `title`           | 200                    | no       | 6.3, 6.5    |
| `employer`        | 150                    | yes      | 6.3, 6.8    |
| `workLocation`    | 150                    | yes      | 6.3, 6.8    |
| `publishedAt`     | —                      | yes      | 6.4, 6.9    |
| `sourceUrl`       | none, never truncated   | no       | 6.3, 6.5    |
| `descriptionText` | 10,000                 | yes      | 6.3, 6.8    |

Source URL and Posting_Id carry no limit on purpose: a truncated URL still looks usable but no
longer resolves, and a truncated Posting_Id no longer matches the Platform's identifier. Limits are
counted in UTF-16 code units, which is what `String.prototype.length` counts and what the `varchar`
limits of the Posting_Store are declared in. Truncation always yields a prefix of the input, drops a
trailing unpaired high surrogate and trims whitespace exposed at the new end.

Every value is trimmed first, and a value that is empty after trimming is `null`. A Platform that
renders an empty employer cell as a non-breaking space has not supplied an employer.

**Publication dates.** `parsePublicationDate` in the same directory converts both shapes a Platform
states: an ISO 8601 value and German relative text such as "vor 3 Tagen", resolved against
`runStartedAt` (6.4). It is total — it returns a `Date` that is never after `runStartedAt`, or
`null`, and never throws. `null` is the 6.9 path: the publication date is marked as empty, the
`posting.publicationDateUnparsable` note is written to the Log_Stream and the Job_Posting is kept.
Two conventions it fixes: a relative statement carries over the time of day of `runStartedAt`
because the Platform stated a day and not a moment, and a value resolving into the future is
rejected with `null` rather than clamped, because clamping would invent a publication date.

**No date library.** The project uses the platform `Date` only. `date-fns` has no inverse of
`formatDistance`, so the German relative vocabulary would be hand-written either way, and the ISO
branch needs its own strictness (`Date.parse('2026-02-30')` silently answers 2 March). A new
adapter adds no date dependency; it adds date wordings to the vocabulary tables of
`parse-publication-date.ts` if its Platform invents one.

**Logging stays with the caller.** The events of 6.5 and 6.9 are *returned* — as the discard reason
and as note codes — and written to the Log_Stream by the component that knows the run identifier and
the page number. Nothing in the normalization layer reads a clock, a configuration or the
Log_Stream.

### The Criterion_Field supported per Platform (4.2)

`PLATFORM_CAPABILITIES` in `packages/domain/src/search-profile/capabilities.ts` is the single
declaration. `definePlatformCapability` keeps both tuples as literals, which is what makes a
Platform_Override for an unsupported Criterion_Field a compile error (4.5).

| Platform    | `supportedFields`                                                                                  | `mandatoryFields`           |
| ----------- | -------------------------------------------------------------------------------------------------- | --------------------------- |
| `GLASSDOOR` | `jobTitle`, `titleSynonyms`, `searchLocation`, `searchRadiusKm`                                     | `jobTitle`, `searchLocation`|
| `JOBVECTOR` | `jobTitle`, `titleSynonyms`, `industry`, `searchLocation`, `searchRadiusKm`                         | `jobTitle`                  |
| `INDEED`    | `jobTitle`, `titleSynonyms`, `searchLocation`, `employmentType`, `publicationPeriodDays`            | `jobTitle`, `searchLocation`|
| `STEPSTONE` | `jobTitle`, `titleSynonyms`, `searchLocation`, `searchRadiusKm`, `employmentType`, `publicationPeriodDays` | `jobTitle`, `searchLocation`|

`INDEED` is the one entry whose shape is decided by a robots.txt rather than by what the Platform's
search form offers. Indeed does have a radius selector, but the `User-agent: *` group of
`https://de.indeed.com/robots.txt` carries `Disallow: /*radius=`, so a URL stating a radius is one the
Job_Tool may not request (14.2) — and rule 2 below then forbids declaring the field. The sibling line
`Disallow: /*&start=` forbids Indeed's only pagination parameter, which is why that adapter reads
exactly one Result_Page (`INDEED_RESULT_PAGE_LIMIT`) and reports `PAGE_LIMIT_REACHED` as the ordinary
end of a successful retrieval. Both decisions are documented in
`packages/scrapers/src/adapters/indeed/result-list-url.ts` and pinned in that adapter's
`__tests__/result-list-url.test.ts` against the stored rules of its `__fixtures__/`.

Three rules follow:

1. **An unsupported Criterion_Field is omitted from the query, never defaulted.** Sending a
   substitute would retrieve a result list the Search_Profile never asked for.
2. **Every supported Criterion_Field must actually reach the URL.** A field that is declared but
   silently never applied would make the read-only criteria view of 4.11 claim a filter the
   retrieval never used. `resultListUrl` is typed over the adapter's own capability tuple, so the
   compiler shows which fields are readable there.
3. **A Platform value that does not exist is raised, not lowered.** Where a Platform offers discrete
   steps — Stepstone's `STEPSTONE_RADIUS_STEPS_KM` and `STEPSTONE_AGE_BUCKETS_DAYS` — a
   Search_Profile value between two steps takes the next larger one: a smaller radius or a shorter
   period would drop Job_Posting the user asked for, while a larger one only adds postings the
   Commute_Service then rates. A value above the largest step drops the parameter entirely, because
   "and older as well" is what no filter means.

`resultListUrl` must be deterministic in its inputs, including the order of the query parameters.
That is what lets the robots.txt evaluation of 14.1 run against `resultListUrl(profile, 1)` and lets
a fixture test compare URLs. It throws a `RangeError` for a page number that is not a positive
integer and for a Search_Profile missing a mandatory Criterion_Field of that Platform.

**Express the Result_Page number as the `page` query parameter, omitted for the first page.** This
is a convention across the Platform_Adapter rather than something the interface declares, and the
fixture-mode runtime depends on it: `requestedPageNumber` in
`apps/api/src/scraper/fixture-retrieval.runtime.ts` reads that parameter alone, so a new adapter
gets its fixture-mode routes from the registry without that file changing.
`apps/api/src/scraper/__tests__/fixture-retrieval.runtime.test.ts` asserts the convention against
every registered adapter's own `resultListUrl`, so an adapter that paginated through the path fails
that test by name instead of silently serving page 1 ten times.

### Pacing: at least 2 seconds between two page requests (13.2)

`MIN_REQUEST_GAP_MS = 2000` in `packages/scrapers/src/scheduling/platform-queue.ts`. One
`PlatformQueue` per Platform and Scrape_Run holds three rules together:

| Rule                                                            | Mechanism                                                     | Criterion |
| --------------------------------------------------------------- | ------------------------------------------------------------- | --------- |
| At most one page request per Platform at a time                  | a single in-flight slot (`Semaphore(1)`)                      | 13.9      |
| At least `max(MIN_REQUEST_GAP_MS, crawlDelaySeconds * 1000)` between requests | `minDelayMs`, fixed for the whole Scrape_Run    | 13.2, 14.4|
| At most `MAX_REQUEST_ATTEMPTS = 3` attempts per page request      | the bounded attempt series, with no repetition after a fatal failure | 13.4, 13.5 |

The gap is measured **from the settling of the previous attempt** — the arrival of its response or
the completion of its abort — never from the send time. The attempt is timed in a `finally` block
precisely so that a response and an abort are treated alike. `gapBeforeAttempt(attempt)` returns
`minDelayMs` before the first attempt and doubles it per repetition, which keeps the increasing
interval of 13.4 above the lower bound rather than beside it.

A stated `Crawl-delay` above 2 seconds replaces the minimum (14.4); a value at or below it leaves
the minimum in force. The other half of 13.9 — at most 4 Platform_Adapter at a time — is
`ADAPTER_CONCURRENCY = 4` in `apps/api/src/scraper/scraper.service.ts`, enforced by a second
`Semaphore` over the adapters rather than by anything inside one.

The queue closes permanently after a fatal failure, after the attempts are exhausted, and whenever
the caller closes it. That is how 13.5 holds: once a Platform reports an exceeded fetch rate, no
further request reaches it in that Scrape_Run, and a request handed to a closed queue rejects with
`PlatformQueueClosedError` without its task ever running.

**`clock` and `sleep` are injected, and must stay injected.** The pacing is specified behaviour, so
it has to be observable: the property test of the pacing drives virtual time and reads the exact
moment the gap is computed, and the E2E fixture mode hands the queue a clock that only advances when
the queue itself asks to wait. A hidden `Date.now()` or `setTimeout` would make both impossible, and
switching the pacing off in fixture mode would prove nothing about the retrieval the user runs.

Two further time limits belong here: `RESULT_PAGE_TIMEOUT_MS = 30_000` per Result_Page (6.2, 13.4)
in `packages/scrapers/src/adapter/types.ts`, and `ROBOTS_FETCH_TIMEOUT_MS = 10_000` for the
robots.txt retrieval (14.3) in `packages/scrapers/src/robots/robots.ts`.

### The page limit: 10 Result_Page per Platform and Scrape_Run (13.3)

`RESULT_PAGE_BUDGET = 10` in `packages/scrapers/src/adapter/types.ts`. It reaches an adapter as
`context.pageBudget`, which a test shrinks so the limit is observable without ten fixtures.

An adapter caps the handed budget at `RESULT_PAGE_BUDGET` and floors it at 0, so the upper bound of
13.3 holds even if a caller passes a larger value and a nonsensical budget reads no page rather than
looping. On reaching the limit while the Platform still offers a further Result_Page, the adapter
logs the page-limit line and reports Platform_Status `PAGE_LIMIT_REACHED`, which makes the result a
Partial_Result (7.7) because the result list was not read to its end. A result list that ends before
the limit reports `COMPLETED`.

An adapter may cap *lower* where the Platform leaves it no usable way to address a further
Result_Page. Two of the four do, and both caps are 1:

- `INDEED_RESULT_PAGE_LIMIT` in `packages/scrapers/src/adapters/indeed/result-list-url.ts`, because
  `Disallow: /*&start=` in the robots.txt of that Platform forbids its only pagination parameter, so
  the second Result_Page has no address the Job_Tool may request (14.2).
- `GLASSDOOR_RESULT_PAGE_LIMIT` in `packages/scrapers/src/adapters/glassdoor/result-list-url.ts`,
  because Glassdoor *ignores* the `page` parameter and paginates through a
  `<button data-test="load-more">` instead. The capture of 2026-10-29 proved it: the request with
  `&page=2` landed on the same canonical URL and 23 of its 30 job identifiers had already been
  served. Without the cap, up to nine of the ten page requests of a Glassdoor retrieval re-read the
  first block, each still paying the 2-second gap of 13.2.

For both, `PAGE_LIMIT_REACHED` is the ordinary end of a *successful* retrieval rather than the
exception, and it is where the Partial_Result of 7.7 is observable for that Platform. Such a cap is
a named constant with its reason beside it, never a number inside the loop, and `effectivePageBudget`
of the adapter applies it as `min(RESULT_PAGE_BUDGET, <platform limit>)` — a test may shrink the
budget below it, nothing can raise it.

The Glassdoor cap is a mitigation and not a fix: reading the "Mehr Jobs anzeigen" control is what
would actually retrieve the second block, and that needs a decision about the repository-wide `page`
convention below. `docs/adapters/glassdoor.md` records both sides.

### robots.txt and etiquette (14.1 – 14.5)

An adapter does not evaluate robots.txt itself; `RobotsCache` in
`packages/scrapers/src/robots/robots.ts` does, once per Platform, before the first page request, and
the result is reused for the rest of the Scrape_Run (14.1). The retrieved body is cached rather than
the decision, so a later call with further intended paths is answered from the same body. Parsing is
delegated to `robots-parser`, and the retrieval goes through `fetch` rather than Playwright, so a
blocked robots.txt costs no browser page.

`robotsPlatformStatus(decision)` maps the outcome: `ROBOTS_TXT_UNAVAILABLE` when the body could not
be retrieved within the budget or could not be evaluated (14.3), `EXCLUDED_BY_ROBOTS_TXT` when it
forbids at least one intended path (14.2), and `null` when the retrieval may proceed. A path
`robots-parser` cannot relate to the retrieved robots.txt turns the whole decision into
`UNAVAILABLE` rather than silently permitting the path. Cancellation of the Scrape_Run rejects
instead of being reported as a robots.txt fault.

The user agent is the unchanged Job_Tool identification of 14.5, built by `buildUserAgent` from the
contact detail in `USER_AGENT_CONTACT`. It never imitates a browser. No adapter fills a sign-in or
registration form, stores credentials, or answers a Captcha (7.1, 7.5, 7.6).

### German text belongs to one owner

An adapter writes the per-page progress lines of the Log_Stream, because only it knows the page
number and the number of Job_Posting on that page. They live in the adapter's own `messages.ts` as
`AdapterLogEvent` values, each carrying a stable English `code` that tests assert on and the German
`messageDe` the Log_View shows (12.3).

The **summary sentence per Platform_Status** (7.4) is not the adapter's. The 14 German
Platform_Status labels live in `PLATFORM_STATUS_LABELS_DE` in `apps/api/src/common/error-mapping.ts`
and the German Platform names in `PLATFORM_LABELS_DE` in
`apps/api/src/platform-config/platform-config.messages.ts`. The Web_App holds no copy of either; see
the ownership table in `project-context.md`. No German text lives in `errors.ts` or in the
normalization layer, for the same reason: a second wording of a closed value list drifts from the
first.

### Tests required per Platform_Adapter (16.3)

Each Platform_Adapter needs **at least one success case and at least one error case**, and both are
run against frozen input. The five files Stepstone and Jobvector each have, as the worked examples
to copy:

| File (under `src/adapters/<platform>/__tests__/`) | What it pins                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| `result-list-url.test.ts`                         | Each Criterion_Field reaching the query, the step rounding, determinism, the `RangeError` cases |
| `parse-result-list.test.ts`                       | The reader's rules against hand-written snippets                              |
| `fixture-parse.test.ts`                           | The whole reading of all eight stored Result_Page against their `.expected.json`, plus the normalization of 6.4, 6.5 and 6.8 on a real page |
| `fixture-adapter.test.ts`                         | The real adapter driven over HTTP against the `FixtureServer`                  |
| `live.smoke.test.ts`                              | One real Result_Page request, skipped unless opted into                        |

The minimum coverage, by criterion:

- **Success:** at least one Result_Page yielding readable Job_Posting, pagination to a second page
  and the `COMPLETED` end where no further page is offered (6.2, 6.3).
- **Error:** at least one of the ends that are not `COMPLETED`. Over the whole suite all of them are
  covered — `SIGN_IN_REQUIRED` (7.2), `PLATFORM_BLOCKED` (7.6), `PAGE_LAYOUT_UNKNOWN` (6.7),
  `FETCH_RATE_LIMITED` (13.5), `PAGE_LIMIT_REACHED` (13.3) and `FAILED` after the exhausted attempts
  of 13.8 — together with the Partial_Result rule: the postings of the earlier pages survive the end
  (7.7).
- **Pacing:** at least two seconds between two page requests (13.2) and never more than ten
  Result_Page whatever budget is handed in (13.3).

Use `FixtureServer` rather than reading the HTML file directly. An adapter talks to the
`AdapterPage` port, and a test is only worth its name if the adapter walks the road it walks in
production: a URL built from the effective Search_Profile, a response with a status and headers, a
relative pagination link resolved against a real origin, and a page request that can time out. A
`file://` path has no status, no headers and no timeout, so the 429-plus-`Retry-After` rate limit of
13.5, the sign-in redirect of 7.2 and the per-page limit of 6.2 would all be untestable. The server
binds `127.0.0.1` on an ephemeral port, records every request it received, and offers
`NEVER_RESPONDING_PATH` for the timeout path of 6.2 and 13.4. Close it in the teardown, or use
`withFixtureServer`.

**Fixture cases.** `REQUIRED_FIXTURE_CASES` in `packages/scrapers/src/fixtures/fixture-paths.ts`
lists the eight every Platform_Adapter is expected to have: `result-list-page-1`,
`result-list-page-2`, `result-list-empty`, `layout-changed`, `sign-in-wall`, `captcha`,
`rate-limited`, `relative-dates`. Each is `<case>.html` plus `<case>.expected.json` in
`src/adapters/<platform>/__fixtures__/`, and a captured document additionally carries a
`<case>.capture.json` sidecar with the capture date and provenance.

The expectation file is a data file and not inline test code on purpose: when a Platform changes its
markup, the fixture and its expectation are re-captured together and **the diff of the
`.expected.json` is the review of what changed**. It states `provenance` (`CAPTURED` or
`HAND_AUTHORED`), the response status and headers, the parser `outcome`, the `platformStatus`,
`hasNextPage`, `readablePostingCount` and every raw posting with all seven fields.

A `__fixtures__/README.md` states what the stored fixtures do and do not establish. Expect to
hand-author some of them: no Platform serves a Captcha, a reported fetch rate limit or a changed
layout on demand, and a Platform may refuse the capture outright — the capture attempt against
jobvector.de was answered with HTTP 403, so every Jobvector fixture is currently hand-authored and
`docs/adapters/jobvector.md` records that plainly. de.indeed.com answered the three attempts of
2026-10-29 with HTTP 403 and a Cloudflare security check, so seven of the eight Indeed fixtures are
hand-authored and the one `CAPTURED` document of that Platform is `captcha` — the inverse of the
Glassdoor folder, where the readable Result_Page is the capture and the blocking cases are written by
hand; `docs/adapters/indeed.md` records that, and that the Platform therefore contributes no
Job_Posting today. A hand-authored fixture is honest as long as its provenance says so.

A refusal is not the only outcome, so do attempt the capture: glassdoor.de answered the capture of
2026-10-29 with HTTP 200 and 30 readable Job_Posting, which is why `result-list-page-1` of that
Platform is the only `CAPTURED` fixture in the repository and why its seven siblings are not. That
one captured page is also what settled three provisional parameter guesses of
`src/adapters/glassdoor/result-list-url.ts` and corrected one wrong selector candidate order — which
is the argument for capturing early rather than writing more hand-authored markup.

`**/__fixtures__/` is listed in `.prettierignore`: a captured document must stay byte-identical to
what the Platform served, which is also why the capture metadata sits in a sidecar instead of in a
comment inside the document.

## Adding a further Platform_Adapter

The numbered sequence of Requirement 16.5. Run every command from the repository root. Steps 1 to 4
settle the Platform vocabulary, steps 5 to 11 build and register the adapter, steps 12 to 16 the
surroundings.

For Glassdoor and Indeed, the Platform is already declared everywhere steps 1 to 3 look, so those
three are confirmations rather than edits — run the commands and read the output. Step 2 is skipped
for them entirely.

1. **Confirm the Platform is declared in both enum copies.** `PLATFORMS` in
   `packages/domain/src/enums.ts` and `enum Platform` in `apps/api/prisma/schema.prisma` both
   already list `GLASSDOOR`, `JOBVECTOR`, `INDEED` and `STEPSTONE`, so nothing changes for those
   four; a genuinely new Platform is added to both.
   Command: `pnpm --filter @job-scraper/api test -- --run enum-parity`

2. **Only for a genuinely new Platform: create the migration for the changed database enum.** It is
   written into `apps/api/prisma/migrations/`; `apps/api/prisma/schema.prisma` is the single source
   of truth for the database, so the migration follows the schema edit and never the reverse. Skip
   this step for Glassdoor and Indeed, whose enum value already exists.
   Command: `pnpm --filter @job-scraper/api prisma:migrate`

3. **Confirm the Platform's German label and its activation.** `PLATFORM_LABELS_DE` in
   `apps/api/src/platform-config/platform-config.messages.ts` and `PLATFORM_ACTIVATION` in
   `packages/domain/src/search-profile/constants.ts` are both `Record<Platform, …>`, so a new
   Platform makes them a compile error until it is filled in. All four are present; three are
   activated and **`INDEED` is `false`**, because de.indeed.com answers the honest Job_Tool user
   agent with HTTP 403 and a Cloudflare check, so an activated Indeed would cost every Scrape_Run a
   request and a `PLATFORM_BLOCKED` warning for a result it does not get. The constant carries the
   reasoning and `docs/adapters/indeed.md` records the decision; recovery is detected by running
   `pnpm test:live`, not by paying for a 403 on every run.
   Command: `pnpm check-types`

4. **Declare the capability.** Add or confirm the Platform's entry in `PLATFORM_CAPABILITIES` in
   `packages/domain/src/search-profile/capabilities.ts`: `supportedFields` is what the Platform can
   express in its result list query, `mandatoryFields` the subset without which no URL can be built
   (4.2). Add a Platform_Override in `packages/domain/src/search-profile/constants.ts` only if the
   Platform needs different criteria than the Default_Search_Profile.
   Command: `pnpm --filter @job-scraper/domain test -- --run`

5. **Build the Result_Page URL.** Create
   `packages/scrapers/src/adapters/<platform>/result-list-url.ts`: the origin as an exported
   constant, one mapping table per Criterion_Field the capability declares, and the exported
   `<platform>ResultListUrl(profile, pageNumber)`. Express the Result_Page number as the `page`
   query parameter, omitted for page 1. Mark every parameter name you have not yet seen in a real
   response as provisional, in the file.
   Command: `pnpm --filter @job-scraper/scrapers check-types`

6. **Write the reader.** Create
   `packages/scrapers/src/adapters/<platform>/parse-result-list.ts`: pure, browser-free, HTML plus
   `AdapterPageResponse` in, a closed `ResultPageOutcome` and `RawJobPosting[]` out. Keep the
   selectors as ordered candidate lists — the first that matches anything wins — so a layout change
   is repaired by putting the new selector in front. Return raw values only, and report
   `readablePostingCount` separately from `postings.length`, because that count is the "readable
   Job_Posting" of 6.7. Use the shared helpers of `src/adapters/html/html-document.ts`.
   Command: `pnpm --filter @job-scraper/scrapers check-types`

7. **Write the German Log_Stream lines.** Create
   `packages/scrapers/src/adapters/<platform>/messages.ts`, modelled on the Stepstone file: the
   per-page progress line, the empty result list, the complete result list, the page limit, and one
   sentence per Platform_Status an ended retrieval of this Platform can report. Take each English
   `code` from the error class that already carries it.
   Command: `pnpm --filter @job-scraper/scrapers check-types`

8. **Write the adapter.** Create `packages/scrapers/src/adapters/<platform>/index.ts` exporting a
   class that implements `PlatformAdapterFor<'<PLATFORM>'>`: `capability`, `resultListUrl`, and a
   `fetch` that walks the pages up to `context.pageBudget`, hands each to the reader, takes over the
   postings **before** classifying the page, returns on every end other than `COMPLETED`, and closes
   the page in a `finally`. Return, do not throw; let cancellation through.
   Command: `pnpm --filter @job-scraper/scrapers check-types`

9. **Register the adapter.** Add one entry to `ADAPTERS` in `packages/scrapers/src/registry.ts`.
   This is the step that puts the Platform into a Scrape_Run; no other file names it.
   Command: `pnpm --filter @job-scraper/scrapers test -- --run registry`

10. **Capture the fixtures.** The capture writes into
    `packages/scrapers/src/adapters/<platform>/__fixtures__/`. It needs a built package,
    `USER_AGENT_CONTACT` in `.env` and the Playwright Chromium binary, performs exactly one real
    Result_Page retrieval per invocation, evaluates the Platform's robots.txt first, and refuses to
    run under a test runner or in CI. Review every written file in the diff before committing it.
    Hand-author the cases of `REQUIRED_FIXTURE_CASES` the Platform does not serve on demand, and
    record a capture refusal in the document of step 13 if the Platform answers with a 403 or
    similar.
    Commands, in order: `pnpm build`, then `pnpm fixtures:capture --platform <platform>`, then
    `pnpm fixtures:capture --platform <platform> --case result-list-page-2 --page 2`

11. **Write the expectation files and the tests.** One `<case>.expected.json` per fixture in
    `packages/scrapers/src/adapters/<platform>/__fixtures__/`, then the five test files of the
    table above in `packages/scrapers/src/adapters/<platform>/__tests__/`. At least one success
    case and at least one error case are mandatory (16.3); the error cases taken together must
    cover every Platform_Status this adapter can report, the Partial_Result rule of 7.7, the gap of
    13.2 and the limit of 13.3.
    Command: `pnpm --filter @job-scraper/scrapers test -- --run`

12. **Confirm the fixture-mode routes.** The fixture-mode retrieval runtime reads the registry, so
    the new Platform gets its routes without an edit — provided the Result_Page number is the `page`
    query parameter. The test that pins the convention is
    `apps/api/src/scraper/__tests__/fixture-retrieval.runtime.test.ts`; it needs no change, it needs
    to pass.
    Command: `pnpm --filter @job-scraper/api test -- --run fixture-retrieval`

13. **Write the adapter documentation.** Create `docs/adapters/<platform>.md`, which Requirement
    14.7 requires one of per Platform_Adapter: the source URL of the retrieved result list, the
    retrieval scope with the retrieved paths, the maximum number of pages per Scrape_Run, the
    respected waiting time, and the date of the last review of the terms of use in ISO 8601 format.
    Follow the section order of `docs/adapters/stepstone.md`. State a value the source marks as
    unconfirmed as unconfirmed.
    Command: `pnpm format`

14. **Bring the Steering_Docs to the new state in the same change set (16.11).** At minimum, add
    the Platform to the capability table of this file,
    `.kiro/steering/platform-adapter-conventions.md`. Touch `project-context.md` or
    `local-development.md` only if the start flow or the repository layout actually changed. `.kiro/`
    is in `.prettierignore`, so step 15 will not reformat these files; the command below is the
    check that the change set contains the edit 16.11 asks for.
    Command: `git diff --stat .kiro/steering`

15. **Run the quality gate.** Format, lint, type-check, build, test — in that order, all five, from
    the repository root. `local-development.md` holds the table and the two gotchas.
    Commands, in order: `pnpm format`, `pnpm lint`, `pnpm check-types`, `pnpm build`, `pnpm test`

16. **Optional, needs a network:** run the opt-in `@live` smoke test of the new adapter once, to
    confirm the Platform still serves the markup the fixtures were written against. It is skipped by
    default and is opted into with `SCRAPER_LIVE_SMOKE`, alongside `USER_AGENT_CONTACT`; both are
    declared for the `test:live` task in `turbo.json`, together with the four variables the
    API_Service's own two live smokes read. `pnpm test:live` reaches all six since task 25.2 —
    `apps/api` has a `test:live` script of its own now, so the AI_Provider and the Routing_Provider
    smoke tests are no longer hand-run only. This repository forbids a `VAR=value` command prefix,
    so put the `export` lines and the call into a script file and run that file.
    Command: `pnpm test:live`

### What the sequence deliberately does not include

- **No change to the Scraper_Service.** That is the whole point of 6.6. If adding an adapter forces
  an edit in `apps/api/src/scraper/scraper.service.ts`, the interface is being worked around.
- **No new German text in the Web_App.** The Platform_Status labels and the Platform names are the
  API_Service's, and they already cover every Platform.
- **No second normalization.** Field limits, the discard rule of 6.5, the empty-field rule of 6.8
  and the date parsing are shared. A Platform with a date wording nobody has seen adds that wording
  to the vocabulary table of `parse-publication-date.ts`.
- **No new fixture mechanism.** Fixture mode, the parser tests and the E2E suite all read the same
  stored documents through the same `AdapterPage` port.

## Related Steering_Docs

- Project context, the operating model, the language convention and who owns which German sentence:
  `project-context.md`.
- The Start_Script, the quality gate in full and the suites `pnpm test` does not run:
  `local-development.md`.
- The Relevance_Service and the Search_Profile constants, including how a change to the
  Default_Search_Profile or a Platform_Override takes effect.
- `packages/scrapers/README.md` for the scheduling, robots.txt and Playwright runtime internals, and
  `docs/adapters/stepstone.md`, `docs/adapters/jobvector.md`, `docs/adapters/glassdoor.md` and
  `docs/adapters/indeed.md` as the four worked per-Platform documents. Read the Glassdoor one for a
  Platform that served a Result_Page and the Indeed one for a Platform whose retrieval scope is
  decided by a robots.txt.
