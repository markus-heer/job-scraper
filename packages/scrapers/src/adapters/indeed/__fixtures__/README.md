# Indeed fixtures

Frozen Result_Page of Indeed plus the expected reading of each one. Served to the adapter by the
fixture server of `src/fixtures/`, so the parser tests run without a browser and without a network
request to the Platform (Requirement 14, design "Platform_Adapter tests against frozen fixtures").

Three files per case:

| File                   | Content                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `<case>.html`          | the document, byte for byte as it is stored                          |
| `<case>.expected.json` | the expected reading: outcome, Platform_Status, raw postings         |
| `<case>.capture.json`  | provenance of a captured document — absent for a hand-authored one   |

Plus one file that belongs to no case: **`robots-user-agent-star.txt`**, the complete `User-agent: *`
group of `https://de.indeed.com/robots.txt` as it was served on 2026-10-29, with a header stating that
provenance. `../__tests__/result-list-url.test.ts` evaluates every URL `indeedResultListUrl` builds
against those rules through the real `evaluateRobots`, so the retrieval scope of this Platform_Adapter
is pinned against the Platform's own statement rather than against a restatement of it. Only `.html`
files are fixture cases, so the extra file changes nothing about the eight required ones.

## Provenance

| Case                 | Provenance      | Why                                                                     |
| -------------------- | --------------- | ----------------------------------------------------------------------- |
| `captcha`            | `CAPTURED`      | what de.indeed.com actually served on 2026-10-29: HTTP 403, a bot check |
| `result-list-page-1` | `HAND_AUTHORED` | Indeed served no result list at all; see below                           |
| `result-list-page-2` | `HAND_AUTHORED` | likewise, and it additionally carries the 6.5 and 6.8 cases              |
| `result-list-empty`  | `HAND_AUTHORED` | likewise                                                                 |
| `layout-changed`     | `HAND_AUTHORED` | no Platform serves a changed layout on demand                            |
| `sign-in-wall`       | `HAND_AUTHORED` | the capture was met with a bot check rather than with a wall             |
| `rate-limited`       | `HAND_AUTHORED` | one request per invocation cannot provoke a rate limit, by design        |
| `relative-dates`     | `HAND_AUTHORED` | the date wordings, which no served page confirmed                        |

This folder is therefore the inverse of the Glassdoor one: there the readable Result_Page is the
captured document and the blocking cases are hand-authored. Here **the block is the capture**, and
every readable page is written by hand.

## What was attempted on 2026-10-29, and what came back

Task 24.2 made three requests to de.indeed.com, each through `pnpm fixtures:capture`, each therefore
with the unchanged Job_Tool user agent of 14.5 (`JobTool/0.1 (private use; contact: …)`) and each
after evaluating `https://de.indeed.com/robots.txt` first (14.1). Two findings came out of it, and
the first one is the more consequential.

### 1. The robots.txt of de.indeed.com forbids the URL this adapter builds (14.2)

The very first capture attempt never reached the Platform. It was refused at the robots.txt gate with
`EXCLUDED_BY_ROBOTS_TXT`, and the rule that refuses it is **line 126 of the `User-agent: *` group**:

```text
User-agent: *
Allow: /
…
Disallow: /*radius=
…
Disallow: /*&start=
…
Disallow: /viewjob
```

The group opens with `Allow: /` and then excludes a long list of query shapes. Three of them matter
here, and all three were checked against the retrieved body with the Job_Tool user agent:

| Path                                                        | Decision   | Deciding line          |
| ----------------------------------------------------------- | ---------- | ---------------------- |
| `/jobs?q=…&l=München&radius=50&fromage=30&jt=permanent`      | disallowed | `Disallow: /*radius=`  |
| the same plus `&start=10&page=2`                             | disallowed | `Disallow: /*radius=`  |
| `/jobs?q=…&l=München&fromage=30&jt=permanent`                | allowed    | `Allow: /`             |
| `/viewjob?jk=<job key>`                                      | disallowed | `Disallow: /viewjob`   |

So the Platform permits its result list and forbids two of the parameters `../result-list-url.ts`
puts on it: `radius`, on **every** Result_Page including the first, and `&start=`, which is Indeed's
own pagination. The Job_Tool identifies honestly and does not fall into any of the bot groups further
down the file, so the `*` group is the one that applies and there is no second reading of it.

What that meant for a Scrape_Run at the time of the capture: **the Indeed Platform_Adapter could not
retrieve anything.** `RobotsCache` evaluates every intended Result_Page path before the first page
request, found the first one disallowed, and the Platform ended with the Platform_Status
`EXCLUDED_BY_ROBOTS_TXT` without a single page being fetched. That was the Job_Tool behaving correctly —
14.2 asks for exactly this — but it reported the Platform as the one excluding the Job_Tool for a
parameter choice the Job_Tool had made itself.

**Task 24.3 settled it by removing both parameters.** `searchRadiusKm` left Indeed's `supportedFields`
in `PLATFORM_CAPABILITIES` in the same change, because a declared Criterion_Field that never reaches
the query would make the read-only criteria view of 4.11 claim a filter the retrieval did not apply;
and with `start` gone there is no permitted way to address a second Result_Page, so the retrieval is
capped at one page and reports `PAGE_LIMIT_REACHED` where the page it read offers a further one. The
reasoning, including the parameter-reordering trick that was considered and rejected as circumvention,
is in the file comment of `../result-list-url.ts`; the rules it rests on are pinned in
`../__tests__/result-list-url.test.ts` against `robots-user-agent-star.txt`. `docs/adapters/indeed.md`
(task 24.4) records the resulting retrieval scope.

### 2. With the forbidden parameter dropped, Indeed answers HTTP 403 with a bot check

To find out what the Platform does with a request robots.txt *does* permit, the same query was
retrieved twice with `radius` removed — once with `jt=permanent` and once without it. Both answered:

```text
HTTP 403
<title>Security Check - Indeed.com</title>
Additional Verification Required
Please enable JavaScript to complete the security check.
Your Ray ID for this request is …
Troubleshooting Cloudflare Errors
```

The two response bodies are byte-identical apart from the Cloudflare Ray ID. `captcha.html` is the
first of the two, sanitized by the capture tool (5 scripts, 1 style removed, the `isid` parameter
stripped) and otherwise byte-identical to what was served; `captcha.capture.json` carries the date,
the request URL, the status and the user agent.

This is the design's Risk 1 materialising, and it is the accepted outcome 7.6 and 7.8 describe: the
challenge is detected and reported as `PLATFORM_BLOCKED`, and nothing in this adapter answers it.
Note which half of the reader did the detecting — the page announces itself in its **body** as well as
through its status, so `readIndeedResultPage` classifies this exact document as `BOT_CHECK` even when
it is served with a 200. The detection does not depend on the 403, which is what the Indeed-specific
ordering in `../parse-result-list.ts` (a challenge may arrive as a 503) needs in order to work.

### The `jt=permanent` question could not be settled

`../result-list-url.ts` singles out `jt` as the one parameter whose failure is not graceful: an
unrecognised value is either ignored, which is harmless, or answered with an empty result list, which
this adapter reports as a completed retrieval with no Job_Posting and which is indistinguishable in
the markup from a search that genuinely matched nothing.

**No Result_Page was served, so the question stays open.** What the two probes do establish is that
the 403 is not caused by `jt`: the request with the parameter and the request without it were
answered identically. The mapping `PERMANENT → permanent` therefore remains provisional, and it is
provisional for a Platform that currently retrieves nothing at all, so it is not the binding problem.
It becomes answerable only once finding 1 is resolved and a Result_Page actually arrives — at which
point the test is the one the file comment names: compare the posting count of a query with `jt` and
one without.

## What the hand-authored documents are modelled on

The markup is written against the selector tables of `../parse-result-list.ts` and Indeed's publicly
visible result list structure, and it exercises both layouts those tables carry rather than one
generic shape:

- **`result-list-page-1` uses the `data-testid` layout**, which is what leads every selector table:
  `[data-testid="slider_item"]` cards on build-hashed emotion class names (`css-1m4cuuf`), with
  `data-testid` for the title, the company name, the location, the date and the snippet. One card
  renders its title as `<span data-testid="jobTitle" title="…">` prefixed with the screen-reader
  phrase "Jetzt bewerben: ", so the documented preference for the `title` attribute over the visible
  text is observable. The links are the three click-through shapes Indeed uses — `/rc/clk`,
  `/pagead/clk` and `/viewjob` — each carrying the per-impression tracking parameters that
  `TRACKING_QUERY_PARAMS` strips, so the stored source URL reduces to the job key.
- **`result-list-page-2` uses the legacy layout**: `div.job_seen_beacon` with `h2.jobTitle`,
  `span.companyName`, `div.companyLocation`, `span.date` and `div.job-snippet`. It is the last page,
  and its "next" control is present but `aria-disabled`, which is how a result list marks the end
  rather than removing the control. It also carries the cases the first page does not: a card with an
  empty title anchor and a card with no anchor at all, which the normalization stage discards under
  6.5, plus a card without an employer and one without a snippet, which are the "mark as empty" of
  6.8. One card has no `data-jk`, so its Posting_Id is read out of the `jk` parameter of its URL.
- **`relative-dates` carries the eight publication date wordings**, which is the one thing in this
  folder that changed shared code. See the next section.
- **`sign-in-wall`, `layout-changed`, `result-list-empty` and `rate-limited`** pin parser behaviour:
  which characteristic of a page wins, which Platform_Status comes out of it, and that a page with no
  readable Job_Posting and no explanation is the layout change of 6.7 rather than an empty result.

Every `.expected.json` in this folder was **generated by running the real reader and the real
`IndeedAdapter`** over the stored document — the reader for `outcome`, `postings`, `hasNextPage` and
`readablePostingCount`, and the adapter with a page budget of 1 for `platformStatus`. Only the
declared response and the `description` are written by hand. Nothing here is a typed-out guess at what
the parser produces, which is the one way a fixture can agree with a bug.

## The publication date wording, and the change it caused

Indeed does not render a bare relative statement; it renders a sentence: "Vor 3 Tagen geschaltet",
"Gerade geschaltet". `RELATIVE_PATTERN` in `../../../normalize/parse-publication-date.ts` is anchored,
so before this task the trailing "geschaltet" made the whole value a non-match and **every** Indeed
Job_Posting would have taken the 6.9 path — publication date empty, a Log_Stream note per posting.

The fix is in the shared normalization layer, not in the Indeed parser, and that is the repository's
own convention: a Platform that invents a wording adds it to the vocabulary tables of
`parse-publication-date.ts`, the way the compact Glassdoor day count was added as
`COMPACT_DAY_PATTERN` in task 23.3. Stripping the suffix in `../parse-result-list.ts` was the
alternative and was rejected for two reasons — that reader returns the page's values *raw* by
contract, and a second Platform using the same sentence shape would then need the same strip again.

`POSTING_FRAME_SUFFIX` now removes a trailing frame word from a closed list — `geschaltet`,
`gepostet`, `veröffentlicht` — before the relative readers run, and `gerade` joins the named days as
0 days. Each wording thereby reduces to one the module already understood. Any *other* trailing text
still makes the value a non-match, so an unknown wording keeps costing the date and never the
Job_Posting. All eight wordings of `relative-dates` resolve; the three frame words are read from
Indeed's public surface and are **provisional in the same sense as the query parameters**, because no
served Result_Page confirmed them.

## What these fixtures do not establish

- **That Indeed renders this markup.** Nothing here does. Only `captcha.html` came from the Platform,
  and what it proves is that the Platform refuses to serve a result list to this client.
- **That an Indeed retrieval reads a Result_Page at all.** As of 2026-10-29 it does not. Since task
  24.3 the URL is one the robots.txt permits, so a Scrape_Run now reaches the Platform instead of
  stopping at the gate — and the Platform answers 403 with a security check, which the Job_Tool reports
  as `PLATFORM_BLOCKED` without answering it (7.6, 7.8). A green fixture suite says the parser is
  correct about documents of this shape, not that the shape is right.
- **That the Posting_Id, the link shapes or the date wordings are real.** They are read from Indeed's
  public surface. A wrong Posting_Id would be the costly one, because the upsert of 9.4 is keyed on
  `(platform, postingId)` — which is why `JOB_KEY` requires a whole hexadecimal token and why
  `POSTING_ID_QUERY_PARAMS` is an allow-list rather than "any long token".
- **That the five behavioural cases look like this on Indeed.** `sign-in-wall`, `layout-changed`,
  `rate-limited` and `result-list-empty` are written from Indeed's documented and observable
  behaviour and pin the parser, not the Platform.

## Re-capturing

```bash
pnpm build
pnpm fixtures:capture --platform indeed --case result-list-page-1 --force
```

Since task 24.3 that command passes the robots.txt gate — `resultListUrl` emits neither `radius=` nor
`&start=` any more — and is answered by the Platform itself, which means a 403 and a security check for
as long as that holds. Only `--case result-list-page-1` is reachable: there is no permitted URL for a
second Result_Page, so `--page 2` has nothing to retrieve. To probe a different query without
overwriting a reviewed fixture, pass `--url` and `--out`:

```bash
pnpm fixtures:capture --platform indeed --case probe --out /tmp/indeed-probe \
  --url 'https://de.indeed.com/jobs?q=%22Projektmanagerin%22&l=M%C3%BCnchen&fromage=30&jt=permanent'
```

The capture needs `USER_AGENT_CONTACT` in `.env`, performs exactly one real Result_Page retrieval,
evaluates the robots.txt first and refuses to run under a test runner or in CI. This repository
forbids a `VAR=value` command prefix, so set the contact detail in `.env` or put the `export` line and
the call into a script file. Afterwards re-read the expectation file in the diff, set its `provenance`
to `CAPTURED`, and update `docs/adapters/indeed.md` including the review date (14.7).

## Why this folder is never formatted

The repository-wide `.prettierignore` excludes `**/__fixtures__/`. A captured document has to stay
byte-identical to what the Platform served, so neither the HTML nor the JSON beside it is reformatted.
