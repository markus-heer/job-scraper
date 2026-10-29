# Stepstone Platform_Adapter

The etiquette and operating document of the Stepstone Platform_Adapter, required by acceptance criterion 14.7: one
documentation file per Platform_Adapter naming the source URL of the retrieved result list, the retrieval scope with the
retrieved paths, the maximum number of pages per Scrape_Run, the respected waiting time and the date of the last review
of the terms of use in ISO 8601 format.

This file is written from the adapter source. Every number and every path below is traceable to a named constant; the
section [Source files](#source-files) lists where each one lives. Where the source itself marks a value as unconfirmed,
this document says so rather than presenting it as settled — see [Provisional parameters](#provisional-parameters).

## At a glance

| Item                                   | Value                                                               |
| -------------------------------------- | ------------------------------------------------------------------- |
| Platform                               | `STEPSTONE`                                                         |
| Origin                                 | `https://www.stepstone.de`                                          |
| Result list path shape                 | `/jobs/<job-title-slug>/in-<location-slug>`                         |
| Maximum pages per Scrape_Run           | 10 (`RESULT_PAGE_BUDGET`)                                           |
| Minimum gap between requests           | 2 s (`MIN_REQUEST_GAP_MS`), or a longer stated `Crawl-delay`        |
| Attempts per Result_Page               | at most 3 (`MAX_REQUEST_ATTEMPTS`)                                  |
| Time limit per Result_Page             | 30 s (`RESULT_PAGE_TIMEOUT_MS`)                                     |
| Sign-in                                | never; no credentials are supplied and no storage state is reused   |
| Last terms-of-use review               | not yet performed — see [Terms-of-use review](#terms-of-use-review) |
| Last capture against the live Platform | none yet — see [Fixtures](#fixtures-and-the-refresh-loop)           |

## Source URL of the retrieved result list

The result list URL is built from the effective Search_Profile of Stepstone, never hand-written. With the
Default_Search_Profile and the Stepstone Platform_Override currently in the source code (`jobTitle` "Projektmanagerin",
`searchLocation` "München", six title synonyms, `searchRadiusKm` 30 from the override, `employmentType` `PERMANENT`,
`publicationPeriodDays` 30), the first Result_Page is:

```text
https://www.stepstone.de/jobs/projektmanagerin/in-muenchen?q=%22Projektmanagerin%22+OR+%22Projektmanager%22+OR+%22Project+Manager%22+OR+%22Projektleiterin%22+OR+%22Projektleiter%22+OR+%22Project+Lead%22+OR+%22Teilprojektleiterin%22&radius=30&ag=age_30&ct=permanent
```

Every following Result_Page is the same URL with `&page=<n>` appended:

```text
https://www.stepstone.de/jobs/projektmanagerin/in-muenchen?q=...&radius=30&ag=age_30&ct=permanent&page=2
```

`page` is omitted for the first Result_Page on purpose: that URL is the result list entry point — the address a person
opens, the one the robots.txt decision is made for, and the one documented here.

The URL is a deterministic function of the profile and the page number, including the order of the query parameters
(`q`, `radius`, `ag`, `ct`, `page`). That is what lets the robots.txt evaluation run against `resultListUrl(profile, 1)`
and lets a fixture test compare URLs literally.

### How a Criterion_Field reaches the URL

Stepstone's capability declaration supports six Criterion_Field, and all six are mapped — a supported field that
silently never reached the query would make the read-only criteria view claim a filter the retrieval never applied.

| Criterion_Field              | Where it goes                     | Mapping                                                                                                                                     |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobTitle` (mandatory)       | first path segment                | slug: lowercased, `ä ö ü ß` transliterated to `ae oe ue ss`, remaining diacritics dropped, anything else collapsed into single hyphens      |
| `searchLocation` (mandatory) | second path segment, `in-` prefix | same slug rule                                                                                                                              |
| `titleSynonyms`              | `q`                               | job title first, then the synonyms, each quoted and joined with `OR`; duplicates dropped case-insensitively. Omitted when the list is empty |
| `searchRadiusKm`             | `radius`                          | raised to the next larger step of `0, 5, 10, 20, 30, 50, 100`; a radius above 100 km omits the parameter entirely                           |
| `publicationPeriodDays`      | `ag`                              | raised to the next larger bucket of `1, 3, 7, 14, 30` and sent as `age_<days>`; a period above 30 days omits the parameter                  |
| `employmentType`             | `ct`                              | `PERMANENT` → `permanent`, `TEMPORARY` → `temporary`, `CONTRACT` → `contract`, `ANY` → parameter omitted                                    |

Both roundings go upward, never downward. A smaller radius or a shorter age window would drop Job_Posting the user asked
for; a larger one only adds postings the Commute_Service and the Relevance_Service then rate.

Building the URL fails with a `RangeError` for a page number that is not a positive integer, for a Search_Profile
missing one of the two mandatory fields, and for a job title or search location whose slug would be empty.

## Retrieval scope

### Retrieved paths

Exactly one path family, on one origin:

| What               | Path                                                  | When                                                |
| ------------------ | ----------------------------------------------------- | --------------------------------------------------- |
| robots.txt         | `https://www.stepstone.de/robots.txt`                 | once per Platform and Scrape_Run, before page 1     |
| Result_Page 1      | `/jobs/<job-title-slug>/in-<location-slug>?<filters>` | always, if robots.txt permits it                    |
| Result_Page 2 … 10 | the same path with `&page=<n>`                        | only while the previous page offered a further page |

The `www` host is the one the robots.txt is read from and the one every page request goes to.

### What is never retrieved

- **No job advertisement detail pages.** The adapter reads result list pages only. The eight fields of the Job_Posting
  are taken from the result cards; a posting's own page is linked, not fetched.
- **No content behind a sign-in.** The browser context is opened with `storageState: undefined` and no credentials exist
  anywhere in the Job_Tool, so the retrieval structurally cannot sign in. A sign-in redirect or a covering sign-in
  overlay ends this Platform's retrieval.
- **No Captcha or bot check is answered.** A challenge page ends the retrieval.
- **No images, fonts, media or stylesheets.** The request interception drops those four resource types, so Stepstone
  serves the document and the scripts only. The eight fields live in the markup; everything else is bytes nobody reads.
- **No service worker**, so a cached response cannot hide what the Platform actually served — including a sign-in wall
  or a bot check the adapter has to detect.
- **No parallel requests to Stepstone.** One page request per Platform at a time.

## Maximum pages per Scrape_Run

**10 Result_Page per Scrape_Run.** The adapter reads `context.pageBudget`, truncates it to an integer and clamps it into
`[0, RESULT_PAGE_BUDGET]`, so the upper bound of 10 holds even if a caller passes a larger budget. The tests shrink the
budget to make the limit observable without ten fixtures; production passes `RESULT_PAGE_BUDGET`.

Pagination stops on the first of these:

1. the page offered no further Result_Page → Platform_Status `COMPLETED`;
2. the page stated an empty result list → Platform_Status `COMPLETED`;
3. the budget is spent while Stepstone still offers a further page → Platform_Status `PAGE_LIMIT_REACHED`, which marks
   the result a Partial_Result, because this Platform's result list was not read to its end;
4. the page ended the retrieval (sign-in, bot check, rate limit, unreadable layout, unreachable Platform) → the matching
   Platform_Status, with the postings read so far kept.

## Respected waiting time

**At least 2 seconds between two page requests to Stepstone**, measured between the starts of two requests and enforced
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

Every request to Stepstone — the robots.txt retrieval and every page request alike — carries the same unchanged user
agent, built once from the `USER_AGENT_CONTACT` value of the local environment file:

```text
JobTool/0.1 (private use; contact: <USER_AGENT_CONTACT>)
```

It names the tool, states the private purpose of use and carries a reachable contact detail, and it contains none of the
tokens that would make it readable as a common browser (`Mozilla/5.0`, `Chrome/<version>`, `Safari/<version>`). Without
a usable contact detail the Job_Tool sends no request at all; the API_Service reports that at startup.

## robots.txt

`https://www.stepstone.de/robots.txt` is retrieved once per Platform and Scrape_Run, before the first page request, and
the decision is reused for the rest of that run. It gates the retrieval:

- a disallowed intended path → Platform_Status `EXCLUDED_BY_ROBOTS_TXT`; no page request is sent, no Job_Posting of
  Stepstone is stored, and the remaining Platform_Adapter keep running;
- not retrievable within 10 seconds, or unevaluable → Platform_Status `ROBOTS_TXT_UNAVAILABLE`, and Stepstone is skipped
  for that run;
- a stated `Crawl-delay` longer than 2 seconds is applied as the gap between page requests.

The decision is re-evaluated on every Scrape_Run, so a change on Stepstone's side takes effect by itself. No bypass
exists. The fixture capture script runs the same gate before its single request, because a capture is a request like any
other.

**The robots.txt of stepstone.de has not been read in this repository yet.** Whether the result list path is allowed and
whether a `Crawl-delay` is stated are therefore open questions that the first capture or the first real Scrape_Run
answers; the gate decides it at runtime either way.

## Terms-of-use review

**Date of the last review of the terms of use: not yet performed.**

Acceptance criterion 14.7 asks for this date in ISO 8601 format, and writing one here would be a fiction: nobody has
read Stepstone's terms of use for this project yet, and no automated step can substitute for that. The field is kept in
the required shape and left explicitly open instead.

| Field                    | Value             |
| ------------------------ | ----------------- |
| Last terms-of-use review | — (not performed) |
| Reviewed by              | —                 |
| Reviewed document        | —                 |

What has to happen before the Job_Tool performs its first real retrieval of Stepstone:

1. read the terms of use currently published by Stepstone and decide whether the retrieval described in
   [Retrieval scope](#retrieval-scope) is defensible for private single-user use;
2. record the date of that reading in this table as `YYYY-MM-DD`, together with who read it and which document version;
3. re-do it whenever the adapter's retrieval scope changes, and on every fixture re-capture.

This document is not legal advice. The technical constraints — robots.txt, 2 seconds, 10 pages, no sign-in, no Captcha —
reduce the risk; they do not replace the review.

## Provisional parameters

The URL mapping is only partly confirmed, and the source code marks the split explicitly:

| Part                                                      | Status                                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `/jobs/<title>/in-<location>` path shape                  | stable, user-visible part of a Stepstone search URL                                           |
| `radius`                                                  | stable                                                                                        |
| `page`                                                    | stable                                                                                        |
| `ag` (posting age), `ct` (contract type), `q` (keywords)  | **provisional**, read from Stepstone's own search UI, awaiting confirmation by a real capture |
| radius steps `0, 5, 10, 20, 30, 50, 100`                  | **provisional**                                                                               |
| age buckets `1, 3, 7, 14, 30`                             | **provisional**                                                                               |
| contract type values `permanent`, `temporary`, `contract` | **provisional**                                                                               |

A wrong filter parameter degrades gracefully: Stepstone ignores a query parameter it does not know, so the retrieval
still reads a result list, only a wider one than the Search_Profile asked for. A wrong _path_ would not degrade, which
is why the path carries nothing but the two mandatory fields. The four tables sit in one file, so a correction is one
edit.

When a capture confirms or corrects these names, update `result-list-url.ts`, the [At a glance](#at-a-glance) and
[Source URL](#source-url-of-the-retrieved-result-list) sections here, and the review date.

## Page classification

One Result_Page is read by a pure, browser-free function: HTML plus the response that carried it in, one outcome plus
the raw postings of that page out. It never throws — every failure it can observe already has a Platform_Status, and an
exception would lose the Partial_Result.

The classification order matters, because the characteristics overlap: a bot check page carries a sign-in link, a
sign-in wall carries no postings, and an empty result list looks exactly like a broken selector unless the Platform says
otherwise.

1. **the response alone** — HTTP 429, an exhausted-quota header reading `0`, or an unsuccessful status with
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

Postings parsed from a page that also ended the retrieval are kept: a sign-in overlay or a bot check can sit above a
readable part of the list, and those postings are the Partial_Result.

### Selector tables

All selector tables are ordered candidate lists — the first selector that matches anything wins — so a layout change is
repaired by putting the new selector in front rather than by rewriting the parser. They are written against the
`data-at` attributes Stepstone renders on its job cards, with `data-testid` variants kept as fallbacks because Stepstone
serves both spellings depending on the rendering path.

| Table                                                                      | Purpose                                                                                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `CARD_SELECTORS`                                                           | the job cards of a Result_Page                                                                                       |
| `FIELD_SELECTORS`                                                          | title, link, employer, work location, publication date, description inside one card                                  |
| `POSTING_ID_ATTRIBUTES`                                                    | card attributes carrying the Posting_Id (`data-id`, `data-job-id`, `data-posting-id`, `id`)                          |
| `NEXT_PAGE_SELECTORS`                                                      | "there is a further Result_Page"; a present-but-disabled control and an anchor without `href` count as the last page |
| `EMPTY_RESULT_SELECTORS` / `EMPTY_RESULT_PHRASES`                          | Stepstone stating that the search matched nothing                                                                    |
| `SIGN_IN_PATH_FRAGMENTS` / `SIGN_IN_OVERLAY_SELECTORS` / `SIGN_IN_PHRASES` | the three characteristics of a sign-in wall                                                                          |
| `BOT_CHECK_SELECTORS` / `BOT_CHECK_PHRASES`                                | a Captcha or bot check page                                                                                          |
| `RATE_LIMIT_PHRASES` / `RATE_LIMIT_HEADERS` / `REMAINING_QUOTA_HEADERS`    | a reported fetch rate                                                                                                |
| `TRACKING_QUERY_PARAMS`                                                    | per-click parameters stripped from a posting's source URL                                                            |

The sign-in phrases are deliberately long ("melde dich an, um …") rather than the bare word "Anmelden": every Stepstone
page carries a sign-in link in its header, so a short phrase would report a sign-in wall for a perfectly readable result
list. They are only consulted when the page yielded no readable posting.

`TRACKING_QUERY_PARAMS` (`rltr`, `rtr`, `intcid`, `ssrc`, `ssid`, `suid`, `gclid`, `ef_id` and the five `utm_*` names)
are removed from every stored source URL. Stepstone appends a per-impression parameter to each result link, so keeping
it would change the stored URL and the Content_Hash of an unchanged posting on every run. The Posting_Id and the path
identify a posting; those parameters identify the click.

The Posting_Id is taken from a card attribute where present, otherwise from the advertisement URL — the number behind
the last double hyphen of `/stellenangebote--Projektmanagerin-Muenchen-Beispiel-GmbH--12345678-inline.html`, or the last
long digit run of the path. Only the path is searched, never the query string, so a tracking parameter full of changing
numbers cannot become an identifier.

## German Log_Stream lines

The adapter writes the progress of a running Scrape_Run line by line. The German text is the user-facing Log_View
wording; the English `code` is the stable key tests and the API_Service error mapping read. Per the language convention,
documentation and identifiers are English and only the Log_Stream text, the Web_App strings and the Relevance_Reason are
German.

| Code                          | Level | German text                                                                                              |
| ----------------------------- | ----- | -------------------------------------------------------------------------------------------------------- |
| `platform.pageFetched`        | INFO  | `Stepstone: Seite <n> gelesen, <m> Treffer gefunden.`                                                    |
| `platform.noResults`          | INFO  | `Stepstone: keine Treffer für die aktuellen Suchkriterien.`                                              |
| `platform.resultListComplete` | INFO  | `Stepstone: Ergebnisliste vollständig gelesen, <n> Seiten mit <m> Treffern.`                             |
| `platform.pageLimit`          | INFO  | `Stepstone: Seitenlimit erreicht, es wurden <n> Ergebnisseiten gelesen.`                                 |
| `platform.signInRequired`     | WARN  | `Stepstone zeigt Ergebnisse nur nach Anmeldung. Die Trefferliste ist für diese Plattform unvollständig.` |
| `platform.blocked`            | WARN  | `Stepstone hat den automatischen Abruf blockiert. Bitte später erneut versuchen.`                        |
| `platform.rateLimited`        | WARN  | `Stepstone hat die Abfragerate begrenzt. Der Abruf dieser Plattform wurde beendet.`                      |
| `platform.layoutUnknown`      | ERROR | `Der Seitenaufbau von Stepstone hat sich geändert; es konnten keine Treffer gelesen werden.`             |
| `platform.unreachable`        | ERROR | `Stepstone war nicht erreichbar. Bitte den Suchlauf später wiederholen.`                                 |
| `page.failed`                 | ERROR | `Stepstone hat auf Seite <n> nicht geantwortet. Treffer bis zu dieser Seite wurden gespeichert.`         |

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

**No capture against the live Platform has been performed in this repository yet.** A capture needs a browser binary and
a live request to stepstone.de, and neither has happened, so there is no confirmed-against-reality capture date to cite
here and the selector tables above remain the best available reading of Stepstone's markup rather than a confirmed one.
Any fixture file present under `packages/scrapers/src/adapters/stepstone/__fixtures__/` without a `<case>.capture.json`
sidecar is hand-authored test input, not a capture; the sidecar's `capturedAt` is the only trustworthy capture date.

### Capturing

```bash
pnpm fixtures:capture --platform stepstone [--case <name>] [--page <n>] [--url <url>] [--out <dir>] [--force]
```

One invocation performs **exactly one** real Result_Page retrieval. The guarantees are in the code, not in this
paragraph:

- `USER_AGENT_CONTACT` must be set in the environment or in `.env`, otherwise the capture sends nothing;
- the capture refuses to run under a test runner or in CI — `CI`, `GITHUB_ACTIONS`, `VITEST`, `NODE_ENV=test` and six
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
| `src/adapters/stepstone/__fixtures__/<case>.html`         | the sanitized document, byte-identical afterwards (`__fixtures__` is in `.prettierignore`)                                                                 |
| `src/adapters/stepstone/__fixtures__/<case>.capture.json` | the sidecar: `capturedAt`, page number, requested and final URL, HTTP status, user agent, raw and sanitized byte counts, and what the sanitization removed |

The metadata sits beside the HTML rather than in a header comment, so a reviewer sees the capture date in the diff
without the page itself being edited.

### Expected cases

The eight cases the parser tests are expected to cover (`REQUIRED_FIXTURE_CASES`):

`result-list-page-1`, `result-list-page-2`, `result-list-empty`, `layout-changed`, `sign-in-wall`, `captcha`,
`rate-limited`, `relative-dates`.

### Refresh loop

When a real Scrape_Run or an opt-in live smoke test reports `PAGE_LAYOUT_UNKNOWN`:

1. re-capture the affected cases with `pnpm fixtures:capture --platform stepstone --case <name> --force`;
2. put the new selector in front of its candidate list in `parse-result-list.ts`;
3. regenerate the expected JSON and review that diff rather than overwriting it blindly;
4. update this file — the selector status, the URL if it changed, and the terms-of-use review date.

## Source files

| File                                                            | What it holds                                                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/scrapers/src/adapters/stepstone/index.ts`             | the page loop, the page budget, the return-rather-than-throw rule                                                                             |
| `packages/scrapers/src/adapters/stepstone/result-list-url.ts`   | `STEPSTONE_ORIGIN`, `stepstoneResultListUrl`, `stepstoneSlug`, `stepstoneKeywordQuery`, the radius steps, the age buckets, the contract types |
| `packages/scrapers/src/adapters/stepstone/parse-result-list.ts` | the selector tables, the `ResultPageOutcome` union, the classification order                                                                  |
| `packages/scrapers/src/adapters/stepstone/messages.ts`          | the German Log_Stream lines and their stable English codes                                                                                    |
| `packages/scrapers/src/adapter/types.ts`                        | `RESULT_PAGE_BUDGET` (10), `RESULT_PAGE_TIMEOUT_MS` (30 000)                                                                                  |
| `packages/scrapers/src/scheduling/platform-queue.ts`            | `MIN_REQUEST_GAP_MS` (2000), `MAX_REQUEST_ATTEMPTS` (3)                                                                                       |
| `packages/scrapers/src/robots/robots.ts`                        | the robots.txt evaluation and `ROBOTS_FETCH_TIMEOUT_MS` (10 000)                                                                              |
| `packages/scrapers/src/runtime/user-agent.ts`                   | the user agent of every outgoing request                                                                                                      |
| `packages/scrapers/src/runtime/browser.ts`                      | the browser context per Platform, `BLOCKED_RESOURCE_TYPES`, the teardown                                                                      |
| `packages/scrapers/src/fixtures/capture.ts`                     | the capture flow and its refusals                                                                                                             |
| `packages/scrapers/src/fixtures/fixture-paths.ts`               | the fixture layout and `REQUIRED_FIXTURE_CASES`                                                                                               |
| `packages/domain/src/search-profile/capabilities.ts`            | the Stepstone capability declaration                                                                                                          |
| `packages/domain/src/search-profile/constants.ts`               | the Default_Search_Profile and the Stepstone Platform_Override                                                                                |
