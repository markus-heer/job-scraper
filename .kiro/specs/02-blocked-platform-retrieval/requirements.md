# Requirements — Blocked Platform retrieval

## Introduction

Two of the four Platform contribute no Job_Posting to a Scrape_Run, and the Log_View of the run on
2026-10-29 18:02:52 named both:

```text
18:02:52  Jobvector  Jobvector hat den automatischen Abruf blockiert. Bitte später erneut versuchen.
18:02:52  Stepstone  Plattform Stepstone wurde nicht abgefragt, weil deren robots.txt den Abruf untersagt.
```

The two lines look alike to the user and have nothing in common underneath. This spec separates them,
because the separation is the whole finding.

**Stepstone is a defect of the Job_Tool, not a refusal by the Platform.** The robots.txt of
`www.stepstone.de` permits the result list; it forbids two *shapes* of query the Job_Tool happens to
build. Measured against the live robots.txt of 2026-10-29 with the same `robots-parser` the
Job_Tool uses:

| Intended path                                                        | Decision   | Deciding line            |
| -------------------------------------------------------------------- | ---------- | ------------------------ |
| `/jobs/projektmanagerin/in-muenchen`                                 | allowed    | no rule matches          |
| `/jobs/projektmanagerin/in-muenchen?q="Projektmanagerin"`            | allowed    | `Allow: /jobs/*?q=*`     |
| `/jobs/projektmanagerin/in-muenchen?q="…"+OR+"…"`                    | allowed    | `Allow: /jobs/*?q=*`     |
| `/jobs/projektmanagerin/in-muenchen?q="…"&radius=30&ag=age_30&ct=…`  | disallowed | `Disallow: /jobs/*?q*&*` |
| `/jobs/projektmanagerin/in-muenchen?radius=30`                       | disallowed | `Disallow: /jobs/*?*`    |
| `/jobs/projektmanagerin/in-muenchen?page=2`                          | disallowed | `Disallow: /jobs/*?*`    |
| `/jobs/projektmanagerin/in-muenchen?q="…"&page=2`                    | disallowed | `Disallow: /jobs/*?q*&*` |

Stepstone allows exactly one query parameter, and it allows it to be `q`. The Job_Tool sends four
and therefore gets `EXCLUDED_BY_ROBOTS_TXT` having fetched nothing. This is the Indeed situation of
task 24.3 repeated on another Platform, and it has the same remedy: build the URL the Platform
permits. No override, no exception, no new configuration key.

**Jobvector is a refusal by the Platform.** `https://www.jobvector.de/robots.txt` itself answers
HTTP 403 to the honest Job_Tool user agent, as does the result list. The Platform operates a
technical access control that admits indexing crawlers and rejects this one. Defeating it would mean
impersonating a browser or a search engine, patching the automation fingerprint, or answering a
Captcha — each of which contradicts a requirement of the Job_Tool rather than an implementation
choice of it (14.5 "the unchanged user agent, never imitating a browser"; 7.6 "no adapter answers a
Captcha"), and the repository has already rejected the same class of move once: the
`Disallow: /*&start=` note in `packages/scrapers/src/adapters/indeed/result-list-url.ts` records why
reordering query parameters to slip past a rule as written is circumventing a robots.txt rather than
obeying it.

So this spec does not evade Jobvector's block. It characterises the block once, pursues the two
interfaces the Platform publishes *for* machines, and otherwise stops paying for a 403 on every
Scrape_Run — the treatment Indeed already has.

## Glossary

The glossary of `.kiro/specs/job-search-tool/requirements.md` applies unchanged and its terms are
used as defined there: Job_Posting, Job_Tool, Platform, Platform_Adapter, Platform_Status,
Platform_Override, Scrape_Run, Result_Page, Search_Profile, Default_Search_Profile, Criterion_Field,
Partial_Result, Log_View, Log_Stream, Posting_Store, Relevance_Service, Commute_Service,
Best_Commute_Time, Web_App, API_Service, Steering_Docs.

Four terms are this spec's own:

- **Permitted_Query_Shape** — a Result_Page URL whose path and query string the `User-agent: *`
  group of that Platform's robots.txt allows, as decided by `robots-parser` against the retrieved
  body. The shape, not one example of it.
- **Single_Parameter_Rule** — the consequence of `Disallow: /jobs/*?q*&*` together with
  `Allow: /jobs/*?q=*` on `www.stepstone.de`: a permitted Stepstone result list URL carries either
  no query string at all or exactly the one parameter `q`.
- **Access_Control_Evasion** — any measure whose purpose is to make a Platform treat the Job_Tool as
  a client it would otherwise refuse: a user agent naming a browser or a search engine, patching
  `navigator.webdriver` or the canvas, WebGL and font fingerprints, a stealth plugin, a Captcha
  solver or a Captcha-solving service, residential proxies, or rotating identities.
- **Published_Machine_Interface** — a document a Platform serves deliberately for automated readers
  under its own terms: a `sitemap.xml`, an RSS or Atom feed, a `schema.org/JobPosting` block in a
  page it asks search engines to index, or a documented API. Reading one is not
  Access_Control_Evasion.

## Requirements

### Requirement 1 — Stepstone is retrieved through a Permitted_Query_Shape

**User Story:** As the single user of the Job_Tool, I want Stepstone to contribute Job_Posting to a
Scrape_Run, so that the Platform with the largest German result list stops reporting "durch
robots.txt ausgeschlossen" for a URL the Job_Tool chose itself.

#### Acceptance Criteria

1.1 The Stepstone Result_Page URL builder SHALL emit a URL that satisfies the Single_Parameter_Rule:
either the bare path `/jobs/<job-title-slug>/in-<location-slug>` or that path with `q` as its only
query parameter.

1.2 The Stepstone Result_Page URL builder SHALL NOT emit the parameters `radius`, `ag`, `ct` or
`page`, nor any further parameter alongside `q`.

1.3 WHEN the effective Search_Profile of Stepstone carries `titleSynonyms`, THEN the builder SHALL
carry the job title and its synonyms in the single `q` parameter as the quoted `OR` expression
`stepstoneKeywordQuery` already produces.

1.4 IF the effective Search_Profile of Stepstone carries no `titleSynonyms`, THEN the builder SHALL
emit the bare path with no query string, because a `q` repeating the path's title slug adds nothing
the path does not already state.

1.5 Every Criterion_Field declared in `PLATFORM_CAPABILITIES.STEPSTONE.supportedFields` SHALL
actually reach the emitted URL, so `searchRadiusKm`, `employmentType` and `publicationPeriodDays`
SHALL be removed from that declaration in the same change as 1.2.

1.6 The Stepstone Platform_Override SHALL NOT set a Criterion_Field the reduced declaration no longer
supports; `PLATFORM_OVERRIDES.STEPSTONE = { searchRadiusKm: 30 }` SHALL be removed.

1.7 The Stepstone retrieval SHALL read at most one Result_Page per Scrape_Run, bounded by a named
constant `STEPSTONE_RESULT_PAGE_LIMIT` carrying its reason, because no pagination parameter has a
Permitted_Query_Shape.

1.8 WHEN the one permitted Result_Page has been read AND Stepstone offers a further Result_Page, THEN
the adapter SHALL report Platform_Status `PAGE_LIMIT_REACHED` and the result SHALL be a
Partial_Result, which is the ordinary end of a *successful* Stepstone retrieval.

1.9 A test SHALL assert every URL the builder produces against the stored robots.txt of the Platform
using `robots-parser`, so a future parameter added to the builder fails that test by name rather
than reaching a Scrape_Run.

1.10 `docs/adapters/stepstone.md` SHALL state the retrieved paths, the one-page limit and the
robots.txt decision as measured, replacing the sentence "The robots.txt of stepstone.de has not been
read in this repository yet."

1.11 IF a real Result_Page capture shows that a `q` expression combined with the path's title slug
narrows the result list below what the bare path returns, THEN the builder SHALL emit the bare path
of 1.4 for every profile, and `titleSynonyms` SHALL be removed from the Stepstone declaration as
well.

### Requirement 2 — The Job_Tool performs no Access_Control_Evasion

**User Story:** As the single user of the Job_Tool, I want the tool to keep identifying itself
honestly, so that the retrieval it performs stays one I can describe truthfully to a Platform that
asks, and so that a civil question about terms of use never becomes a question about overcoming a
technical access control.

#### Acceptance Criteria

2.1 Every outgoing request of the Job_Tool SHALL carry the unchanged user agent built by
`buildUserAgent`, and that value SHALL NOT name a browser, a browser engine or a search engine
crawler.

2.2 The Job_Tool SHALL NOT contain Access_Control_Evasion as defined in the Glossary, and no
configuration key SHALL enable any.

2.3 WHEN a Platform serves a Captcha or a bot check, THEN the Platform_Adapter SHALL leave it
unanswered, report Platform_Status `PLATFORM_BLOCKED` and send no further request to that Platform
in that Scrape_Run, as 7.6 and 7.8 already require.

2.4 A test SHALL assert that the user agent of every outgoing request is the one `buildUserAgent`
produces, so a browser user agent introduced later fails that test by name.

2.5 IF a Platform's robots.txt forbids an intended path, THEN the Job_Tool SHALL change the intended
path or skip the Platform, and SHALL NOT reorder, rename or re-encode query parameters in order to
produce a URL that slips past a rule as written while requesting what the rule exists to prevent.

### Requirement 3 — Honest content negotiation

**User Story:** As the single user of the Job_Tool, I want the tool to state truthfully which content
it would like to receive, so that a Platform answering differently for want of a stated language
preference is not mistaken for a Platform that blocks the tool.

#### Acceptance Criteria

3.1 Every page request SHALL carry an `Accept-Language` header naming German as the preferred
language, because the Job_Tool reads German result lists and that preference is a true statement
about the client.

3.2 Every page request SHALL carry an `Accept` header naming the document types the retrieval reads.

3.3 The headers of 3.1 and 3.2 SHALL be stated once in the Playwright runtime and SHALL NOT be
settable per Platform_Adapter, so no adapter can turn them into a per-Platform disguise.

3.4 The headers of 3.1 and 3.2 SHALL NOT include any header whose purpose is to make the client
appear to be a browser, in particular no `Sec-Ch-Ua*` header and no browser `User-Agent`.

### Requirement 4 — Jobvector's refusal is characterised once and then stops costing

**User Story:** As the single user of the Job_Tool, I want Jobvector either retrieved through an
interface it publishes for machines or deactivated with the reason recorded, so that no Scrape_Run
spends a request, a browser page and a warning on a Platform that has refused this tool.

#### Acceptance Criteria

4.1 The response Jobvector returns to the honest Job_Tool user agent SHALL be captured once —
the HTTP status, the response headers and the body — and stored as a fixture with
`provenance: 'CAPTURED'` and its capture date.

4.2 `docs/adapters/jobvector.md` SHALL record the captured status, the date, which host and path were
requested, and whether the response names a specific blocking mechanism.

4.3 The Job_Tool SHALL probe whether Jobvector serves a Published_Machine_Interface to the honest
user agent, and `docs/adapters/jobvector.md` SHALL record the outcome per candidate interface
(`/robots.txt`, `/sitemap.xml`, an RSS or Atom feed, a `schema.org/JobPosting` block on a
keyword result page).

4.4 IF Jobvector serves a Published_Machine_Interface whose own terms permit private single-user
reading, THEN the Platform_Adapter MAY read it, and `docs/adapters/jobvector.md` SHALL state which
interface and under which terms.

4.5 IF no Published_Machine_Interface is available, THEN `PLATFORM_ACTIVATION.JOBVECTOR` SHALL be
`false`, with the reasoning stated in the constant in the manner of the existing `INDEED` entry.

4.6 WHEN `PLATFORM_ACTIVATION.JOBVECTOR` is `false`, THEN a Scrape_Run SHALL send no request to
Jobvector, and the Platform SHALL be reported with Platform_Status `DISABLED` rather than
`PLATFORM_BLOCKED`, because the Job_Tool and not the Platform ended that retrieval.

4.7 A deactivated Jobvector SHALL keep its `@live` smoke test, skipped by default, so a Platform
that stops refusing is detected by running `pnpm test:live` rather than by every Scrape_Run paying
for a 403.

4.8 The stored Job_Posting of Jobvector from earlier Scrape_Run SHALL be retained unchanged, since a
deactivated Platform is not evidence that its postings are gone.

### Requirement 5 — The user reads why a Platform contributed nothing

**User Story:** As the single non-technical user, I want the Log_View to tell me whether a Platform
refused the Job_Tool or the Job_Tool chose not to ask it, so that I can tell a problem I might act on
from a decision already taken for me.

#### Acceptance Criteria

5.1 The German sentence for `EXCLUDED_BY_ROBOTS_TXT` SHALL remain reserved for a Platform whose
robots.txt forbids a path the Job_Tool has no permitted alternative to, and SHALL NOT be reported for
a Platform the Job_Tool can reach through a Permitted_Query_Shape.

5.2 WHEN Stepstone ends a successful retrieval at its one-page limit, THEN the Log_Stream line SHALL
name the number of Result_Page actually read rather than a limit, as the Indeed message already does.

5.3 The Partial_Result hint of 7.4 SHALL be shown for a Scrape_Run in which Stepstone reported
`PAGE_LIMIT_REACHED`, because that result list was in fact not read to its end.

5.4 No new German text SHALL be added to the Web_App for any Platform_Status of this spec; the
existing `PLATFORM_STATUS_LABELS_DE` and `RUN_OUTCOME_LABELS_DE` of the API_Service already cover
every value involved.

### Requirement 6 — The change set documents itself

**User Story:** As the developer who returns to this in six months, I want the measured robots.txt
decision and the Jobvector refusal recorded next to the code they shaped, so that neither is
re-litigated from memory.

#### Acceptance Criteria

6.1 The reason for every removed query parameter and for `STEPSTONE_RESULT_PAGE_LIMIT` SHALL be
stated in `packages/scrapers/src/adapters/stepstone/result-list-url.ts`, naming the deciding
robots.txt line.

6.2 The capability table of `.kiro/steering/platform-adapter-conventions.md` SHALL be brought to the
new state in the same change set, per 16.11.

6.3 The terms-of-use review date of `docs/adapters/stepstone.md` SHALL be filled in with the ISO 8601
date of an actual reading, or SHALL remain explicitly open; it SHALL NOT be invented.

6.4 `docs/adapters/stepstone.md` and `docs/adapters/jobvector.md` SHALL state what their fixtures do
and do not establish, so a hand-authored fixture is never read as a captured one.
