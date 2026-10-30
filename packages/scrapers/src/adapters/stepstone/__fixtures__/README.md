# Stepstone fixtures

Frozen Result_Page of Stepstone plus the expected reading of each one. Served to the adapter by the
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
file), so none carries a `.capture.json` sidecar. Capturing requires a Playwright browser binary and one
real request to stepstone.de, which was not available when task 9.3 was implemented. The markup is
written against the `data-at` selector tables of `../parse-result-list.ts` and the search URL shape of
`../result-list-url.ts`, both of which are themselves provisional until a capture confirms them.

What that means for a reader:

- these fixtures pin the **behaviour of the parser** — which characteristic of a page wins, which fields
  a card yields, when a posting is discarded, which Platform_Status a page produces;
- they do **not** confirm that Stepstone still renders this markup. Only a capture does that. Three of
  the required cases (`captcha`, `rate-limited`, `layout-changed`) stay hand-authored in any case,
  because no Platform serves them on demand.

Replacing a hand-authored document with a captured one:

```bash
pnpm fixtures:capture --platform stepstone --case result-list-page-1 --force
```

then re-read the expectation file in the diff, set its `provenance` to `CAPTURED`, and update
`docs/adapters/stepstone.md` including the review date (14.7).

## Why this folder is never formatted

The repository-wide `.prettierignore` excludes `**/__fixtures__/`. A captured document has to stay
byte-identical to what the Platform served, so neither the HTML nor the JSON beside it is reformatted.

## `robots.txt` (14.1, 14.2, 13.13)

`robots.txt` is the body `https://www.stepstone.de/robots.txt` served on 2026-10-29 to the honest
Job_Tool user agent, stored byte-identically, with `robots.txt.capture.json` recording the capture,
the applying group, the absence of a `Crawl-delay` and the full decision table.

**It decides a test, never a Scrape_Run.** A real run is gated by the live body that `RobotsCache`
fetches once per Platform, so a rule change by Stepstone takes effect immediately regardless of this
file. What this copy is for is the property test in `../__tests__/result-list-url.test.ts`, which
asserts that *every* URL the builder can produce is one these rules permit — the regression guard for
the defect where four query parameters made every Stepstone retrieval end in
`EXCLUDED_BY_ROBOTS_TXT` having fetched nothing.

**What it does not establish.** That the rules still say this. The stored copy going stale makes the
test's oracle wrong, not the Job_Tool's behaviour; the `@live` smoke test of this Platform is what
notices. Re-capture with the same command and review the diff.

**No Result_Page of this Platform has been captured.** All eight `REQUIRED_FIXTURE_CASES` documents
here are hand-authored, so what they establish is that the parser reads the markup *they* contain —
not that Stepstone serves markup of that shape. `docs/adapters/stepstone.md` records that plainly.
