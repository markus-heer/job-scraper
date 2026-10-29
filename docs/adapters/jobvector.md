# Jobvector Platform_Adapter

The etiquette and operating document of the Jobvector Platform_Adapter, required by acceptance criterion 14.7: one
documentation file per Platform_Adapter naming the source URL of the retrieved result list, the retrieval scope with the
retrieved paths, the maximum number of pages per Scrape_Run, the respected waiting time and the date of the last review
of the terms of use in ISO 8601 format.

This file is written from the adapter source. Every number and every path below is traceable to a named constant; the
section [Source files](#source-files) lists where each one lives. Where the source itself marks a value as unconfirmed,
this document says so rather than presenting it as settled — see [Provisional parameters](#provisional-parameters).

Jobvector differs from Stepstone in three ways that the sections below keep returning to, all of them consequences of
the capability declaration and of what the Platform serves: `industry` is a supported Criterion_Field here, `jobTitle`
is the only mandatory one, and the Platform serves an English surface under `/en/` beside the German result list.

## At a glance

| Item                                   | Value                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| Platform                               | `JOBVECTOR`                                                                                   |
| Origin                                 | `https://www.jobvector.de`                                                                    |
| Result list path shape                 | `/jobs/` with every criterion in the query string                                             |
| Maximum pages per Scrape_Run           | 10 (`RESULT_PAGE_BUDGET`)                                                                     |
| Minimum gap between requests           | 2 s (`MIN_REQUEST_GAP_MS`), or a longer stated `Crawl-delay`                                  |
| Attempts per Result_Page               | at most 3 (`MAX_REQUEST_ATTEMPTS`)                                                            |
| Time limit per Result_Page             | 30 s (`RESULT_PAGE_TIMEOUT_MS`)                                                               |
| Sign-in                                | never; no credentials are supplied and no storage state is reused                             |
| Last terms-of-use review               | not yet performed — see [Terms-of-use review](#terms-of-use-review)                           |
| Last capture against the live Platform | none; one attempt was answered with HTTP 403 — see [Fixtures](#fixtures-and-the-refresh-loop) |

## Source URL of the retrieved result list

The result list URL is built from the effective Search_Profile of Jobvector, never hand-written. With the
Default_Search_Profile and the Jobvector Platform_Override currently in the source code (`jobTitle` "Projektmanagerin",
six title synonyms, `industry` "Pharma and Life Science", `searchLocation` "München" and `searchRadiusKm` 50 from the
override), the first Result_Page is:

```text
https://www.jobvector.de/jobs/?keyword=%22Projektmanagerin%22+OR+%22Projektmanager%22+OR+%22Project+Manager%22+OR+%22Projektleiterin%22+OR+%22Projektleiter%22+OR+%22Project+Lead%22+OR+%22Teilprojektleiterin%22&industry=Pharma+and+Life+Science&location=M%C3%BCnchen&radius=50
```

Every following Result_Page is the same URL with `&page=<n>` appended:

```text
https://www.jobvector.de/jobs/?keyword=...&industry=Pharma+and+Life+Science&location=M%C3%BCnchen&radius=50&page=2
```

`page` is omitted for the first Result_Page on purpose: that URL is the result list entry point — the address a person
opens, the one the robots.txt decision is made for, and the one documented here.

**Everything travels in the query string; nothing is put into the path.** That is the structural difference to the
Stepstone URL builder, and the reason is the capability declaration: `jobTitle` is Jobvector's only mandatory
Criterion_Field, so a path segment built from `searchLocation` would either break or need a placeholder whenever the
Search_Profile omits the place. A profile with nothing but a job title yields a usable nationwide result list
(`/jobs/?keyword=%22Projektmanagerin%22`) rather than a malformed URL.

The URL is a deterministic function of the profile and the page number, including the order of the query parameters
(`keyword`, `industry`, `location`, `radius`, `page`). That is what lets the robots.txt evaluation run against
`resultListUrl(profile, 1)` and lets a fixture test compare URLs literally.

### How a Criterion_Field reaches the URL

Jobvector's capability declaration supports five Criterion_Field, and all five are mapped — a supported field that
silently never reached the query would make the read-only criteria view claim a filter the retrieval never applied.

| Criterion_Field        | Where it goes | Mapping                                                                                                                                      |
| ---------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobTitle` (mandatory) | `keyword`     | first term of the keyword expression, quoted                                                                                                 |
| `titleSynonyms`        | `keyword`     | job title first, then the synonyms, each quoted and joined with `OR`; duplicates dropped case-insensitively, blank terms dropped             |
| `industry`             | `industry`    | the value with inner whitespace collapsed; omitted when absent or blank                                                                      |
| `searchLocation`       | `location`    | the value with inner whitespace collapsed; omitted when absent or blank                                                                      |
| `searchRadiusKm`       | `radius`      | raised to the next larger step of `5, 10, 25, 50, 100, 200`; a radius above 200 km omits the parameter entirely; sent only with a `location` |

Two fields Stepstone maps are **not** mapped here, because Jobvector does not declare them as supported and the
Profile_Resolver therefore never offers them: `employmentType` and `publicationPeriodDays`. One field Stepstone has no
equivalent for **is** mapped here: `industry`.

The radius rounding goes upward, never downward. A smaller radius would drop Job_Posting the user asked for; a larger
one only adds postings the Commute_Service and the Relevance_Service then rate. A radius above the largest step omits
the parameter rather than capping it, because searching the whole country is the closer reading of "larger than the
selector offers" than quietly shrinking the area. A radius never travels without a `location`: on its own it would be a
filter the criteria view claims but the Platform cannot apply.

Building the URL fails with a `RangeError` for a page number that is not a positive integer and for a Search_Profile
whose `jobTitle` is absent or blank.

## Retrieval scope

### Retrieved paths

Exactly one path family, on one origin:

| What               | Path                                  | When                                                |
| ------------------ | ------------------------------------- | --------------------------------------------------- |
| robots.txt         | `https://www.jobvector.de/robots.txt` | once per Platform and Scrape_Run, before page 1     |
| Result_Page 1      | `/jobs/?keyword=…` (filters as above) | always, if robots.txt permits it                    |
| Result_Page 2 … 10 | the same path with `&page=<n>`        | only while the previous page offered a further page |

The `www` host is the one the robots.txt is read from and the one every page request goes to. The adapter never builds
an `/en/` URL itself; the English surface matters only because Jobvector may redirect a request onto it, which is why
the parser's phrase lists carry both languages.

### What is never retrieved

- **No job advertisement detail pages.** The adapter reads result list pages only. The eight fields of the Job_Posting
  are taken from the result cards; a posting's own page is linked, not fetched.
- **No content behind a sign-in.** The browser context is opened with `storageState: undefined` and no credentials exist
  anywhere in the Job_Tool, so the retrieval structurally cannot sign in. A sign-in redirect or a covering sign-in
  overlay ends this Platform's retrieval.
- **No Captcha or bot check is answered.** A challenge page ends the retrieval.
- **No images, fonts, media or stylesheets.** The request interception drops those four resource types
  (`BLOCKED_RESOURCE_TYPES`), so Jobvector serves the document and the scripts only.
- **No service worker**, so a cached response cannot hide what the Platform actually served — including a sign-in wall
  or a bot check the adapter has to detect.
- **No parallel requests to Jobvector.** One page request per Platform at a time.

## Maximum pages per Scrape_Run

**10 Result_Page per Scrape_Run.** The adapter reads `context.pageBudget`, truncates it to an integer and clamps it into
`[0, RESULT_PAGE_BUDGET]`, so the upper bound of 10 holds even if a caller passes a larger budget. The tests shrink the
budget to make the limit observable without ten fixtures; production passes `RESULT_PAGE_BUDGET`.

Pagination stops on the first of these:

1. the page offered no further Result_Page → Platform_Status `COMPLETED`;
2. the page stated an empty result list → Platform_Status `COMPLETED`;
3. the budget is spent while Jobvector still offers a further page → Platform_Status `PAGE_LIMIT_REACHED`, which marks
   the result a Partial_Result, because this Platform's result list was not read to its end;
4. the page ended the retrieval (sign-in, bot check, rate limit, unreadable layout, unreachable Platform) → the matching
   Platform_Status, with the postings read so far kept.

## Respected waiting time

**At least 2 seconds between two page requests to Jobvector**, measured between the starts of two requests and enforced
by the `PlatformQueue` the adapter's page runs through, not by the adapter itself: it contains no sleep, no retry
counter and no timeout.

| Bound                                 | Value                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| Minimum gap between two page requests | 2000 ms                                                                            |
| Stated `Crawl-delay` in robots.txt    | respected when longer: `max(2000 ms, crawlDelaySeconds × 1000)`                    |
| In-flight page requests per Platform  | exactly 1                                                                          |
| Attempts per Result_Page              | at most 3 — the original request plus two repetitions, with an increasing interval |
| Time limit per Result_Page            | 30 000 ms; exceeding it counts as one failed attempt                               |
| robots.txt retrieval budget           | 10 000 ms; exceeding it means the Platform is skipped                              |

A robots.txt that states a shorter crawl delay than 2 seconds, or none at all, does not shorten the gap. 2 seconds is
the floor.

## Identification

Every request to Jobvector — the robots.txt retrieval and every page request alike — carries the same unchanged user
agent, built once from the `USER_AGENT_CONTACT` value of the local environment file:

```text
JobTool/0.1 (private use; contact: <USER_AGENT_CONTACT>)
```

It names the tool, states the private purpose of use and carries a reachable contact detail, and it contains none of the
tokens that would make it readable as a common browser. Without a usable contact detail the Job_Tool sends no request at
all; the API_Service reports that at startup.

## robots.txt

`https://www.jobvector.de/robots.txt` is retrieved once per Platform and Scrape_Run, before the first page request, and
the decision is reused for the rest of that run. It gates the retrieval:

- a disallowed intended path → Platform_Status `EXCLUDED_BY_ROBOTS_TXT`; no page request is sent, no Job_Posting of
  Jobvector is stored, and the remaining Platform_Adapter keep running;
- not retrievable within 10 seconds, or unevaluable → Platform_Status `ROBOTS_TXT_UNAVAILABLE`, and Jobvector is skipped
  for that run;
- a stated `Crawl-delay` longer than 2 seconds is applied as the gap between page requests.

The decision is re-evaluated on every Scrape_Run, so a change on Jobvector's side takes effect by itself. No bypass
exists. The fixture capture script runs the same gate before its single request, because a capture is a request like any
other.

**The robots.txt of jobvector.de has not been read in this repository yet.** Whether the `/jobs/` result list is allowed
and whether a `Crawl-delay` is stated are therefore open questions that the first capture or the first real Scrape_Run
answers; the gate decides it at runtime either way.

## Terms-of-use review

**Date of the last review of the terms of use: not yet performed.**

Acceptance criterion 14.7 asks for this date in ISO 8601 format, and writing one here would be a fiction: nobody has
read Jobvector's terms of use for this project yet, and no automated step can substitute for that. The field is kept in
the required shape and left explicitly open instead.

| Field                    | Value             |
| ------------------------ | ----------------- |
| Last terms-of-use review | — (not performed) |
| Reviewed by              | —                 |
| Reviewed document        | —                 |

What has to happen before the Job_Tool performs its first real retrieval of Jobvector:

1. read the terms of use currently published by Jobvector and decide whether the retrieval described in
   [Retrieval scope](#retrieval-scope) is defensible for private single-user use;
2. record the date of that reading in this table as `YYYY-MM-DD`, together with who read it and which document version;
3. re-do it whenever the adapter's retrieval scope changes, and on every fixture re-capture.

The single observed response from jobvector.de so far was an HTTP 403 (see [Fixtures](#fixtures-and-the-refresh-loop)).
That is a technical observation, not a statement of terms, and it does not replace step 1 — but it is the kind of signal
the review should weigh.

This document is not legal advice. The technical constraints — robots.txt, 2 seconds, 10 pages, no sign-in, no Captcha —
reduce the risk; they do not replace the review.

## Provisional parameters

The URL mapping is only partly confirmed, and the source code marks the split explicitly:

| Part                                                   | Status                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `/jobs/` path                                          | stable, the result list a person opens                                                        |
| `keyword`, `industry`, `location`, `radius`, `page`    | **provisional**, read from Jobvector's own search UI, awaiting confirmation by a real capture |
| radius steps `5, 10, 25, 50, 100, 200`                 | **provisional**                                                                               |
| the `OR` keyword expression of `jobvectorKeywordQuery` | **provisional, and the one mapping that does not degrade gracefully**                         |

A wrong filter parameter degrades gracefully: Jobvector ignores a query parameter it does not know, so the retrieval
still reads a result list, only a wider one than the Search_Profile asked for.

The keyword expression is the exception the source comment flags. A search engine that reads `OR` as a further literal
keyword instead of as an operator conjoins the terms and answers an almost empty result list — a _narrower_ result than
asked for, which a capture would show as an unexpectedly empty page rather than as a wider one. Confirming it, or
replacing it with the job title alone, is therefore the first thing the capture has to settle.

When a capture confirms or corrects these names, update `result-list-url.ts`, the [At a glance](#at-a-glance) and
[Source URL](#source-url-of-the-retrieved-result-list) sections here, and the review date.

## Page classification

One Result_Page is read by a pure, browser-free function: HTML plus the response that carried it in, one outcome plus
the raw postings of that page out. It never throws — every failure it can observe already has a Platform_Status, and an
exception would lose the Partial_Result.

The classification order matters, because the characteristics overlap: a bot check page carries a sign-in link, a
sign-in wall carries no postings, and an empty result list looks exactly like a broken selector unless the Platform says
otherwise.

1. **the response alone** — HTTP 429, a quota header reading exactly `0`, or an unsuccessful status carrying
   `Retry-After` → `RATE_LIMITED`; 403 → `BOT_CHECK`; 5xx → `UNREACHABLE`; any other 4xx → `LAYOUT_UNKNOWN` (a 404 on a
   URL the adapter built itself means the URL shape no longer holds);
2. **bot check** (`BOT_CHECK_SELECTORS`, `BOT_CHECK_PHRASES`) — checked before anything else that reads the page, since
   a challenge page's text says nothing about the search;
3. **sign-in** — the URL the load ended on matching `SIGN_IN_PATH_FRAGMENTS`, or a covering overlay from
   `SIGN_IN_OVERLAY_SELECTORS` → `SIGN_IN_REQUIRED`;
4. **rate limit stated in the page body** (`RATE_LIMIT_PHRASES`) → `RATE_LIMITED`;
5. **the job cards** — at least one posting carrying title, source URL and Posting_Id makes the page a result list →
   `POSTINGS`;
6. **with no readable posting** — an explicit "nothing matched" marker or phrase → `EMPTY_RESULT_LIST`; a long-form
   sign-in prompt → `SIGN_IN_REQUIRED`; anything else → `LAYOUT_UNKNOWN`.

Steps 1 to 4 are decided before the cards are read, so a page classified by one of them contributes no posting of its
own; steps 5 and 6 carry whatever the cards yielded. Either way the postings of the earlier pages are kept — that is the
Partial_Result, and the adapter takes a page's postings over before it looks at the classification.

Whether Jobvector offers a further Result_Page is detected before the sign-in and rate-limit steps and is reported
alongside those outcomes too, so the page count of a cut-short retrieval stays readable.

### Selector tables

All selector tables are ordered candidate lists — the first selector that matches anything wins — so a layout change is
repaired by putting the new selector in front rather than by rewriting the parser.

The schema.org microdata selectors (`itemtype*="JobPosting"`, `itemprop="…"`) lead every table on purpose. Jobvector is
a job board, so it publishes `JobPosting` structured data for search engines; that markup is a published contract rather
than a styling detail, which makes it both the likeliest to be present and the likeliest to survive a redesign. The
class-based candidates behind it (`.job-title`, `.job-company`, `.job-location`, `article.job-item` and their
neighbours) are read from the rendered result list and are the ones the parser tests of task 10.3 are expected to
correct.

| Table                                                                      | Purpose                                                                                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `CARD_SELECTORS`                                                           | the job cards of a Result_Page                                                                                       |
| `FIELD_SELECTORS`                                                          | title, link, employer, work location, publication date, description inside one card                                  |
| `POSTING_ID_ATTRIBUTES`                                                    | card attributes carrying the Posting_Id (`data-jobid`, `data-job-id`, `data-id`, `data-posting-id`, `id`)            |
| `POSTING_ID_QUERY_PARAMS`                                                  | the identifier parameters of a query-shaped advertisement URL (`jobId`, `jobid`, `job_id`, `id`)                     |
| `NEXT_PAGE_SELECTORS`                                                      | "there is a further Result_Page"; a present-but-disabled control and an anchor without `href` count as the last page |
| `EMPTY_RESULT_SELECTORS` / `EMPTY_RESULT_PHRASES`                          | Jobvector stating that the search matched nothing                                                                    |
| `SIGN_IN_PATH_FRAGMENTS` / `SIGN_IN_OVERLAY_SELECTORS` / `SIGN_IN_PHRASES` | the three characteristics of a sign-in wall                                                                          |
| `BOT_CHECK_SELECTORS` / `BOT_CHECK_PHRASES`                                | a Captcha or bot check page                                                                                          |
| `RATE_LIMIT_PHRASES` / `RATE_LIMIT_HEADERS` / `REMAINING_QUOTA_HEADERS`    | a reported fetch rate                                                                                                |
| `TRACKING_QUERY_PARAMS`                                                    | per-click parameters stripped from a posting's source URL                                                            |

Every phrase list is matched case-insensitively against the page text and carries **German and English wording**,
because Jobvector serves the same result list under `/jobs/` and `/en/jobs/`: a redirect onto the English surface must
not turn an empty search into a layout change, or an English bot check into an unreadable page.

The sign-in phrases are deliberately long ("melde dich an, um …", "please sign in to") rather than the bare word
"Anmelden": every Jobvector page carries a sign-in link in its header, so a short phrase would report a sign-in wall for
a perfectly readable result list. They are only consulted when the page yielded no readable posting.

`TRACKING_QUERY_PARAMS` (`ref`, `refid`, `src`, `source`, `trackid`, `gclid`, `fbclid`, `msclkid`, `ef_id` and the five
`utm_*` names) are removed from every stored source URL. A result link carries a per-impression campaign or referrer
parameter, so keeping it would change the stored URL and the Content_Hash of an unchanged posting on every run. The
Posting_Id and the path identify a posting; those parameters identify the click.

The Posting_Id is taken from a card attribute where present, otherwise from the advertisement URL, in two shapes and in
this order: an allow-listed identifier parameter — Jobvector serves part of its advertisement links as
`/jobs/?jobId=123456`, where the path carries no identifier at all — and then the last long digit run of the path, which
covers the readable form `/stellenangebote/123456-projektmanagerin/`. `POSTING_ID_QUERY_PARAMS` is an allow-list rather
than "any numeric parameter" and is disjoint from `TRACKING_QUERY_PARAMS`, because a tracking parameter is full of long
numbers that change per impression, and a Posting_Id that changed per Scrape_Run would make the upsert insert a
duplicate instead of updating.

## German Log_Stream lines

The adapter writes the progress of a running Scrape_Run line by line. The German text is the user-facing Log_View
wording; the English `code` is the stable key tests and the API_Service error mapping read. The codes are the same ones
the Stepstone adapter writes, because they identify the _observation_ and not the Platform — the Platform travels in the
Log_Stream entry and is named in the German sentence. Per the language convention, documentation and identifiers are
English and only the Log_Stream text, the Web_App strings and the Relevance_Reason are German.

| Code                          | Level | German text                                                                                              |
| ----------------------------- | ----- | -------------------------------------------------------------------------------------------------------- |
| `platform.pageFetched`        | INFO  | `Jobvector: Seite <n> gelesen, <m> Treffer gefunden.`                                                    |
| `platform.noResults`          | INFO  | `Jobvector: keine Treffer für die aktuellen Suchkriterien.`                                              |
| `platform.resultListComplete` | INFO  | `Jobvector: Ergebnisliste vollständig gelesen, <n> Seiten mit <m> Treffern.`                             |
| `platform.pageLimit`          | INFO  | `Jobvector: Seitenlimit erreicht, es wurden <n> Ergebnisseiten gelesen.`                                 |
| `platform.signInRequired`     | WARN  | `Jobvector zeigt Ergebnisse nur nach Anmeldung. Die Trefferliste ist für diese Plattform unvollständig.` |
| `platform.blocked`            | WARN  | `Jobvector hat den automatischen Abruf blockiert. Bitte später erneut versuchen.`                        |
| `platform.rateLimited`        | WARN  | `Jobvector hat die Abfragerate begrenzt. Der Abruf dieser Plattform wurde beendet.`                      |
| `platform.layoutUnknown`      | ERROR | `Der Seitenaufbau von Jobvector hat sich geändert; es konnten keine Treffer gelesen werden.`             |
| `platform.unreachable`        | ERROR | `Jobvector war nicht erreichbar. Bitte den Suchlauf später wiederholen.`                                 |
| `page.failed`                 | ERROR | `Jobvector hat auf Seite <n> nicht geantwortet. Treffer bis zu dieser Seite wurden gespeichert.`         |

The last row is the fallback for a Platform_Status without its own sentence, which is what an exhausted attempt series
reports.

## Ending a retrieval

Every end the adapter can observe is a result, not an exception. A sign-in wall, a bot check, an unreadable layout, a
reported fetch rate and the page limit all return the Job_Posting read so far together with one Platform_Status; a
thrown error would take the postings with it. The error classes are still used as the single place pairing an
observation with its Platform_Status and its log code — they are constructed and reported, not thrown.

The one exception is cancellation: an aborted Scrape_Run rejects, because only the Scraper_Service knows whether the
user cancelled or the runtime deadline struck.

A sign-in prompt and a bot check are recognised from a page that has already loaded, and the adapter returns from that
observation without a further page request. The remaining work is parsing and closing the page, so the 5-second bound on
ending a Platform's retrieval holds by construction rather than by a timer.

## Fixtures and the refresh loop

**No capture against the live Platform has been performed in this repository yet**, and unlike Stepstone there is a
recorded reason beyond "nobody tried":

| Observation                | Detail                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------- |
| Capture attempt            | performed while implementing the adapter; no fixture was written                      |
| Response from jobvector.de | **HTTP 403**                                                                          |
| Browser binary             | none installed in this environment, so the production page runtime cannot load a page |
| Confirmed capture date     | none                                                                                  |

A 403 is what this adapter's own classification reads as `BOT_CHECK` → Platform_Status `PLATFORM_BLOCKED`, so the single
real response seen so far is consistent with Jobvector refusing an automated request outright. One observation is not a
verdict — it carried no browser-like user agent, and the status may depend on the path, the origin or the day — but it
is the one piece of evidence about this Platform that exists, and it means the selector tables and the parameter names
below remain the best available reading of Jobvector's markup rather than a confirmed one.

Any fixture file present under `packages/scrapers/src/adapters/jobvector/__fixtures__/` without a `<case>.capture.json`
sidecar is hand-authored test input, not a capture; the sidecar's `capturedAt` is the only trustworthy capture date.

### Capturing

```bash
pnpm fixtures:capture --platform jobvector [--case <name>] [--page <n>] [--url <url>] [--out <dir>] [--force]
```

One invocation performs **exactly one** real Result_Page retrieval. The guarantees are in the code, not in this
paragraph:

- `USER_AGENT_CONTACT` must be set in the environment or in `.env`, otherwise the capture sends nothing;
- the capture refuses to run under a test runner or in CI — `CI`, `GITHUB_ACTIONS`, `VITEST`, `NODE_ENV=test` and
  further markers each abort it;
- the robots.txt of the Platform is retrieved and evaluated **first** and gates the capture;
- the single page load goes through the production runtime, so it carries the unchanged user agent, a fresh storage
  state, the resource filter and the 30-second page limit; a second load throws;
- the captured document is sanitized before it is written: `<script>` and `<style>` elements, stylesheet `<link>`s,
  tracking pixels and beacon frames, and identifier-like query parameters in URL attributes are removed;
- an existing fixture is never replaced without `--force`.

### Layout

| File                                                      | Content                                                                                                                                                    |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/jobvector/__fixtures__/<case>.html`         | the sanitized document, byte-identical afterwards (`__fixtures__` is in `.prettierignore`)                                                                 |
| `src/adapters/jobvector/__fixtures__/<case>.capture.json` | the sidecar: `capturedAt`, page number, requested and final URL, HTTP status, user agent, raw and sanitized byte counts, and what the sanitization removed |

The metadata sits beside the HTML rather than in a header comment, so a reviewer sees the capture date in the diff
without the page itself being edited.

### Expected cases

The eight cases the parser tests are expected to cover (`REQUIRED_FIXTURE_CASES`):

`result-list-page-1`, `result-list-page-2`, `result-list-empty`, `layout-changed`, `sign-in-wall`, `captcha`,
`rate-limited`, `relative-dates`.

A Platform that answers 403 hands out none of these on demand, so the cases are hand-authored until a capture succeeds —
which is also why the sidecar, not the file's presence, is what dates a fixture.

### Refresh loop

When a real Scrape_Run or an opt-in live smoke test reports `PAGE_LAYOUT_UNKNOWN`:

1. re-capture the affected cases with `pnpm fixtures:capture --platform jobvector --case <name> --force`;
2. put the new selector in front of its candidate list in `parse-result-list.ts`;
3. regenerate the expected JSON and review that diff rather than overwriting it blindly;
4. update this file — the selector status, the URL if it changed, and the terms-of-use review date.

## Source files

| File                                                            | What it holds                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `packages/scrapers/src/adapters/jobvector/index.ts`             | the page loop, the page budget, the return-rather-than-throw rule                                                  |
| `packages/scrapers/src/adapters/jobvector/result-list-url.ts`   | `JOBVECTOR_ORIGIN`, `jobvectorResultListUrl`, `jobvectorKeywordQuery`, the query parameter names, the radius steps |
| `packages/scrapers/src/adapters/jobvector/parse-result-list.ts` | the selector tables, the `ResultPageOutcome` union, the classification order                                       |
| `packages/scrapers/src/adapters/jobvector/messages.ts`          | the German Log_Stream lines and their stable English codes                                                         |
| `packages/scrapers/src/adapters/search-criteria.ts`             | reading one Criterion_Field out of an effective Search_Profile                                                     |
| `packages/scrapers/src/adapter/types.ts`                        | `RESULT_PAGE_BUDGET` (10), `RESULT_PAGE_TIMEOUT_MS` (30 000)                                                       |
| `packages/scrapers/src/scheduling/platform-queue.ts`            | `MIN_REQUEST_GAP_MS` (2000), `MAX_REQUEST_ATTEMPTS` (3)                                                            |
| `packages/scrapers/src/robots/robots.ts`                        | the robots.txt evaluation and `ROBOTS_FETCH_TIMEOUT_MS` (10 000)                                                   |
| `packages/scrapers/src/runtime/user-agent.ts`                   | the user agent of every outgoing request                                                                           |
| `packages/scrapers/src/runtime/browser.ts`                      | the browser context per Platform, `BLOCKED_RESOURCE_TYPES`, the teardown                                           |
| `packages/scrapers/src/fixtures/capture.ts`                     | the capture flow and its refusals                                                                                  |
| `packages/scrapers/src/fixtures/fixture-paths.ts`               | the fixture layout and `REQUIRED_FIXTURE_CASES`                                                                    |
| `packages/domain/src/search-profile/capabilities.ts`            | the Jobvector capability declaration                                                                               |
| `packages/domain/src/search-profile/constants.ts`               | the Default_Search_Profile and the Jobvector Platform_Override                                                     |
