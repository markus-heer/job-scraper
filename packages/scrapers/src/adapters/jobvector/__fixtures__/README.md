# Jobvector fixtures

Frozen Result_Page of Jobvector plus the expected reading of each one. Served to the adapter by the
fixture server of `src/fixtures/`, so the parser tests run without a browser and without a network
request to the Platform (Requirement 14, design "Platform_Adapter tests against frozen fixtures").

Three files per case:

| File                   | Content                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `<case>.html`          | the document, byte for byte as it is stored                          |
| `<case>.expected.json` | the expected reading: outcome, Platform_Status, raw postings         |
| `<case>.capture.json`  | provenance of a captured document — absent for a hand-authored one   |

## Provenance

**Every document in this folder is hand-authored** (`"provenance": "HAND_AUTHORED"` in its expectation
file), so none carries a `.capture.json` sidecar. A capture was not possible when task 10.2 was
implemented: jobvector.de answered the capture attempt of task 10.1 with `403 Forbidden`, which is the
bot protection Risk 1 of the design predicts, and a refused request yields no document to freeze. The
markup is therefore written against the selector tables of `../parse-result-list.ts` and the search URL
shape of `../result-list-url.ts`, both of which stay provisional until a capture confirms them.

What that means for a reader:

- these fixtures pin the **behaviour of the parser** — which characteristic of a page wins, which fields
  a card yields, when a posting is discarded, which Platform_Status a page produces;
- they do **not** confirm that Jobvector renders this markup, nor that the Platform is reachable at all.
  Only a capture does that. Three of the required cases (`captcha`, `rate-limited`, `layout-changed`)
  stay hand-authored in any case, because no Platform serves them on demand.

## What the readable pages exercise

The documents are written to walk the Jobvector-specific paths of the parser rather than a generic
result list:

- **schema.org microdata.** Every job card is an `itemscope` of `https://schema.org/JobPosting` and
  every field is read through `itemprop`, which is the selector table's first candidate and the one a
  redesign is least likely to drop.
- **Both Posting_Id shapes.** `?jobId=412346` in the query, which is the allow-listed parameter of
  `POSTING_ID_QUERY_PARAMS`, and `/stellenangebote/412347-…/` in the path. `data-jobid` and
  `data-job-id` on the card appear as well, and the card attribute wins over the URL.
- **Both `datePosted` shapes.** `<time itemprop="datePosted" datetime="…">` and
  `<meta itemprop="datePosted" content="…">`, plus a `<time>` without a `datetime` where only the
  visible relative wording is available.
- **The English surface.** Jobvector serves the same result list under `/jobs/` and `/en/jobs/`, so
  `result-list-page-1` and `relative-dates` each carry an English card, including an English date
  wording that states no date and therefore lands in the empty-publication-date path of 6.9.
- **Tracking parameters.** `ref` and `utm_source` on a result link are dropped from the stored source
  URL, so an unchanged Job_Posting keeps its Content_Hash across Scrape_Run.

Replacing a hand-authored document with a captured one:

```bash
pnpm fixtures:capture --platform jobvector --case result-list-page-1 --force
```

then re-read the expectation file in the diff, set its `provenance` to `CAPTURED`, and update
`docs/adapters/jobvector.md` including the review date (14.7).

## Why this folder is never formatted

The repository-wide `.prettierignore` excludes `**/__fixtures__/`. A captured document has to stay
byte-identical to what the Platform served, so neither the HTML nor the JSON beside it is reformatted.
