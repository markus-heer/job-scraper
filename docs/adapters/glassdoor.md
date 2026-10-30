# Glassdoor Platform_Adapter

The etiquette and operating document of the Glassdoor Platform_Adapter, required by acceptance criterion 14.7: one
documentation file per Platform_Adapter naming the source URL of the retrieved result list, the retrieval scope with the
retrieved paths, the maximum number of pages per Scrape_Run, the respected waiting time and the date of the last review
of the terms of use in ISO 8601 format.

This file is written from the adapter source. Every number and every path below is traceable to a named constant; the
section [Source files](#source-files) lists where each one lives. Where the source itself marks a value as unconfirmed,
this document says so rather than presenting it as settled — see [Provisional parameters](#provisional-parameters).

Glassdoor differs from Stepstone and Jobvector in one way that decides most of the sections below: **one real capture
has been performed and it succeeded.** On 2026-10-29 glassdoor.de answered the honest Job_Tool user agent with HTTP 200
and 30 readable Job_Posting, so the selectors, the URL parameters and the pagination of this adapter are described from
a response rather than from a reading of the Platform's search interface. The same capture showed three things that a
reader needs before trusting a Glassdoor result list: the Platform **rewrites the request onto its own canonical URL and
drops the location and the radius**, it **ignores the `page` parameter**, and it states a publication date as a compact
day count. Each has its own section.

What the capture does **not** establish is anything about the next request. It was one request from one address on one
day; the design's risk note still expects this Platform to answer an automated browser with a Captcha, a sign-in wall or
an empty list, and the Platform can be deactivated in the source code for exactly that case — see
[Deactivating the Platform](#deactivating-the-platform-in-the-source-code).

## At a glance

| Item                                      | Value                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| Platform                                  | `GLASSDOOR`                                                                          |
| Activation in the source code             | activated (`PLATFORM_ACTIVATION.GLASSDOOR` is `true`)                                |
| Origin                                    | `https://www.glassdoor.de`                                                           |
| Result list path shape                    | `/Job/jobs.htm` with every criterion in the query string                             |
| Path the Platform serves the response for | its own canonical `/Job/…-jobs-SRCH_KO0,142.htm`                                     |
| Maximum pages per Scrape_Run              | the Page_Safety_Limit of 100 (`RESULT_PAGE_BUDGET`); the walk ends at the last block |
| Minimum gap between requests              | 2 s (`MIN_REQUEST_GAP_MS`), or a longer stated `Crawl-delay`                         |
| Attempts per Result_Page                  | at most 3 (`MAX_REQUEST_ATTEMPTS`)                                                   |
| Time limit per Result_Page                | 30 s (`RESULT_PAGE_TIMEOUT_MS`)                                                      |
| Sign-in                                   | never; no credentials are supplied and no storage state is reused                    |
| Last terms-of-use review                  | not yet performed — see [Terms-of-use review](#terms-of-use-review)                  |
| Last robots.txt review                    | 2026-10-29, path permitted, no `Crawl-delay` stated                                  |
| Last capture against the live Platform    | 2026-10-29, HTTP 200, 30 readable Job_Posting                                        |

## Source URL of the retrieved result list

The result list URL is built from the effective Search_Profile of Glassdoor, never hand-written. Glassdoor has no
Platform_Override, so every value comes from the Default_Search_Profile currently in the source code (`jobTitle`
"Projektmanagerin", six title synonyms, `searchLocation` "München", `searchRadiusKm` 50). The first Result_Page is:

```text
https://www.glassdoor.de/Job/jobs.htm?sc.keyword=%22Projektmanagerin%22+OR+%22Projektmanager%22+OR+%22Project+Manager%22+OR+%22Projektleiterin%22+OR+%22Projektleiter%22+OR+%22Project+Lead%22+OR+%22Teilprojektleiterin%22&locKeyword=M%C3%BCnchen&radius=50
```

That is the URL the capture of 2026-10-29 sent, byte for byte (`__fixtures__/result-list-page-1.capture.json`,
`requestUrl`). Every following Result_Page is the same URL with `&page=<n>` appended:

```text
https://www.glassdoor.de/Job/jobs.htm?sc.keyword=...&locKeyword=M%C3%BCnchen&radius=50&page=2
```

`page` is omitted for the first Result_Page on purpose: that URL is the result list entry point — the address a person
opens, the one the robots.txt decision is made for, and the one documented here.

The URL is a deterministic function of the profile and the page number, including the order of the query parameters
(`sc.keyword`, `locKeyword`, `radius`, `page`). That is what lets the robots.txt evaluation run against
`resultListUrl(profile, 1)` and lets a fixture test compare URLs literally.

### The Platform rewrites the URL and keeps one of the three parameters

This is the finding of the capture that matters most for reading a Glassdoor result list, and it is a documented
widening of the retrieval rather than a defect:

```text
sent:      /Job/jobs.htm?sc.keyword=…&locKeyword=M%C3%BCnchen&radius=50
landed on: /Job/%22Projektmanagerin%22-OR-…-jobs-SRCH_KO0,142.htm?sc.keyword=…
```

Two consequences, both read off the final URL in the capture sidecar:

- **`locKeyword` and `radius` are gone**, so the response was served for a **nationwide** result list. The 30 captured
  postings bear that out: Dresden, Ulm and Ummendorf appear in a search whose stated place was München. The retrieval
  therefore reads more than the Search_Profile asked for, and the Commute_Service is what rates the work locations
  afterwards (8.1). Nothing is sent that the Job_Tool cannot resolve — Glassdoor carries a resolved place as a
  `locT`/`locId` pair minted by its own autocomplete — so the parameter stays as it is.
- **`SRCH_KO0,142` states what became of the keyword expression:** offsets 0 to 142 of a _single_ keyword, which is the
  whole 142-character `"A" OR "B" OR …` expression read as one literal term. `OR` is not an operator here. It did not
  collapse the result list — 30 postings came back — but the matches are looser than the quoted phrases asked for, as
  titles such as "Fachbauleiter (m/w/d)" among the captured cards show. The Relevance_Service is what judges a loose
  match (15.2).

### How a Criterion_Field reaches the URL

Glassdoor's capability declaration supports four Criterion_Field, and all four are mapped — a supported field that
silently never reached the query would make the read-only criteria view claim a filter the retrieval never applied. Note
the difference between _reaching the query_ and _being honoured_: three of the four reach it, and only `sc.keyword`
survives the Platform's rewrite.

| Criterion_Field              | Where it goes | Mapping                                                                                                                                                                                  |
| ---------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobTitle` (mandatory)       | `sc.keyword`  | first term of the keyword expression, quoted                                                                                                                                             |
| `titleSynonyms`              | `sc.keyword`  | job title first, then the synonyms, each quoted and joined with `OR`; duplicates dropped case-insensitively, blank terms dropped                                                         |
| `searchLocation` (mandatory) | `locKeyword`  | the value with inner whitespace collapsed. **Dropped by the Platform**                                                                                                                   |
| `searchRadiusKm`             | `radius`      | raised to the next larger step of `10, 25, 50, 100, 200` (`GLASSDOOR_RADIUS_STEPS_KM`); above 200 the parameter is omitted entirely. **Dropped by the Platform along with the location** |

Three fields the other adapters map are **not** mapped here, because Glassdoor does not declare them as supported and
the Profile_Resolver therefore never offers them: `industry`, `employmentType` and `publicationPeriodDays`. The
commented-out `GLASSDOOR: { employmentType: 'PERMANENT' }` entry in the Platform_Override constants is a deliberate
demonstration of 4.5 — uncommenting it is a compile error.

`searchLocation` is mandatory for this Platform even though the Platform drops it. That is the capability declaration
speaking, not the URL builder: Glassdoor's result list is a search over a place, so a Search_Profile without one states
no search this adapter can build, and the field is read through `requiredCriterionValue`.

The radius rounding goes upward, never downward. A smaller radius would drop Job_Posting the user asked for; a larger
one only adds postings the Commute_Service and the Relevance_Service then rate. A radius above the largest step omits
the parameter rather than capping it, because searching the whole country is the closer reading of "larger than the
selector offers" than quietly shrinking the area.

Building the URL fails with a `RangeError` for a page number that is not a positive integer and for a Search_Profile
missing either of the two mandatory Criterion_Field of Glassdoor.

## Retrieval scope

### Retrieved paths

Exactly one path family, on one origin:

| What              | Path                                              | When                                                                                           |
| ----------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| robots.txt        | `https://www.glassdoor.de/robots.txt`             | once per Platform and Scrape_Run, before page 1                                                |
| Result_Page 1     | `/Job/jobs.htm?sc.keyword=…` (filters as above)   | always, if robots.txt permits it                                                               |
| Further blocks    | no URL of their own                               | reached by operating `button[data-test="load-more"]` (13.12); see the pagination section below |
| Followed redirect | the Platform's own `/Job/…-jobs-SRCH_KO0,142.htm` | whenever Glassdoor rewrites the request, which it did on every capture                         |

The `www` host is the one the robots.txt is read from and the one every page request goes to. The adapter builds no
canonical `SRCH_…` URL itself; that path is reached only because the Platform redirects onto it, and it is the URL the
response and every relative link in it are resolved against.

### What is never retrieved

- **No job advertisement detail pages.** The adapter reads result list pages only. The eight fields of the Job_Posting
  are taken from the result cards; a posting's own page is linked, not fetched.
- **No content behind a sign-in.** The browser context is opened with `storageState: undefined` and no credentials exist
  anywhere in the Job_Tool, so the retrieval structurally cannot sign in. A sign-in redirect or a covering sign-in
  overlay ends this Platform's retrieval.
- **No Captcha or bot check is answered.** A challenge page ends the retrieval. There is no code in this adapter that
  submits a challenge form, reads a challenge token or follows a challenge redirect (7.6).
- **No "Mehr Jobs anzeigen" control is operated.** Glassdoor loads its next block of results with a request of its own
  behind that button; the adapter reads the control as "a further Result_Page exists" and never clicks it. See
  [Maximum pages per Scrape_Run](#maximum-pages-per-scrape_run).
- **No images, fonts, media or stylesheets.** The request interception drops those four resource types
  (`BLOCKED_RESOURCE_TYPES`), so Glassdoor serves the document and the scripts only.
- **No service worker**, so a cached response cannot hide what the Platform actually served — including a sign-in wall
  or a bot check the adapter has to detect.
- **No parallel requests to Glassdoor.** One page request per Platform at a time.

## Maximum pages per Scrape_Run

**1 Result_Page per Scrape_Run**, below the 10 of Requirement 13.3. The adapter reads `context.pageBudget`, truncates it
to an integer and clamps it into `[0, RESULT_PAGE_BUDGET]`, so neither the production budget of 13.3 nor a larger one
raises this Platform's own cap of 1. A test may still shrink the budget further; it cannot raise it. Production passes
`RESULT_PAGE_BUDGET` and gets one page.

The cap is this Platform's and the reason is below in
[Glassdoor ignores the `page` parameter](#glassdoor-ignores-the-page-parameter-and-what-that-costs): the second page
request would re-read the first block of results, so the ten pages of 13.3 bought nothing and cost nine requests against
a third party.

Pagination stops on the first of these:

1. the page offered no further Result_Page → Platform_Status `COMPLETED`;
2. the page stated an empty result list → Platform_Status `COMPLETED`;
3. the budget is spent while Glassdoor still offers a further page → Platform_Status `PAGE_LIMIT_REACHED`, which marks
   the result a Partial_Result, because this Platform's result list was not read to its end;
4. the page ended the retrieval (sign-in, bot check, rate limit, unreadable layout, unreachable Platform) → the matching
   Platform_Status, with the postings read so far kept.

With the cap at 1, case 3 is the one a successful Glassdoor retrieval reaches: the captured page always offers a further
Result_Page through its `load-more` control, so `PAGE_LIMIT_REACHED` and the Partial_Result marking are the ordinary
outcome rather than the exception. Case 1 is reachable only for a result list short enough to show no such control, and
case 2 for a search that matched nothing.

### Glassdoor ignores the `page` parameter, and what that costs

A second capture with `&page=2` landed on the **same** canonical URL, with no `page` and no `_IP2` path segment, and 23
of its 30 job identifiers were ones page 1 had already served. Glassdoor does not paginate this result list through a
parameter at all: the captured page ends in `<button data-test="load-more">Mehr Jobs anzeigen</button>` and loads the
next block itself.

Said plainly, because the consequence was a real one: with the full budget of ten, the adapter read the first block of
results and then read it again, up to the limit of ten Result_Page, and reported `PAGE_LIMIT_REACHED` at the end because
the `load-more` control keeps claiming a further page. Correctness held throughout — the upsert of 9.4 is keyed on
`(platform, postingId)`, so re-reading the same block updates rows instead of inserting duplicates — but **up to nine of
the ten page requests of a Glassdoor retrieval were spent on results already read**, each one still paying the 2-second
gap.

> **Superseded.** The one-page cap described below was replaced by reading the `load-more` control (13.12,
> `GLASSDOOR_LOAD_MORE_SELECTOR`), so this Platform's result list is now walked to its end. The capture and the
> reasoning are kept because they are what established that the `page` parameter is ignored by this Platform.

**The mitigation was in force between tasks 25.2 and 13.12.** `GLASSDOOR_RESULT_PAGE_LIMIT` in
`packages/scrapers/src/adapters/glassdoor/result-list-url.ts` is 1, and `effectivePageBudget` in the adapter caps the
walk at it however large a budget the Scraper_Service hands in. A Glassdoor retrieval now sends exactly one page request
per Scrape_Run and reads exactly the block the Platform actually serves. `PAGE_LIMIT_REACHED` is therefore the ordinary
end of a _successful_ Glassdoor retrieval, which makes its result a Partial_Result (7.7) — truthfully, because the
result list is in fact not read to its end. The constant has the same shape as `INDEED_RESULT_PAGE_LIMIT`, for the
related reason that the Platform leaves the Job_Tool no usable way to address a second Result_Page.

The `page` parameter is nevertheless kept, and the URL builder still produces `&page=2` on request. It is the convention
every Platform_Adapter of this repository follows, the fixture-mode retrieval runtime reads it (`requestedPageNumber` in
`apps/api/src/scraper/fixture-retrieval.runtime.ts`), and
`apps/api/src/scraper/__tests__/fixture-retrieval.runtime.test.ts` asserts it for every registered adapter. Reading the
"Mehr Jobs anzeigen" control is the real fix — it is what would actually retrieve the second block — and it needs a
decision about that convention, so it remains recorded here as an observation rather than silently patched. The cap is
the cheap mitigation and not the fix: Glassdoor contributes the first block of the result list and no more.

## Respected waiting time

**At least 2 seconds between two page requests to Glassdoor**, measured between the settling of the previous attempt and
the start of the next, and enforced by the `PlatformQueue` the adapter's page runs through, not by the adapter itself:
it contains no sleep, no retry counter and no timeout.

| Bound                                 | Value                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Minimum gap between two page requests | 2000 ms (`MIN_REQUEST_GAP_MS`)                                                                              |
| Stated `Crawl-delay` in robots.txt    | respected when longer: `max(2000 ms, crawlDelaySeconds × 1000)`                                             |
| In-flight page requests per Platform  | exactly 1                                                                                                   |
| Attempts per Result_Page              | at most 3 (`MAX_REQUEST_ATTEMPTS`) — the original request plus two repetitions, with an increasing interval |
| Time limit per Result_Page            | 30 000 ms (`RESULT_PAGE_TIMEOUT_MS`); exceeding it counts as one failed attempt                             |
| robots.txt retrieval budget           | 10 000 ms (`ROBOTS_FETCH_TIMEOUT_MS`); exceeding it means the Platform is skipped                           |

A robots.txt that states a shorter crawl delay than 2 seconds, or none at all, does not shorten the gap. 2 seconds is
the floor, and the robots.txt read on 2026-10-29 stated no crawl delay at all, so 2 seconds is what currently applies.

## Identification

Every request to Glassdoor — the robots.txt retrieval and every page request alike — carries the same unchanged user
agent, built once from the `USER_AGENT_CONTACT` value of the local environment file:

```text
JobTool/0.1 (private use; contact: <USER_AGENT_CONTACT>)
```

It names the tool, states the private purpose of use and carries a reachable contact detail, and it contains none of the
tokens that would make it readable as a common browser. Without a usable contact detail the Job_Tool sends no request at
all; the API_Service reports that at startup.

That is the user agent the successful capture carried, and it is worth stating next to the risk note: this Platform
served a full result list to a client that identified itself as a tool. It is also why there is no per-adapter user
agent to tune here — imitating a browser is forbidden by 14.5, so a block remains an accepted outcome.

## robots.txt

`https://www.glassdoor.de/robots.txt` is retrieved once per Platform and Scrape_Run, before the first page request, and
the decision is reused for the rest of that run. It gates the retrieval:

- a disallowed intended path → Platform_Status `EXCLUDED_BY_ROBOTS_TXT`; no page request is sent, no Job_Posting of
  Glassdoor is stored, and the remaining Platform_Adapter keep running;
- not retrievable within 10 seconds, or unevaluable → Platform_Status `ROBOTS_TXT_UNAVAILABLE`, and Glassdoor is skipped
  for that run;
- a stated `Crawl-delay` longer than 2 seconds is applied as the gap between page requests.

**The robots.txt of `www.glassdoor.de` was read on 2026-10-29**, by the capture's own gate rather than by hand: it
permitted `/Job/jobs.htm` with the query above and stated no crawl delay for this user agent. That is a dated
observation of one file, not a standing permission — the decision is re-evaluated on every Scrape_Run, so a change on
Glassdoor's side takes effect by itself. No bypass exists, and the fixture capture script runs the same gate before its
single request, because a capture is a request like any other.

## Terms-of-use review

**Date of the last review of the terms of use: not yet performed.**

Acceptance criterion 14.7 asks for this date in ISO 8601 format, and writing one here would be a fiction: nobody has
read Glassdoor's terms of use for this project. What _has_ been reviewed is dated below, and the distinction is the
point — a robots.txt that permits a path and a Platform that serves a result list are technical observations, not
statements of terms, and neither is a legal conclusion.

| Field                                                   | Value                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Last terms-of-use review                                | — (not performed)                                                                    |
| Reviewed by                                             | —                                                                                    |
| Reviewed document                                       | —                                                                                    |
| Last robots.txt review                                  | 2026-10-29 — `https://www.glassdoor.de/robots.txt`, path permitted, no `Crawl-delay` |
| Last review of the retrieval scope against the Platform | 2026-10-29 — one Result_Page retrieved, HTTP 200, 30 readable Job_Posting            |

What has to happen before the Job_Tool performs a regular retrieval of Glassdoor:

1. read the terms of use currently published by Glassdoor and decide whether the retrieval described in
   [Retrieval scope](#retrieval-scope) is defensible for private single-user use;
2. record the date of that reading in this table as `YYYY-MM-DD`, together with who read it and which document version;
3. re-do it whenever the adapter's retrieval scope changes, and on every fixture re-capture.

Two points the review should weigh, both from the capture rather than from an assumption. The single observed response
was an HTTP 200 to an honestly identified tool, so this Platform did not refuse the request the way jobvector.de did.
And the retrieval reads a **wider** result list than the Search_Profile states, because the Platform drops the location
and the radius — a nationwide read is a larger ask of a Platform than a city-sized one, and it was not chosen.

This document is not legal advice. The technical constraints — robots.txt, 2 seconds, 10 pages, no sign-in, no Captcha,
one request at a time — reduce the risk; they do not replace the review.

## Deactivating the Platform in the source code

Every Platform is marked activated or deactivated in the source code (4.6), and the mark is one entry of
`PLATFORM_ACTIVATION` in `packages/domain/src/search-profile/constants.ts`:

```ts
export const PLATFORM_ACTIVATION: Readonly<Record<Platform, boolean>> = {
  STEPSTONE: true,
  JOBVECTOR: true,
  INDEED: true,
  GLASSDOOR: true, // set to false to switch this Platform off
};
```

**Glassdoor is currently `true`.** Setting it to `false` and restarting the API_Service means the Platform reports the
Platform_Status `DISABLED` instead of being queried (4.7): the Scraper_Service executes no request for it, delivers no
Job_Posting, and carries `DISABLED` in the result of the Scrape_Run. It is not an error state — a deactivated Platform
is a decision somebody took in the source code — so the remaining Platform_Adapter are unaffected, and the Job_Posting
of earlier Scrape_Run stay in the Posting_Store and stay visible.

What the user sees, and in which surface:

| Surface                        | What it shows                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Log_View, at API_Service start | `platform.disabled`: `Plattform Glassdoor ist im Quellcode deaktiviert und wird in einem Suchlauf nicht abgefragt.`                   |
| Log_View, per Scrape_Run       | the same German sentence, written once at the start of the run, at level `INFO`                                                       |
| Result of a Scrape_Run         | Platform_Status `DISABLED`, labelled `im Quellcode deaktiviert` (`PLATFORM_STATUS_LABELS_DE`, on the wire as `platformStatusLabelDe`) |
| Read-only criteria view        | the Platform with that Platform_Status, an empty criteria list, and the same German sentence as `configurationHintDe`                 |

**This is the escape hatch for this Platform, and the reason it is documented here rather than only in the
conventions.** The design's risk note expects Glassdoor's bot protection to refuse an honestly identified tool; the
capture of 2026-10-29 shows it does not have to, but one request settles nothing about the next. Reach for the flag when
Glassdoor starts answering a Scrape_Run with `PLATFORM_BLOCKED` or `SIGN_IN_REQUIRED` run after run: a deactivated
Platform reports one calm German sentence per run, whereas an activated and blocked one pays a page request, a browser
page and a warning line for a result it will not get. A single blocked run is not a reason — the Platform_Status already
says what happened, and the remaining Platform are not held up by it.

Deactivating is a two-line change with no migration: edit the constant, then restart the API_Service, because
`PlatformConfigurationService` resolves the configuration once in its constructor and holds it for the process lifetime.
Reactivating is the same edit in reverse. Note that a deactivated Platform is still **registered**: its adapter, its
fixtures and its tests keep working, so the flag switches off the retrieval and nothing else.

## Provisional parameters

The capture settled three of the four uncertainties the URL builder was written with, and the file comment in
`result-list-url.ts` records each one in full. What remains open is listed as open:

| Part                                | Status                                                                                                                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/Job/jobs.htm` path                | **confirmed** — answered HTTP 200 and a result list                                                                                                                                                                                                               |
| `sc.keyword`                        | **confirmed** — the only parameter that survives the rewrite                                                                                                                                                                                                      |
| The `OR` keyword expression         | **confirmed as read literally**: one 142-character keyword, not an `OR` of quoted terms. Kept, because it is returning readable Job_Posting; whether a shorter term list retrieves _more relevant_ postings is a tuning question for the Search_Profile constants |
| `locKeyword`                        | **not honoured** — dropped by the Platform. Which parameter, if any, can state a place without a second request to the Platform is open                                                                                                                           |
| `radius`                            | **moot while the location is dropped**: a radius without a centre has nothing to measure. The unit therefore stays unconfirmed                                                                                                                                    |
| Radius steps `10, 25, 50, 100, 200` | **provisional**, read from Glassdoor's own radius selector and never exercised, since the parameter is dropped                                                                                                                                                    |
| `page`                              | **ignored by the Platform** — see [the pagination section](#glassdoor-ignores-the-page-parameter-and-what-that-costs)                                                                                                                                             |

A dropped parameter degrades in one direction only: the retrieval reads a wider result list than the Search_Profile
asked for, which the Commute_Service and the Relevance_Service then rate. A wrong _path_ would not degrade, and the path
is confirmed.

When a later capture corrects any of this, update `result-list-url.ts`, the [At a glance](#at-a-glance) and
[Source URL](#source-url-of-the-retrieved-result-list) sections here, and the review dates.

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
   a challenge page's text says nothing about the search. Detected and reported, never answered;
3. **sign-in** — the URL the load ended on matching `SIGN_IN_PATH_FRAGMENTS`, or a covering overlay from
   `SIGN_IN_OVERLAY_SELECTORS` → `SIGN_IN_REQUIRED`;
4. **rate limit stated in the page body** (`RATE_LIMIT_PHRASES`) → `RATE_LIMITED`;
5. **the job cards** — at least one posting carrying title, source URL and Posting_Id makes the page a result list →
   `POSTINGS`;
6. **with no readable posting** — an explicit "nothing matched" marker or phrase → `EMPTY_RESULT_LIST`; a long-form
   sign-in prompt → `SIGN_IN_REQUIRED`; anything else → `LAYOUT_UNKNOWN`.

The adapter takes a page's postings over **before** it looks at the classification, which is what keeps the
Partial_Result of 7.7: a sign-in wall or a bot check can sit above a readable part of the list, and for this Platform
that is the likely case rather than the exotic one.

One honest limit of step 6: a result list that is empty _because_ the Platform decided not to serve one to this client
is indistinguishable, in the markup, from a search that legitimately matched nothing. The reader reports what the page
says and does not guess at a block it cannot see.

### Selector tables

All selector tables are ordered candidate lists — the first selector that matches anything wins — so a layout change is
repaired by putting the new selector in front rather than by rewriting the parser. The `data-test` attributes lead every
table on purpose: Glassdoor renders its cards with CSS-module class names carrying a build hash
(`JobsList_jobListItem__wjTHv`), which changes with every deployment, while `data-test` is what its own test suite
selects on. The class-based candidates behind them are matched by prefix for the same reason.

| Table                                                                      | Purpose                                                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `CARD_SELECTORS`                                                           | the job cards of a Result_Page                                                                                                             |
| `FIELD_SELECTORS`                                                          | title, link, employer, work location, publication date, description inside one card                                                        |
| `POSTING_ID_ATTRIBUTES`                                                    | card attributes carrying the Posting_Id (`data-jobid`, `data-job-id`, `data-id`, `data-joblistingid`, `id`)                                |
| `POSTING_ID_QUERY_PARAMS`                                                  | the identifier parameters of an advertisement URL (`jobListingId`, `joblistingid`, `jl`, `jobId`)                                          |
| `NEXT_PAGE_SELECTORS`                                                      | "there is a further Result_Page", including the `load-more` button; a disabled control and an anchor without `href` count as the last page |
| `EMPTY_RESULT_SELECTORS` / `EMPTY_RESULT_PHRASES`                          | Glassdoor stating that the search matched nothing                                                                                          |
| `SIGN_IN_PATH_FRAGMENTS` / `SIGN_IN_OVERLAY_SELECTORS` / `SIGN_IN_PHRASES` | the three characteristics of a sign-in wall                                                                                                |
| `BOT_CHECK_SELECTORS` / `BOT_CHECK_PHRASES`                                | a Captcha or bot check page                                                                                                                |
| `RATE_LIMIT_PHRASES` / `RATE_LIMIT_HEADERS` / `REMAINING_QUOTA_HEADERS`    | a reported fetch rate                                                                                                                      |
| `TRACKING_QUERY_PARAMS`                                                    | per-click parameters stripped from a posting's source URL                                                                                  |

**What the captured page confirmed, corrected and left unexercised:**

- `[data-test="jobListing"]`, the first card candidate, matched all 30 cards, and each carries `data-jobid`, so no
  posting of that page depended on parsing an identifier out of a URL.
- `job-title`, `emp-location`, `descSnippet` and `job-age` each matched on their first candidate, on every card.
- **The employer is read by the third candidate.** Glassdoor renders no `[data-test="emp-name"]`; the name sits in
  `[class*="EmployerProfile_compactEmployerName"]`. The ordered candidate list doing exactly what it is for, and the
  `data-test` candidates stay in front as the more stable shape should Glassdoor reintroduce one.
- **The link candidate order was wrong, and the capture is what showed it.** Glassdoor renders two anchors per card: the
  title anchor, whose `href` is the advertisement, and an empty overlay anchor `[data-test="job-link"]`, whose `href` is
  `/partner/jobListing.htm` plus nothing but per-impression click parameters. Reading the overlay anchor first gave all
  30 postings the same unopenable source URL and no Posting_Id. The title anchor now leads.
- **The page carries no microdata at all** — no `itemtype`, no `itemprop`, no `datetime` attribute anywhere. Every
  schema.org candidate in the tables went unmatched, and so did the whole machine-readable date path. They are kept as
  fallbacks and are exercised only by the hand-authored `relative-dates` fixture. This is the clearest structural
  difference to Jobvector, whose selector tables lead with microdata because that Platform publishes it.

A selector set that no longer matches does not produce wrong data: a Result_Page yielding no readable Job_Posting is
reported as `LAYOUT_UNKNOWN`, which is the `PAGE_LAYOUT_UNKNOWN` of 6.7.

The Posting_Id is taken from a card attribute where present, otherwise from the advertisement URL, in two shapes and in
this order: an allow-listed identifier parameter (`?jl=1009123456789`), then the last sufficiently long digit run of the
path that is **not** preceded by a letter. That letter boundary is specific to this Platform: a Glassdoor advertisement
path carries tokens such as `JV_IC2610266_KO0,36_KE37,42`, whose numbers are a city identifier and two text offsets
shared by every posting of that city. Reading one of those as the Posting_Id would give many Job_Posting the same
identifier, and the upsert of 9.4 would overwrite one posting with another.

### Publication dates: a compact day count

**Glassdoor states a publication date as `2T`, `10T`, `30T+` and nothing else** — 14 of the 30 captured cards read
`30T+`. There is no `datetime` attribute to fall back on, so for this Platform the date is that string or nothing.

That wording is not part of the German relative vocabulary the shared normalization layer was written for ("vor 3
Tagen", "heute", "gestern", plus ISO values). At the time of writing, a Glassdoor posting therefore takes the 6.9 path:
the publication date is marked as empty, the `posting.publicationDateUnparsable` note is written to the Log_Stream, and
the Job_Posting is kept and shown with the German "Datum unbekannt" line.

**Task 23.3 is adding the compact day count to `packages/scrapers/src/normalize/parse-publication-date.ts`**, and that
is the intended end state: `2T` resolves to the Scrape_Run start minus 2 days, `30T+` to the start minus 30 days — the
most recent day the statement allows, which is the same convention the existing "vor mehr als 30 Tagen" wording follows
and the one that cannot overstate a posting's age. Read that file for the state that actually shipped; it is the single
place the wording lives, and this document is not a second copy of it.

Two things hold either way, which is why neither the fixtures nor this adapter changed for it. The parsing is in the
**shared** normalization layer, not per adapter, so the wording benefits any Platform that invents the same shape. And
the fixtures store the raw card text, so adding the wording needs no re-capture.

## German Log_Stream lines

The adapter writes the progress of a running Scrape_Run line by line. The German text is the user-facing Log_View
wording; the English `code` is the stable key tests and the API_Service error mapping read. The codes are the same ones
the Stepstone and Jobvector adapters write, because they identify the _observation_ and not the Platform — the Platform
travels in the Log_Stream entry and is named in the German sentence. Per the language convention, documentation and
identifiers are English and only the Log_Stream text, the Web_App strings and the Relevance_Reason are German.

| Code                          | Level | German text                                                                                                                                                                          |
| ----------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform.pageFetched`        | INFO  | `Glassdoor: Seite <n> gelesen, <m> Treffer gefunden.`                                                                                                                                |
| `platform.noResults`          | INFO  | `Glassdoor: keine Treffer für die aktuellen Suchkriterien.`                                                                                                                          |
| `platform.resultListComplete` | INFO  | `Glassdoor: Ergebnisliste vollständig gelesen, <n> Seiten mit <m> Treffern.`                                                                                                         |
| `platform.pageLimit`          | INFO  | `Glassdoor: Seitenlimit erreicht, es wurden <n> Ergebnisseiten gelesen.`                                                                                                             |
| `platform.signInRequired`     | WARN  | `Glassdoor zeigt Ergebnisse nur nach Anmeldung. Der Abruf dieser Plattform wurde beendet und in diesem Suchlauf nicht wiederholt; die Trefferliste ist für Glassdoor unvollständig.` |
| `platform.blocked`            | WARN  | `Glassdoor hat den automatischen Abruf blockiert. Die Sicherheitsabfrage wurde nicht beantwortet und der Abruf dieser Plattform in diesem Suchlauf nicht wiederholt.`                |
| `platform.rateLimited`        | WARN  | `Glassdoor hat die Abfragerate begrenzt. Der Abruf dieser Plattform wurde beendet.`                                                                                                  |
| `platform.layoutUnknown`      | ERROR | `Der Seitenaufbau von Glassdoor hat sich geändert; es konnten keine Treffer gelesen werden.`                                                                                         |
| `platform.unreachable`        | ERROR | `Glassdoor war nicht erreichbar. Bitte den Suchlauf später wiederholen.`                                                                                                             |
| `page.failed`                 | ERROR | `Glassdoor hat auf Seite <n> nicht geantwortet. Treffer bis zu dieser Seite wurden gespeichert.`                                                                                     |

The last row is the fallback for a Platform_Status without its own sentence, which is what an exhausted attempt series
reports.

Two of these sentences say more than their Stepstone counterparts, deliberately: the design accepts `PLATFORM_BLOCKED`
and `SIGN_IN_REQUIRED` as a normal outcome for Glassdoor, so the single non-technical user reading the Log_View is told
that the Job_Tool stopped asking on purpose (7.8) rather than that something is broken. The German sentence for a
deactivated Platform is not in this table, because it belongs to the API_Service rather than to the adapter; it is in
[Deactivating the Platform](#deactivating-the-platform-in-the-source-code).

## Ending a retrieval

Every end the adapter can observe is a result, not an exception. A sign-in wall, a bot check, an unreadable layout, a
reported fetch rate and the page limit all return the Job_Posting read so far together with one Platform_Status; a
thrown error would take the postings with it, and for this Platform the postings read before a block are frequently the
only ones there will be. The error classes are still used as the single place pairing an observation with its
Platform_Status and its log code — they are constructed and reported, not thrown.

No further attempt follows in the same Scrape_Run (7.8), and that holds in three layers rather than by a counter in the
adapter: the page loop returns on every outcome other than `POSTINGS`, so no further Result_Page URL is built; the
Scraper_Service closes this Platform's page source in its `finally`, which closes its `PlatformQueue` permanently, so a
later request rejects without its task running; and the Scraper_Service calls `fetch` exactly once per Platform and
Scrape_Run.

The one exception is cancellation: an aborted Scrape_Run rejects, because only the Scraper_Service knows whether the
user cancelled or the runtime deadline struck.

A sign-in prompt and a bot check are recognised from a page that has already loaded, and the adapter returns from that
observation without a further page request. The remaining work is parsing and closing the page, so the 5-second bound on
ending a Platform's retrieval holds by construction rather than by a timer.

## Fixtures and the refresh loop

**One fixture of this Platform is a real capture; the other seven are hand-authored.** The sidecar
`<case>.capture.json`, not the presence of an HTML file, is what dates a fixture, and
`packages/scrapers/src/adapters/glassdoor/__fixtures__/README.md` carries the provenance of every case plus the full
account of what the capture established.

| Observation                | Detail                                                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture performed          | 2026-10-29T12:33:00.219Z, by task 23.2, one Result_Page                                                                                                  |
| Response from glassdoor.de | **HTTP 200**, 30 readable Job_Posting                                                                                                                    |
| User agent                 | the unchanged Job_Tool identification of 14.5                                                                                                            |
| robots.txt gate            | evaluated first; path permitted, no `Crawl-delay`                                                                                                        |
| Stored as                  | `result-list-page-1.html`, provenance `CAPTURED`                                                                                                         |
| Sanitization               | 122 scripts, 56 styles and 2 tracking elements removed; the parameters `cpc`, `guid`, `jobListingId`, `jrtk` stripped; 892,054 bytes raw, 236,611 stored |

The design's Risk 1 — Glassdoor answers an honestly identified tool with a Captcha, a sign-in wall or an empty list —
did not materialise on that request. It establishes nothing about the next one, which is why the `sign-in-wall` and
`captcha` fixtures exist at all: those outcomes stay the realistic ones for this Platform (7.2, 7.6).

### Capturing

```bash
pnpm fixtures:capture --platform glassdoor [--case <name>] [--page <n>] [--url <url>] [--out <dir>] [--force]
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

| File                                                       | Content                                                                                                                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/glassdoor/__fixtures__/<case>.html`          | the stored document, byte-identical afterwards (`__fixtures__` is in `.prettierignore`)                                                                     |
| `src/adapters/glassdoor/__fixtures__/<case>.expected.json` | the expected reading: `provenance`, response status and headers, parser outcome, Platform_Status, `hasNextPage`, `readablePostingCount`, every raw posting  |
| `src/adapters/glassdoor/__fixtures__/<case>.capture.json`  | the sidecar of a captured document: `capturedAt`, page number, requested and final URL, HTTP status, user agent, byte counts, what the sanitization removed |

The metadata sits beside the HTML rather than in a header comment, so a reviewer sees the capture date in the diff
without the page itself being edited.

### Expected cases

The eight cases the parser tests cover (`REQUIRED_FIXTURE_CASES`):

`result-list-page-1`, `result-list-page-2`, `result-list-empty`, `layout-changed`, `sign-in-wall`, `captcha`,
`rate-limited`, `relative-dates`.

Only the first is a capture. The rest are hand-authored and say so in their `provenance`, for reasons that are specific
per case and worth knowing before trusting one:

- `result-list-page-2` is hand-authored **as a last page** — no `load-more` control, so it reports `COMPLETED`.
  Glassdoor serves no second page for this URL shape at all, so this fixture is the shape the parser tests and the
  fixture-mode E2E run need, not a shape the Platform served.
- `result-list-empty` could not be captured because the search matched 30 postings.
- `layout-changed`, `sign-in-wall`, `captcha` and `rate-limited` are written from Glassdoor's documented and observable
  behaviour — the `HardsellOverlay` element of its own sign-in wall, the `px-captcha` container of its bot protection, a
  `429` with `Retry-After`. They pin the **behaviour of the parser**: which characteristic of a page wins, which
  Platform_Status it produces, and that a Captcha is detected and never answered. They do not claim that Glassdoor
  renders this exact markup.
- `relative-dates` carries the compact day count the captured page showed plus the ISO and German relative shapes the
  normalization layer supports, so 6.4 and 6.8 are pinned across all of them.

### Refresh loop

When a real Scrape_Run or an opt-in live smoke test reports `PAGE_LAYOUT_UNKNOWN`:

1. re-capture the affected cases with `pnpm fixtures:capture --platform glassdoor --case <name> --force`;
2. put the new selector in front of its candidate list in `parse-result-list.ts`;
3. regenerate the expected JSON and review that diff rather than overwriting it blindly;
4. update this file — the selector status, the URL if it changed, and the review dates.

## Source files

| File                                                              | What it holds                                                                                                                                                         |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/scrapers/src/adapters/glassdoor/index.ts`               | the page loop, the page budget, the return-rather-than-throw rule                                                                                                     |
| `packages/scrapers/src/adapters/glassdoor/result-list-url.ts`     | `GLASSDOOR_ORIGIN`, `glassdoorResultListUrl`, `glassdoorKeywordQuery`, `GLASSDOOR_RADIUS_STEPS_KM`, the query parameter names and what the capture settled about each |
| `packages/scrapers/src/adapters/glassdoor/parse-result-list.ts`   | the selector tables, the `ResultPageOutcome` union, the classification order                                                                                          |
| `packages/scrapers/src/adapters/glassdoor/messages.ts`            | the German Log_Stream lines and their stable English codes                                                                                                            |
| `packages/scrapers/src/adapters/glassdoor/__fixtures__/README.md` | the provenance of every fixture and the full account of the capture                                                                                                   |
| `packages/scrapers/src/adapters/search-criteria.ts`               | reading one Criterion_Field out of an effective Search_Profile                                                                                                        |
| `packages/scrapers/src/normalize/parse-publication-date.ts`       | the publication date vocabulary, including the compact day count of this Platform                                                                                     |
| `packages/scrapers/src/adapter/types.ts`                          | `RESULT_PAGE_BUDGET` (10), `RESULT_PAGE_TIMEOUT_MS` (30 000)                                                                                                          |
| `packages/scrapers/src/scheduling/platform-queue.ts`              | `MIN_REQUEST_GAP_MS` (2000), `MAX_REQUEST_ATTEMPTS` (3)                                                                                                               |
| `packages/scrapers/src/robots/robots.ts`                          | the robots.txt evaluation and `ROBOTS_FETCH_TIMEOUT_MS` (10 000)                                                                                                      |
| `packages/scrapers/src/runtime/user-agent.ts`                     | the user agent of every outgoing request                                                                                                                              |
| `packages/scrapers/src/runtime/browser.ts`                        | the browser context per Platform, `BLOCKED_RESOURCE_TYPES`, the teardown                                                                                              |
| `packages/scrapers/src/fixtures/capture.ts`                       | the capture flow and its refusals                                                                                                                                     |
| `packages/scrapers/src/fixtures/fixture-paths.ts`                 | the fixture layout and `REQUIRED_FIXTURE_CASES`                                                                                                                       |
| `packages/scrapers/src/registry.ts`                               | the registration of this adapter                                                                                                                                      |
| `packages/domain/src/search-profile/capabilities.ts`              | the Glassdoor capability declaration                                                                                                                                  |
| `packages/domain/src/search-profile/constants.ts`                 | the Default_Search_Profile and `PLATFORM_ACTIVATION`                                                                                                                  |
| `apps/api/src/common/error-mapping.ts`                            | `PLATFORM_STATUS_LABELS_DE`, including the `DISABLED` label                                                                                                           |
| `apps/api/src/platform-config/platform-config.messages.ts`        | `platformDisabledMessageDe` and the German Platform names                                                                                                             |
