# Glassdoor fixtures

Frozen Result_Page of Glassdoor plus the expected reading of each one. Served to the adapter by the
fixture server of `src/fixtures/`, so the parser tests run without a browser and without a network
request to the Platform (Requirement 14, design "Platform_Adapter tests against frozen fixtures").

Three files per case:

| File                   | Content                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `<case>.html`          | the document, byte for byte as it is stored                          |
| `<case>.expected.json` | the expected reading: outcome, Platform_Status, raw postings         |
| `<case>.capture.json`  | provenance of a captured document — absent for a hand-authored one   |

## Provenance

| Case                 | Provenance      | Why                                                                 |
| -------------------- | --------------- | ------------------------------------------------------------------- |
| `result-list-page-1` | `CAPTURED`      | one real retrieval of glassdoor.de on 2026-10-29, HTTP 200          |
| `result-list-page-2` | `HAND_AUTHORED` | Glassdoor serves no second page for this URL shape; see below       |
| `result-list-empty`  | `HAND_AUTHORED` | the search matched 30 postings, so no empty list was served         |
| `layout-changed`     | `HAND_AUTHORED` | no Platform serves a changed layout on demand                       |
| `sign-in-wall`       | `HAND_AUTHORED` | the capture was not met with one                                    |
| `captcha`            | `HAND_AUTHORED` | the capture was not met with one, and answering one is forbidden (7.6) |
| `rate-limited`       | `HAND_AUTHORED` | one request per invocation cannot provoke a rate limit, by design    |
| `relative-dates`     | `HAND_AUTHORED` | exercises date wordings the captured page does not all contain       |

### The capture was not refused

This is the sentence a reader of the Jobvector folder will not expect, so it is stated plainly: **the
capture attempt against glassdoor.de succeeded.** Task 23.2 performed one real retrieval of
`glassdoorResultListUrl(profile, 1)` with the unchanged Job_Tool user agent of 14.5 and after
evaluating `https://www.glassdoor.de/robots.txt`, which permitted the path and stated no crawl delay.
The response was **HTTP 200** with 30 readable Job_Posting. `result-list-page-1.html` is that
response, sanitized by the capture tool (122 scripts, 56 styles and 2 tracking elements removed; the
URL parameters `cpc`, `guid`, `jobListingId` and `jrtk` stripped) and otherwise byte-identical.

The design's Risk 1 — Glassdoor answers an honestly identified tool with a Captcha, a sign-in wall or
an empty list — did not materialise on that one request from that one address. It establishes nothing
about the next request: the `sign-in-wall` and `captcha` fixtures exist because those outcomes stay
the realistic ones for this Platform (7.2, 7.6), and `docs/adapters/glassdoor.md` carries the review
date.

## What the captured page established

`result-list-page-1.html` is the only document here that proves anything about Glassdoor's markup, and
it proves rather a lot:

- **The card selector holds.** `[data-test="jobListing"]`, the first candidate of
  `CARD_SELECTORS`, matched all 30 cards. Each carries `data-jobid`, which is where the Posting_Id
  comes from, so no posting depends on parsing an identifier out of a URL.
- **Four of the five field selectors hold on their first candidate:** `job-title`, `emp-location`,
  `descSnippet` and `job-age`. The employer is read by the *third* candidate,
  `[class*="EmployerProfile_compactEmployerName"]`, because Glassdoor renders no
  `[data-test="emp-name"]` — the ordered candidate list doing what it is for.
- **The link candidate order was wrong, and the capture is what showed it.** Glassdoor renders two
  anchors per card: the title anchor, whose `href` is the advertisement
  (`/job-listing/…-JV_IC2610266_KO0,36_KE37,42.htm?jl=1010299809793`), and an empty overlay anchor
  `[data-test="job-link"]`, whose `href` is `/partner/jobListing.htm` plus nothing but per-impression
  click parameters. Reading the overlay anchor first gave all 30 postings the same unopenable source
  URL. The title anchor now leads; see the comment on `FIELD_SELECTORS.link`.
- **There is no microdata.** No `itemtype`, no `itemprop`, no `datetime` attribute anywhere on the
  page. Every schema.org candidate in the selector tables went unmatched, and so did the whole
  machine-readable date path.
- **The publication date is a compact day count and nothing else:** `2T`, `10T`, `30T+` — 14 of the 30
  cards being `30T+`. That wording is **not** in the vocabulary of
  `../../normalize/parse-publication-date.ts`, so every Glassdoor posting currently takes the 6.9 path:
  publication date marked as empty, `posting.publicationDateUnparsable` written to the Log_Stream, the
  Job_Posting kept. The fixtures store the raw text, so adding the wording to the shared normalization
  layer needs no re-capture here.
- **Pagination is a button, not a parameter.** The page ends in
  `<button data-test="load-more">Mehr Jobs anzeigen</button>`, which is why `hasNextPage` is `true`.

### What it established about the Result_Page URL

Three of the four provisional guesses of `../result-list-url.ts` were settled by the capture, and the
file comment there records each one in full. In short: Glassdoor rewrote the request onto its own
canonical URL `/Job/…-jobs-SRCH_KO0,142.htm?sc.keyword=…`, **dropping `locKeyword` and `radius`**
(the retrieved postings are nationwide — Dresden, Ulm, Ummendorf), and `SRCH_KO0,142` shows the
142-character `"A" OR "B" OR …` expression was read as **one literal keyword**. A second capture with
`&page=2` landed on the same canonical URL and re-served 23 of the same 30 job identifiers, so the
`page` parameter is ignored.

## What these fixtures do not establish

- **That the stored page is still what Glassdoor serves.** Only a re-capture or the opt-in
  `@live` smoke test answers that.
- **That a Glassdoor retrieval reaches a second Result_Page.** It does not, with this URL shape. The
  `result-list-page-2` fixture is hand-authored *as a last page* — no `load-more` control, so it
  reports `COMPLETED` — because that is the shape the parser tests and the fixture-mode E2E run need,
  not because Glassdoor served it. Against the real Platform the adapter re-reads the first block of
  results up to the page limit of 13.3; the upsert of 9.4 turns that into no duplicate rows.
- **That the five error cases look like this.** `sign-in-wall`, `captcha`, `rate-limited`,
  `layout-changed` and `result-list-empty` are written from Glassdoor's documented and observable
  behaviour — the `HardsellOverlay` element of its own sign-in wall, the `px-captcha` container of the
  bot protection it runs, a `429` with `Retry-After` — and pin the **behaviour of the parser**: which
  characteristic of a page wins, which Platform_Status it produces, and that a Captcha is detected and
  never answered. They do not claim that Glassdoor renders this exact markup.
- **That the `relative-dates` wordings all occur on Glassdoor.** Two of its eight cards carry the
  compact day count the captured page actually showed (`6T`, `30T+`); the others carry an ISO
  `datetime` attribute and the German relative forms, which are the shapes the selector tables and
  `parsePublicationDate` support. The case exists to pin 6.4 and 6.8 handling across all of them.

## Replacing a fixture with a captured one

```bash
pnpm build
pnpm fixtures:capture --platform glassdoor --case result-list-page-1 --force
```

The capture needs `USER_AGENT_CONTACT` in `.env`, performs exactly one real Result_Page retrieval,
evaluates the robots.txt first and refuses to run under a test runner or in CI. Afterwards re-read the
expectation file in the diff, set its `provenance` to `CAPTURED`, and update
`docs/adapters/glassdoor.md` including the review date (14.7).

## Why this folder is never formatted

The repository-wide `.prettierignore` excludes `**/__fixtures__/`. A captured document has to stay
byte-identical to what the Platform served, so neither the HTML nor the JSON beside it is reformatted.
