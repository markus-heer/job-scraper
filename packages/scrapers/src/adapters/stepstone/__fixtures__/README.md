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
