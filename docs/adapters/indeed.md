# Indeed Platform_Adapter

The etiquette and operating document of the Indeed Platform_Adapter, required by acceptance criterion 14.7: one
documentation file per Platform_Adapter naming the source URL of the retrieved result list, the retrieval scope with the
retrieved paths, the maximum number of pages per Scrape_Run, the respected waiting time and the date of the last review
of the terms of use in ISO 8601 format.

This file is written from the adapter source. Every number and every path below is traceable to a named constant; the
section [Source files](#source-files) lists where each one lives. Where the source itself marks a value as unconfirmed,
this document says so rather than presenting it as settled — see [Provisional parameters](#provisional-parameters). It
is the précis of two longer texts and not a second version of them: the file comment of
`packages/scrapers/src/adapters/indeed/result-list-url.ts` carries the retrieval-scope reasoning in full, and
`packages/scrapers/src/adapters/indeed/__fixtures__/README.md` carries the provenance of every stored document.

Two facts decide most of the sections below, and both are stated plainly rather than softened.

**The retrieval scope of this Platform_Adapter is decided by a robots.txt, not by what Indeed's search form offers.**
The `User-agent: *` group of `https://de.indeed.com/robots.txt`, read on 2026-10-29, forbids `radius=` and `&start=`. So
this adapter states no search radius and reads exactly **one** Result_Page per Scrape_Run, because `start` is Indeed's
only pagination parameter. See [robots.txt](#robotstxt) and
[Maximum pages per Scrape_Run](#maximum-pages-per-scrape_run).

**The Indeed Platform_Adapter contributes no Job_Posting, and since task 25.2 it is not even asked.** On 2026-10-29 the
capture was answered with HTTP 403 and a Cloudflare security check ("Additional Verification Required"). Since task 24.3
the URL is one the robots.txt permits, so a Scrape_Run reached the Platform instead of stopping at the gate — and was
answered with that challenge, which the Job_Tool detects, reports as Platform_Status `PLATFORM_BLOCKED` and never
answers (7.6, 7.8). That is the design's Risk 1 materialising and the accepted outcome, not a defect.
`PLATFORM_ACTIVATION.INDEED` is therefore `false`: a request, a browser page and a `PLATFORM_BLOCKED` warning on every
single run are a price paid for nothing, and a predictable warning is the fastest way to teach a user to ignore the
Log_View. Recovery is detected by running the opt-in live smoke suite, not by paying for a 403. See
[Fixtures and the refresh loop](#fixtures-and-the-refresh-loop) and
[Deactivating the Platform](#deactivating-the-platform-in-the-source-code).

## At a glance

| Item                                   | Value                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------- |
| Platform                               | `INDEED`                                                                   |
| Activation in the source code          | **deactivated** (`PLATFORM_ACTIVATION.INDEED` is `false`), since task 25.2 |
| Origin                                 | `https://de.indeed.com`                                                    |
| Result list path shape                 | `/jobs` with every criterion in the query string                           |
| Maximum pages per Scrape_Run           | **1** (`INDEED_RESULT_PAGE_LIMIT`), below the 10 of `RESULT_PAGE_BUDGET`   |
| Search radius                          | none; `Disallow: /*radius=` forbids a URL that states one                  |
| Minimum gap between requests           | 2 s (`MIN_REQUEST_GAP_MS`); no `Crawl-delay` is stated for this user agent |
| Attempts per Result_Page               | at most 3 (`MAX_REQUEST_ATTEMPTS`)                                         |
| Time limit per Result_Page             | 30 s (`RESULT_PAGE_TIMEOUT_MS`)                                            |
| Sign-in                                | never; no credentials are supplied and no storage state is reused          |
| Last terms-of-use review               | not yet performed — see [Terms-of-use review](#terms-of-use-review)        |
| Last robots.txt review                 | 2026-10-29, result list permitted, `radius=` and `&start=` forbidden       |
| Last capture against the live Platform | 2026-10-29, **HTTP 403** with a Cloudflare security check, no Result_Page  |
| Job_Posting this Platform delivers     | none, for as long as the Platform answers that challenge                   |

## Source URL of the retrieved result list

The result list URL is built from the effective Search_Profile of Indeed, never hand-written. Indeed has no
Platform_Override, so every value comes from the Default_Search_Profile currently in the source code (`jobTitle`
"Projektmanagerin", six title synonyms, `searchLocation` "München", `employmentType` `PERMANENT`,
`publicationPeriodDays` 30). The Result_Page is:

```text
https://de.indeed.com/jobs?q=%22Projektmanagerin%22+OR+%22Projektmanager%22+OR+%22Project+Manager%22+OR+%22Projektleiterin%22+OR+%22Projektleiter%22+OR+%22Project+Lead%22+OR+%22Teilprojektleiterin%22&l=M%C3%BCnchen&fromage=30&jt=permanent
```

That is the URL the probes of 2026-10-29 sent, byte for byte (`__fixtures__/captcha.capture.json`, `requestUrl`), and
the one the 403 answered.

There is no second Result_Page URL a retrieval of this Platform requests. The builder still produces one for any page
number — the same URL with `&page=<n>` appended, so the Scraper_Service can evaluate all ten intended paths of 13.3
against the robots.txt before the first request — but the adapter never asks for it:

```text
https://de.indeed.com/jobs?q=…&l=M%C3%BCnchen&fromage=30&jt=permanent&page=2
```

`page` is the repository-wide convention — the Result_Page number as the `page` query parameter, omitted for the first
page — and Indeed itself ignores it. It is kept because it is load-bearing elsewhere: `requestedPageNumber` in
`apps/api/src/scraper/fixture-retrieval.runtime.ts` recovers the page number from that parameter alone, and
`apps/api/src/scraper/__tests__/fixture-retrieval.runtime.test.ts` asserts the convention against every registered
adapter. The robots.txt says nothing about `page`, so the convention costs one parameter the Platform disregards.

The URL is a deterministic function of the profile and the page number, including the order of the query parameters
(`q`, `l`, `fromage`, `jt`, `page`). That is what lets the robots.txt evaluation run against `resultListUrl(profile, n)`
and lets a fixture test compare URLs literally.

### How a Criterion_Field reaches the URL

Indeed's capability declaration supports five Criterion_Field, and all five are mapped — a supported field that silently
never reached the query would make the read-only criteria view claim a filter the retrieval never applied.

| Criterion_Field              | Where it goes | Mapping                                                                                                                          |
| ---------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `jobTitle` (mandatory)       | `q`           | first term of the keyword expression, quoted                                                                                     |
| `titleSynonyms`              | `q`           | job title first, then the synonyms, each quoted and joined with `OR`; duplicates dropped case-insensitively, blank terms dropped |
| `searchLocation` (mandatory) | `l`           | the value with inner whitespace collapsed                                                                                        |
| `publicationPeriodDays`      | `fromage`     | raised to the next larger bucket of `1, 3, 7, 14, 30` (`INDEED_AGE_BUCKETS_DAYS`); a period above 30 days omits the parameter    |
| `employmentType`             | `jt`          | `PERMANENT` → `permanent`, `TEMPORARY` → `temporary`, `CONTRACT` → `contract` (`INDEED_JOB_TYPES`); `ANY` omits the parameter    |

Two Criterion_Field are absent from that table, for different reasons. `industry` is absent because Indeed's result list
has no industry filter at all. **`searchRadiusKm` is absent because the robots.txt forbids it** — Indeed does offer a
radius selector, and task 24.3 removed the field from Indeed's `supportedFields` in `PLATFORM_CAPABILITIES` together
with the parameter, because rule 2 of the capability conventions requires every declared Criterion_Field to actually
reach the URL and 4.11 must not claim a filter the retrieval never applied. The commented-out
`INDEED: { searchRadiusKm: 50 }` entry in the Platform_Override constants is a demonstration of 4.5: uncommenting it is
a compile error.

A bare `l=München` without a radius is whatever Indeed makes of a place, which is **wider** than the profile asks for
rather than narrower — the same situation Glassdoor is in. The Commute_Service rates the work locations afterwards (8.1)
and the Relevance_Service judges them (15.2), so the widening costs requests and assessments, not correctness.

The `fromage` rounding goes upward, never downward: a shorter age window would drop Job_Posting the user asked for,
while a longer one only adds postings the Commute_Service and the Relevance_Service then rate. A period above the
largest bucket drops the filter entirely, because "and older as well" is what no filter means. 30 is a bucket although
Indeed's visible date filter offers only 1, 3, 7 and 14 days — the shipped Default_Search_Profile asks for 30 days, and
a bucket list ending at 14 would drop the parameter for exactly that profile.

Building the URL fails with a `RangeError` for a page number that is not a positive integer and for a Search_Profile
missing either of the two mandatory Criterion_Field of Indeed.

## Retrieval scope

### Retrieved paths

Exactly one path family, on one origin, and exactly one page of it:

| What          | Path                               | When                                            |
| ------------- | ---------------------------------- | ----------------------------------------------- |
| robots.txt    | `https://de.indeed.com/robots.txt` | once per Platform and Scrape_Run, before page 1 |
| Result_Page 1 | `/jobs?q=…&l=…&fromage=…&jt=…`     | always, if robots.txt permits it                |

`de.indeed.com` is the host the robots.txt is read from and the one every page request goes to. There is no row for a
second Result_Page: `Disallow: /*&start=` forbids Indeed's only pagination parameter, so the second page has no address
the Job_Tool may request.

### What is never retrieved

- **No job advertisement detail pages.** The adapter reads result list pages only. The eight fields of the Job_Posting
  are taken from the result cards; a posting's own page is linked, not fetched. `/viewjob?jk=…` is disallowed by the
  robots.txt and is also the advertisement URL stored on a Job_Posting for the user to open in their own browser (6.3) —
  no part of the Job_Tool ever retrieves it, so **no rule is broken**.
- **No URL stating a search radius, and no URL stating an offset.** Both are robots.txt decisions rather than adapter
  preferences; see [robots.txt](#robotstxt).
- **No content behind a sign-in.** The browser context is opened with `storageState: undefined` and no credentials exist
  anywhere in the Job_Tool, so the retrieval structurally cannot sign in. A sign-in redirect or a covering sign-in
  overlay ends this Platform's retrieval.
- **No Captcha or bot check is answered.** A challenge page ends the retrieval. There is no code in this adapter that
  submits a challenge form, reads a challenge token or follows a challenge redirect (7.6). This is the case that
  currently happens on every run.
- **No images, fonts, media or stylesheets.** The request interception drops those four resource types
  (`BLOCKED_RESOURCE_TYPES`), so Indeed serves the document and the scripts only.
- **No service worker**, so a cached response cannot hide what the Platform actually served — including the security
  check the adapter has to detect.
- **No parallel requests to Indeed.** One page request per Platform at a time.

## Maximum pages per Scrape_Run

**One Result_Page per Scrape_Run** (`INDEED_RESULT_PAGE_LIMIT` is 1). That is not a politeness margin below the ten of
13.3 but the only number the Platform's robots.txt leaves: `start` is Indeed's sole pagination parameter and
`Disallow: /*&start=` forbids it, so the second Result_Page has no permitted address.

The adapter still caps `context.pageBudget` at `RESULT_PAGE_BUDGET` and floors it at 0, so the upper bound of 13.3 holds
whatever a caller passes; `INDEED_RESULT_PAGE_LIMIT` is the tighter of the two bounds and the binding one. Pagination
stops on the first of these:

1. the page offered no further Result_Page → Platform_Status `COMPLETED`;
2. the page stated an empty result list → Platform_Status `COMPLETED`;
3. the one page of budget is spent while Indeed still offers a further page → Platform_Status `PAGE_LIMIT_REACHED`;
4. the page ended the retrieval (sign-in, bot check, rate limit, unreadable layout, unreachable Platform) → the matching
   Platform_Status, with the postings read so far kept.

**Case 3 is the normal end of a successful Indeed retrieval, not the exception it is for the other three Platform.** A
result list with more than one page of hits offers a further page, the budget is already spent, and the retrieval
therefore ends with `PAGE_LIMIT_REACHED` — which makes the result a Partial_Result (7.7). That is honest rather than
awkward: the result list was not read to its end, and 7.7 is what says so to the user. The stored fixture
`result-list-page-1` pins it — its expected Platform_Status is `PAGE_LIMIT_REACHED`.

The day Indeed publishes a pagination parameter its robots.txt permits, `INDEED_RESULT_PAGE_LIMIT` is the one constant
that changes.

## Respected waiting time

**At least 2 seconds between two page requests to Indeed**, measured between the settling of the previous attempt and
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

A robots.txt that states a shorter crawl delay than 2 seconds, or none at all, does not shorten the gap (14.4). 2
seconds is the floor, and **the `User-agent: *` group read on 2026-10-29 states no `Crawl-delay` at all** — the stored
copy in `__fixtures__/robots-user-agent-star.txt` is complete and verbatim for that group and contains no such line — so
2 seconds is what applies.

With one Result_Page per retrieval the gap has nothing to pace within a Scrape_Run; it still governs a repeated attempt
after a failed request, which is the one case this Platform currently exercises.

## Identification

Every request to Indeed — the robots.txt retrieval and every page request alike — carries the same unchanged user agent,
built once from the `USER_AGENT_CONTACT` value of the local environment file:

```text
JobTool/0.1 (private use; contact: <USER_AGENT_CONTACT>)
```

It names the tool, states the private purpose of use and carries a reachable contact detail, and it contains none of the
tokens that would make it readable as a common browser. Without a usable contact detail the Job_Tool sends no request at
all; the API_Service reports that at startup.

Two consequences for this Platform specifically. It is the identification that decides **which robots.txt group
applies**: the Job_Tool matches none of the named crawler, bot, preview or scraper groups further down the file, so
`User-agent: *` is the group that governs and there is no second reading of it. And it is the identification the
security check answered with a 403 — imitating a browser is forbidden by 14.5, so there is no per-adapter user agent to
tune here and a block remains an accepted outcome.

## robots.txt

`https://de.indeed.com/robots.txt` is retrieved once per Platform and Scrape_Run, before the first page request, and the
decision is reused for the rest of that run. It gates the retrieval:

- a disallowed intended path → Platform_Status `EXCLUDED_BY_ROBOTS_TXT`; no page request is sent, no Job_Posting of
  Indeed is stored, and the remaining Platform_Adapter keep running;
- not retrievable within 10 seconds, or unevaluable → Platform_Status `ROBOTS_TXT_UNAVAILABLE`, and Indeed is skipped
  for that run;
- a stated `Crawl-delay` longer than 2 seconds is applied as the gap between page requests.

**The `User-agent: *` group was read on 2026-10-29** and is stored verbatim as
`packages/scrapers/src/adapters/indeed/__fixtures__/robots-user-agent-star.txt`. The group opens with `Allow: /` and
then excludes a long list of query shapes. Three of its lines decide this Platform_Adapter:

| Line                  | What it decides                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Disallow: /*radius=` | **Why there is no search radius.** `searchRadiusKm` is therefore not in Indeed's `supportedFields` (14.2)                                                                            |
| `Disallow: /*&start=` | **Why there is one Result_Page.** `start` is Indeed's only pagination parameter, so page 2 has no address                                                                            |
| `Disallow: /viewjob`  | Disallowed, and the Job_Tool never retrieves it: `/viewjob?jk=…` is the advertisement URL stored on a Job_Posting for the user to open in their own browser (6.3). No rule is broken |

Which URLs that makes permitted and forbidden, each checked against the retrieved body with the Job_Tool user agent:

| URL                                           | Decision   | Deciding line         |
| --------------------------------------------- | ---------- | --------------------- |
| `/jobs?q=…&l=München&fromage=30&jt=permanent` | allowed    | `Allow: /`            |
| the same plus `&page=2`                       | allowed    | `Allow: /`            |
| the same plus `&radius=50`                    | disallowed | `Disallow: /*radius=` |
| the same plus `&start=10`                     | disallowed | `Disallow: /*&start=` |
| `/viewjob?jk=<job key>`                       | disallowed | `Disallow: /viewjob`  |

`__tests__/result-list-url.test.ts` evaluates every URL `indeedResultListUrl` builds against those stored rules through
the real robots evaluation, so the retrieval scope of this Platform_Adapter is pinned against the Platform's own
statement rather than against a restatement of it.

Reordering parameters to slip past a rule was considered and rejected. `Disallow: /*&start=` matches only a `start=`
preceded by an `&`, so `?start=10&q=…` would evade the rule as written while asking for exactly the deep pagination the
rule exists to prevent. That is circumventing a robots.txt, not obeying one, and 14.1 and 14.2 are not satisfied by a
technicality. The gate exists to produce this answer, and the answer is one page.

The decision is re-evaluated on every Scrape_Run, so a change on Indeed's side takes effect by itself. No bypass exists.
The fixture capture script runs the same gate before its single request, because a capture is a request like any other —
which is how the first capture attempt of 24.2 came to be refused before it reached the Platform at all.

## Terms-of-use review

**Date of the last review of the terms of use: not yet performed.**

Acceptance criterion 14.7 asks for this date in ISO 8601 format, and writing one here would be a fiction: nobody has
read Indeed's terms of use for this project, and no automated step can substitute for that. What _has_ been reviewed is
dated below, and the distinction is the point — a robots.txt is a technical statement and a 403 is a technical
observation; neither is a statement of terms and neither is a legal conclusion.

| Field                                                   | Value                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Last terms-of-use review                                | — (not performed)                                                                        |
| Reviewed by                                             | —                                                                                        |
| Reviewed document                                       | —                                                                                        |
| Last robots.txt review                                  | 2026-10-29 — `https://de.indeed.com/robots.txt`, `User-agent: *` group, no `Crawl-delay` |
| Last review of the retrieval scope against the Platform | 2026-10-29 — three requests, no Result_Page served, HTTP 403 with a Cloudflare bot check |

What has to happen before the Job_Tool performs a regular retrieval of Indeed:

1. read the terms of use currently published by Indeed and decide whether the retrieval described in
   [Retrieval scope](#retrieval-scope) is defensible for private single-user use;
2. record the date of that reading in this table as `YYYY-MM-DD`, together with who read it and which document version;
3. re-do it whenever the adapter's retrieval scope changes, and on every fixture re-capture.

Two points the review should weigh, both observations rather than assumptions. The Platform refuses this client: the
only responses ever seen from de.indeed.com are a robots.txt and a security check. And the Platform's robots.txt states
restrictions this adapter now follows by construction — no radius, no offset, no advertisement page — which is a
narrower retrieval than the one the other three Platform_Adapter perform.

This document is not legal advice. The technical constraints — robots.txt, 2 seconds, one page, no sign-in, no Captcha,
one request at a time — reduce the risk; they do not replace the review.

## Deactivating the Platform in the source code

Every Platform is marked activated or deactivated in the source code (4.6), and the mark is one entry of
`PLATFORM_ACTIVATION` in `packages/domain/src/search-profile/constants.ts`:

```ts
export const PLATFORM_ACTIVATION: Readonly<Record<Platform, boolean>> = {
  STEPSTONE: true,
  JOBVECTOR: true,
  INDEED: false, // set to true to switch this Platform back on
  GLASSDOOR: true,
};
```

**Indeed is `false` since task 25.2**, so no Scrape_Run queries it. The Platform reports the Platform_Status `DISABLED`
instead of being queried (4.7): the Scraper_Service executes no request for it, delivers no Job_Posting, and carries
`DISABLED` in the result of the Scrape_Run. It is not an error state — a deactivated Platform is a decision somebody
took in the source code — so the remaining Platform_Adapter are unaffected, and the Job_Posting of earlier Scrape_Run
stay in the Posting_Store and stay visible.

What the user sees, and in which surface:

| Surface                        | What it shows                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Log_View, at API_Service start | `platform.disabled`: `Plattform Indeed ist im Quellcode deaktiviert und wird in einem Suchlauf nicht abgefragt.`                      |
| Log_View, per Scrape_Run       | the same German sentence, written once at the start of the run, at level `INFO`                                                       |
| Result of a Scrape_Run         | Platform_Status `DISABLED`, labelled `im Quellcode deaktiviert` (`PLATFORM_STATUS_LABELS_DE`, on the wire as `platformStatusLabelDe`) |
| Read-only criteria view        | the Platform with that Platform_Status, an empty criteria list, and the same German sentence as `configurationHintDe`                 |

**Why the switch was thrown, and what the counter-argument was.** An activated and blocked Indeed pays a robots.txt
retrieval, a page request, a browser page and a `PLATFORM_BLOCKED` warning line per run for a result it does not get; a
deactivated one reports one calm German sentence at `INFO`. The decisive half is the warning: a warning line on _every_
run is one the user learns to scroll past, and the Log_View has real warnings in it — a Platform_Status the user needs
to act on is worth less once it sits next to a predictable one.

The counter-argument was that the per-run cost is small and the block may not be permanent, and that a Platform nobody
asks is a Platform whose recovery nobody notices. That is answered without paying for a 403 on every run: the opt-in
`@live` smoke test of this adapter (`pnpm test:live`, see `packages/scrapers/README.md`) asks the Platform once, on
purpose, when somebody wants to know. Recovery is detected by running it, not by a warning nobody reads.

What was never defensible, and is what this document existed to prevent, is leaving the Platform activated while
believing it delivers Job_Posting.

Deactivating is a two-line change with no migration: edit the constant, then restart the API_Service, because
`PlatformConfigurationService` resolves the configuration once in its constructor and holds it for the process lifetime.
Reactivating is the same edit in reverse. A deactivated Platform is still **registered**: its adapter, its fixtures and
its tests keep working, so the flag switches off the retrieval and nothing else.

## Provisional parameters

**No Result_Page has ever reached this repository**, so every parameter name, every mapped value and the bucket list are
read from Indeed's public surface and from descriptions of it rather than confirmed against a response. That is
evidence, not confirmation. What each one degrades into if it is wrong:

| Part                                                       | Status                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/jobs` path                                               | **provisional**, though it is the result list a person opens; the 403 answered it rather than a 404                                                                                                                                                               |
| `q` (the parameter name)                                   | **provisional**, and as close to certain as anything here                                                                                                                                                                                                         |
| the `"A" OR "B"` keyword expression                        | **provisional**: a Platform reading the whole expression as one literal term answers a _narrower_ result list. Glassdoor does exactly that and still served 30 readable Job_Posting, so the expression is kept rather than pre-emptively reduced to the job title |
| `l` (the place)                                            | **provisional**. _Degradation:_ ignored means a country-wide result list — wider, never narrower                                                                                                                                                                  |
| `fromage` (posting age in days)                            | **provisional**. _Degradation:_ ignored means no age filter, so older Job_Posting arrive as well                                                                                                                                                                  |
| the buckets `1, 3, 7, 14, 30`                              | **provisional**; the visible filter offers only 1, 3, 7 and 14, and 30 is a bucket because the shipped profile asks for it                                                                                                                                        |
| `jt=permanent`                                             | **provisional, and the one parameter whose failure is not graceful** — see below                                                                                                                                                                                  |
| the frame words `geschaltet`, `gepostet`, `veröffentlicht` | **provisional**: the closed list `POSTING_FRAME_SUFFIX` strips before a publication date is read. _Degradation:_ an unknown wording costs the date (6.9), never the Job_Posting                                                                                   |

Every other unknown value degrades in one direction: Indeed ignores a query parameter it does not know, so the retrieval
reads a result list that is wider than the Search_Profile asked for, and the Commute_Service and the Relevance_Service
rate what arrives.

**`jt=permanent` is the exception.** `fulltime`, `parttime`, `contract`, `temporary` and `internship` are documented
values of Indeed's own search; `permanent` is the value this mapping needs most — `PERMANENT` is "Festanstellung", which
is what the shipped Default_Search_Profile asks for — and it is read from the German surface rather than from a
documented list. An unrecognised value is either ignored, which is harmless, **or answered with an empty result list**,
which this adapter reports as a completed retrieval with no Job_Posting and which is indistinguishable in the markup
from a search that genuinely matched nothing. `PERMANENT` is deliberately not mapped to the documented `fulltime`:
full-time and permanent are different statements, and asking for `fulltime` would drop every part-time permanent
Job_Posting the profile did ask for while admitting fixed-term full-time ones it did not.

The two probes of 24.2 establish exactly one thing about it: **the 403 is not caused by `jt`.** The request carrying the
parameter and the request without it were answered identically. The question stays open until a Result_Page arrives, and
the test then is the one the source names: compare the posting count of a query carrying `jt` with one without it. An
equal count means the value was accepted or ignored; zero against a non-zero count means Indeed answered an unknown job
type with an empty result list.

Everything in this list is one edit in one file, which is why the names and the bucket list are named constants and why
the tests assert against those constants wherever they can. When a capture confirms or corrects any of it, update
`result-list-url.ts`, the [At a glance](#at-a-glance) and [Source URL](#source-url-of-the-retrieved-result-list)
sections here, and the review dates.

## Page classification

One Result_Page is read by a pure, browser-free function: HTML plus the response that carried it in, one outcome plus
the raw postings of that page out. It never throws — every failure it can observe already has a Platform_Status, and an
exception would lose the Partial_Result.

The classification order matters, because the characteristics overlap: a bot check page carries a sign-in link, a
sign-in wall carries no postings, and an empty result list looks exactly like a broken selector unless the Platform says
otherwise.

1. **the response alone**, for the two statuses that settle themselves — HTTP 429, a quota header reading exactly `0`,
   or an unsuccessful status carrying `Retry-After` → `RATE_LIMITED`; an outright `403` → `BOT_CHECK`, which is the
   likely Indeed case;
2. **bot check** (`BOT_CHECK_SELECTORS`, `BOT_CHECK_PHRASES`) — before anything else that reads the page, since a
   challenge page's text says nothing about the search. Detected and reported, never answered;
3. **every other unsuccessful status** — 5xx → `UNREACHABLE`; any other 4xx → `LAYOUT_UNKNOWN` (a 404 on a URL the
   adapter built itself means the URL shape no longer holds);
4. **sign-in** — the URL the load ended on matching `SIGN_IN_PATH_FRAGMENTS`, or a covering overlay from
   `SIGN_IN_OVERLAY_SELECTORS` → `SIGN_IN_REQUIRED`;
5. **rate limit stated in the page body** (`RATE_LIMIT_PHRASES`) → `RATE_LIMITED`;
6. **the job cards** — at least one posting carrying title, source URL and Posting_Id makes the page a result list →
   `POSTINGS`;
7. **with no readable posting** — an explicit "nothing matched" marker or phrase → `EMPTY_RESULT_LIST`; a long-form
   sign-in prompt → `SIGN_IN_REQUIRED`; anything else → `LAYOUT_UNKNOWN`.

**Step 3 after step 2 is the one ordering difference to the Glassdoor reader, and it is specific to the protection
Indeed runs.** A Cloudflare challenge is served with a `503` as readily as with a `403`, and a `503` reported as
`PLATFORM_UNREACHABLE` would tell the user to try again later for a block that will answer the same way every time. So
an unsuccessful status is held back until the challenge markers have been looked for in the body. The captured
`captcha.html` is what pins this: it announces itself in its body as well as through its status, so it classifies as
`BOT_CHECK` even when it is served with a 200.

Postings parsed from a page that also ended the retrieval are kept — the adapter takes a page's postings over before it
looks at the classification. For this Platform that is the likely case rather than the exotic one.

The honest limit is the same one Glassdoor has: a result list that is empty _because_ the Platform decided not to serve
one to this client is indistinguishable, in the markup, from a search that legitimately matched nothing. The reader
reports what the page says and does not guess at a block it cannot see.

### Selector tables

All selector tables are ordered candidate lists — the first selector that matches anything wins — so a layout change is
repaired by putting the new selector in front rather than by rewriting the parser. **None of them has been confirmed
against a served result list.** A selector set that no longer matches does not produce wrong data: a page that yields no
readable Job_Posting is reported as `PAGE_LAYOUT_UNKNOWN` (6.7).

`data-testid` attributes lead every table on purpose: Indeed renders its result list with build-hashed emotion class
names (`css-1m4cuuf`), which change with every deployment, while `data-testid` is what its own test suite selects on.
The semantic class names its cards have carried for years (`job_seen_beacon`, `jobTitle`, `companyName`,
`companyLocation`, `job-snippet`) sit behind them, and the schema.org microdata candidates last, as the published
contract fallback.

| Table                                                                      | Purpose                                                                                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `CARD_SELECTORS`                                                           | the job cards of a Result_Page; the last candidate is the advertisement anchor itself                                |
| `FIELD_SELECTORS`                                                          | title, link, employer, work location, publication date, description inside one card                                  |
| `POSTING_ID_ATTRIBUTES`                                                    | card attributes carrying the Posting_Id (`data-jk`, `id`)                                                            |
| `POSTING_ID_QUERY_PARAMS`                                                  | the identifier parameters of an advertisement URL (`jk`, `vjk`)                                                      |
| `NEXT_PAGE_SELECTORS`                                                      | "there is a further Result_Page"; a present-but-disabled control and an anchor without `href` count as the last page |
| `EMPTY_RESULT_SELECTORS` / `EMPTY_RESULT_PHRASES`                          | Indeed stating that the search matched nothing                                                                       |
| `SIGN_IN_PATH_FRAGMENTS` / `SIGN_IN_OVERLAY_SELECTORS` / `SIGN_IN_PHRASES` | the three characteristics of a sign-in wall                                                                          |
| `BOT_CHECK_SELECTORS` / `BOT_CHECK_PHRASES`                                | a Captcha or bot check page; the Cloudflare challenge surfaces lead                                                  |
| `RATE_LIMIT_PHRASES` / `RATE_LIMIT_HEADERS` / `REMAINING_QUOTA_HEADERS`    | a reported fetch rate                                                                                                |
| `TRACKING_QUERY_PARAMS`                                                    | per-click parameters stripped from a posting's source URL                                                            |

Every phrase list is matched case-insensitively and carries **German and English wording**, because Indeed serves the
same result list on a German and an English surface and a redirect onto the English one must not turn an empty search
into a layout change. The sign-in phrases are deliberately long ("melden sie sich an, um …") rather than the bare word
"Anmelden": every Indeed page carries a sign-in link in its header. They are only consulted when the page yielded no
readable posting.

`TRACKING_QUERY_PARAMS` (`from`, `tk`, `alid`, `advn`, `adid`, `ad`, `sjdu`, `acatk`, `pub`, `camk`, `fccid`, `vjs`,
`rtk`, `xkcb`, `xpse`, `xfps`, `mo`, `cmpid`, `gclid`, `fbclid`, `msclkid` and the five `utm_*` names) are removed from
every stored source URL. An Indeed result link carries a per-impression click and attribution set, so keeping it would
change the stored URL and the Content_Hash of an unchanged posting on every run and defeat the hash gate of 15.4.

The Posting_Id is `data-jk`, Indeed's own job key, where the card carries it, otherwise the `jk` or `vjk` parameter of
the advertisement URL. `POSTING_ID_QUERY_PARAMS` is an allow-list rather than "any long token" and is disjoint from
`TRACKING_QUERY_PARAMS`, and a job key has to be a whole hexadecimal token: an Indeed result link is full of
per-impression tokens that look exactly like a job key, and a Posting_Id that changed per Scrape_Run would make the
upsert of 9.4 insert a duplicate instead of updating.

### Publication dates: a framed relative statement

Indeed does not render a bare relative statement; it renders a sentence: "Vor 3 Tagen geschaltet", "Gerade geschaltet",
"Heute", "Vor mehr als 30 Tagen". The reader hands that text on unchanged, because turning it into a date needs the
Scrape_Run start time, which that layer deliberately does not have (6.4).

`RELATIVE_PATTERN` in `packages/scrapers/src/normalize/parse-publication-date.ts` is anchored, so before task 24.2 the
trailing "geschaltet" made the whole value a non-match and **every** Indeed Job_Posting would have taken the 6.9 path:
publication date empty, a `posting.publicationDateUnparsable` note per posting, the posting kept.

The fix went into the shared normalization layer rather than into a strip in the Indeed parser — that reader returns the
page's values raw by contract, and a second Platform using the same sentence shape would need the same strip again.
`POSTING_FRAME_SUFFIX` now removes a trailing frame word from the closed list `geschaltet`, `gepostet`, `veröffentlicht`
before the relative readers run, and `gerade` joins the named days as 0 days. Each wording thereby reduces to one the
module already understood. Any _other_ trailing text still makes the value a non-match, so an unknown wording keeps
costing the date and never the Job_Posting.

The three frame words are **provisional in the same sense as the query parameters**: no served Result_Page confirmed
them.

## German Log_Stream lines

The adapter writes the progress of a running Scrape_Run line by line. The German text is the user-facing Log_View
wording; the English `code` is the stable key tests and the API_Service error mapping read. The codes are the same ones
the other three adapters write, because they identify the _observation_ and not the Platform — the Platform travels in
the Log_Stream entry and is named in the German sentence. Per the language convention, documentation and identifiers are
English and only the Log_Stream text, the Web_App strings and the Relevance_Reason are German.

| Code                          | Level | German text                                                                                                                                                                    |
| ----------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `platform.pageFetched`        | INFO  | `Indeed: Seite <n> gelesen, <m> Treffer gefunden.`                                                                                                                             |
| `platform.noResults`          | INFO  | `Indeed: keine Treffer für die aktuellen Suchkriterien.`                                                                                                                       |
| `platform.resultListComplete` | INFO  | `Indeed: Ergebnisliste vollständig gelesen, <n> Seiten mit <m> Treffern.`                                                                                                      |
| `platform.pageLimit`          | INFO  | `Indeed: Seitenlimit erreicht, es wurden <n> Ergebnisseiten gelesen.`                                                                                                          |
| `platform.signInRequired`     | WARN  | `Indeed zeigt Ergebnisse nur nach Anmeldung. Der Abruf dieser Plattform wurde beendet und in diesem Suchlauf nicht wiederholt; die Trefferliste ist für Indeed unvollständig.` |
| `platform.blocked`            | WARN  | `Indeed hat den automatischen Abruf blockiert. Die Sicherheitsabfrage wurde nicht beantwortet und der Abruf dieser Plattform in diesem Suchlauf nicht wiederholt.`             |
| `platform.rateLimited`        | WARN  | `Indeed hat die Abfragerate begrenzt. Der Abruf dieser Plattform wurde beendet.`                                                                                               |
| `platform.layoutUnknown`      | ERROR | `Der Seitenaufbau von Indeed hat sich geändert; es konnten keine Treffer gelesen werden.`                                                                                      |
| `platform.unreachable`        | ERROR | `Indeed war nicht erreichbar. Bitte den Suchlauf später wiederholen.`                                                                                                          |
| `page.failed`                 | ERROR | `Indeed hat auf Seite <n> nicht geantwortet. Treffer bis zu dieser Seite wurden gespeichert.`                                                                                  |

The last row is the fallback for a Platform_Status without its own sentence, which is what an exhausted attempt series
reports. `platform.blocked` is the line a Scrape_Run currently writes for this Platform; `platform.pageLimit` is the
line a successful one would write, because one page is the whole budget.

Two of these sentences say more than their Stepstone counterparts, deliberately: the design accepts `PLATFORM_BLOCKED`
and `SIGN_IN_REQUIRED` as a normal outcome for Indeed, so the single non-technical user reading the Log_View is told
that the Job_Tool stopped asking on purpose (7.8) rather than that something is broken. The German sentence for a
deactivated Platform is not in this table, because it belongs to the API_Service rather than to the adapter; it is in
[Deactivating the Platform](#deactivating-the-platform-in-the-source-code).

## Ending a retrieval

Every end the adapter can observe is a result, not an exception. A sign-in wall, a bot check, an unreadable layout, a
reported fetch rate and the page limit all return the Job_Posting read so far together with one Platform_Status; a
thrown error would take the postings with it, and for this Platform the postings read before a block would frequently be
the only ones there will be. The error classes are still used as the single place pairing an observation with its
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

**One fixture of this Platform is a real capture — the bot check — and the other seven are hand-authored.** This folder
is the inverse of the Glassdoor one, where the readable Result_Page is the captured document and the blocking cases are
hand-authored. Here the block _is_ the capture, and every readable page is written by hand. The sidecar
`<case>.capture.json`, not the presence of an HTML file, is what dates a fixture;
`packages/scrapers/src/adapters/indeed/__fixtures__/README.md` carries the provenance of every case plus the full
account of what the three requests of 2026-10-29 established.

| Observation               | Detail                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Capture attempts          | 2026-10-29, by task 24.2, three requests through `pnpm fixtures:capture`                              |
| First attempt             | refused at the robots.txt gate — `EXCLUDED_BY_ROBOTS_TXT`, because the URL still carried `radius=`    |
| Second and third attempts | the permitted URL, once with `jt=permanent` and once without; both answered **HTTP 403**              |
| What came back            | `<title>Security Check - Indeed.com</title>`, "Additional Verification Required", a Cloudflare Ray ID |
| User agent                | the unchanged Job_Tool identification of 14.5                                                         |
| Stored as                 | `captcha.html` at `2026-10-29T13:45:35.276Z`, provenance `CAPTURED`                                   |
| Sanitization              | 5 scripts and 1 style removed, the `isid` parameter stripped; 38,944 bytes raw, 17,742 stored         |
| Result_Page ever served   | **none**                                                                                              |

The two response bodies were byte-identical apart from the Ray ID, which is what establishes that the 403 is not caused
by `jt`. A green fixture suite says the parser is correct about documents of this shape; it does not say the shape is
right.

### Provenance per case

| Case                 | Provenance      | Why                                                                     |
| -------------------- | --------------- | ----------------------------------------------------------------------- |
| `captcha`            | `CAPTURED`      | what de.indeed.com actually served on 2026-10-29: HTTP 403, a bot check |
| `result-list-page-1` | `HAND_AUTHORED` | Indeed served no result list at all                                     |
| `result-list-page-2` | `HAND_AUTHORED` | likewise, and it additionally carries the 6.5 and 6.8 cases             |
| `result-list-empty`  | `HAND_AUTHORED` | likewise                                                                |
| `layout-changed`     | `HAND_AUTHORED` | no Platform serves a changed layout on demand                           |
| `sign-in-wall`       | `HAND_AUTHORED` | the capture was met with a bot check rather than with a wall            |
| `rate-limited`       | `HAND_AUTHORED` | one request per invocation cannot provoke a rate limit, by design       |
| `relative-dates`     | `HAND_AUTHORED` | the date wordings, which no served page confirmed                       |

A hand-authored fixture is honest as long as its provenance says so, and every `.expected.json` in that folder was
generated by running the real reader and the real `IndeedAdapter` over the stored document rather than typed out by
hand.

### Capturing

```bash
pnpm fixtures:capture --platform indeed [--case <name>] [--url <url>] [--out <dir>] [--force]
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

Only `--case result-list-page-1` is reachable for this Platform: there is no permitted URL for a second Result_Page, so
`--page 2` has nothing to retrieve. This repository forbids a `VAR=value` command prefix, so set the contact detail in
`.env` or put the `export` line and the call into a script file.

### Layout

| File                                                          | Content                                                                                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/indeed/__fixtures__/<case>.html`                | the stored document, byte-identical afterwards (`__fixtures__` is in `.prettierignore`)                                                                     |
| `src/adapters/indeed/__fixtures__/<case>.expected.json`       | the expected reading: `provenance`, response status and headers, parser outcome, Platform_Status, `hasNextPage`, `readablePostingCount`, every raw posting  |
| `src/adapters/indeed/__fixtures__/<case>.capture.json`        | the sidecar of a captured document: `capturedAt`, page number, requested and final URL, HTTP status, user agent, byte counts, what the sanitization removed |
| `src/adapters/indeed/__fixtures__/robots-user-agent-star.txt` | the complete `User-agent: *` group of the Platform's robots.txt as served on 2026-10-29, which the URL tests evaluate against                               |

The metadata sits beside the HTML rather than in a header comment, so a reviewer sees the capture date in the diff
without the page itself being edited.

### Expected cases

The eight cases the parser tests cover (`REQUIRED_FIXTURE_CASES`):

`result-list-page-1`, `result-list-page-2`, `result-list-empty`, `layout-changed`, `sign-in-wall`, `captcha`,
`rate-limited`, `relative-dates`.

`result-list-page-1` is the one that shows the page limit: it offers a further page, the budget is one, so its expected
Platform_Status is `PAGE_LIMIT_REACHED` and its result is a Partial_Result. `result-list-page-2` is the last page and
reports `COMPLETED`; it exists for the parser and the fixture-mode E2E run, not because the Platform serves a second
page. `robots-user-agent-star.txt` is not a case — only `.html` files are — so the eight required ones are unaffected by
it.

### Refresh loop

When a real Scrape_Run or an opt-in live smoke test reports `PAGE_LAYOUT_UNKNOWN`:

1. re-capture the affected case with `pnpm fixtures:capture --platform indeed --case result-list-page-1 --force`;
2. put the new selector in front of its candidate list in `parse-result-list.ts`;
3. regenerate the expected JSON, review that diff rather than overwriting it blindly, and set its `provenance` to
   `CAPTURED`;
4. update this file — the selector status, the parameter status, the URL if it changed, and the review dates.

Re-read the robots.txt in the same loop. `radius=` and `&start=` are the two lines this Platform_Adapter's whole shape
rests on, and a Platform that publishes a permitted pagination parameter makes `INDEED_RESULT_PAGE_LIMIT` the one
constant to change.

## Source files

| File                                                                            | What it holds                                                                                                                                                                 |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/scrapers/src/adapters/indeed/index.ts`                                | the page loop, the page budget cap, the return-rather-than-throw rule                                                                                                         |
| `packages/scrapers/src/adapters/indeed/result-list-url.ts`                      | `INDEED_ORIGIN`, `indeedResultListUrl`, `indeedKeywordQuery`, `INDEED_RESULT_PAGE_LIMIT`, `INDEED_AGE_BUCKETS_DAYS`, `INDEED_JOB_TYPES`, and the robots.txt reasoning in full |
| `packages/scrapers/src/adapters/indeed/parse-result-list.ts`                    | the selector tables, the `ResultPageOutcome` union, the classification order                                                                                                  |
| `packages/scrapers/src/adapters/indeed/messages.ts`                             | the German Log_Stream lines and their stable English codes                                                                                                                    |
| `packages/scrapers/src/adapters/indeed/__fixtures__/README.md`                  | the provenance of every stored document and the full account of the capture attempts                                                                                          |
| `packages/scrapers/src/adapters/indeed/__fixtures__/robots-user-agent-star.txt` | the Platform's own rules, as served on 2026-10-29                                                                                                                             |
| `packages/scrapers/src/adapters/indeed/__tests__/result-list-url.test.ts`       | every built URL evaluated against those rules, the bucket rounding, the determinism, the `RangeError` cases                                                                   |
| `packages/scrapers/src/adapters/search-criteria.ts`                             | reading one Criterion_Field out of an effective Search_Profile                                                                                                                |
| `packages/scrapers/src/normalize/parse-publication-date.ts`                     | `POSTING_FRAME_SUFFIX` and the relative date vocabulary                                                                                                                       |
| `packages/scrapers/src/adapter/types.ts`                                        | `RESULT_PAGE_BUDGET` (10), `RESULT_PAGE_TIMEOUT_MS` (30 000)                                                                                                                  |
| `packages/scrapers/src/scheduling/platform-queue.ts`                            | `MIN_REQUEST_GAP_MS` (2000), `MAX_REQUEST_ATTEMPTS` (3)                                                                                                                       |
| `packages/scrapers/src/robots/robots.ts`                                        | the robots.txt evaluation and `ROBOTS_FETCH_TIMEOUT_MS` (10 000)                                                                                                              |
| `packages/scrapers/src/runtime/user-agent.ts`                                   | the user agent of every outgoing request                                                                                                                                      |
| `packages/scrapers/src/runtime/browser.ts`                                      | the browser context per Platform, `BLOCKED_RESOURCE_TYPES`, the teardown                                                                                                      |
| `packages/scrapers/src/fixtures/capture.ts`                                     | the capture flow and its refusals                                                                                                                                             |
| `packages/scrapers/src/fixtures/fixture-paths.ts`                               | the fixture layout and `REQUIRED_FIXTURE_CASES`                                                                                                                               |
| `packages/domain/src/search-profile/capabilities.ts`                            | the Indeed capability declaration, without `searchRadiusKm`                                                                                                                   |
| `packages/domain/src/search-profile/constants.ts`                               | the Default_Search_Profile and `PLATFORM_ACTIVATION`                                                                                                                          |
