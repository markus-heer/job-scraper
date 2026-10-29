---
inclusion: fileMatch
fileMatchPattern: '{apps/api/src/relevance/**,apps/api/src/commute/anthropic-location.*,apps/api/src/commute/location-normalizer.port.ts,apps/api/src/commute/fixture-location.normalizer.ts,apps/api/src/commute/commute.module.ts,apps/api/src/platform-config/**,apps/api/src/config/env.schema.ts,packages/domain/src/search-profile/**,packages/domain/src/hash/**,.env.example}'
---

# Relevance_Service and the Search_Profile constants

This document answers Requirements 16.6 and 16.7: how the Relevance_Service builds a prompt,
what response shape it accepts, when a stored assessment is reused, which cost limits bound a
Scrape_Run, what happens without an API key — and where the Default_Search_Profile and every
Platform_Override live, plus what it takes for a change to them to take effect. It is written
for a developer about to change the search criteria or tune what a Scrape_Run spends at the
AI_Provider. Capitalised terms are defined in the glossary of
`.kiro/specs/job-search-tool/requirements.md` and are used unchanged (16.10).

`inclusion: fileMatch` is deliberate, and it is the one choice the two `always` documents in
this directory do not already cover. `project-context.md` carries the language convention and
`local-development.md` the quality gate; both decide something about *every* change, so
neither can be scoped. This document decides nothing about a change to a Platform_Adapter, a
React component or the Log_Stream. It is needed exactly while one of two areas is open — the
`relevance/` module with its configuration keys, or the `search-profile/` package with the
Platform configuration that reads it — and those areas are a file pattern. The pattern above
names them, plus `packages/domain/src/hash/`, because the content hash is the caching gate,
`.env.example`, because the cost limits are documented there, and the five Location_Normalizer
files of `apps/api/src/commute/`, because 15.17 permits the AI_Provider for exactly two uses
and the second one is bound there by the same `RELEVANCE_ENABLED` switch. The rest of
`commute/` — the attempt chain, the caches, the Routing_Provider — is deliberately not named:
none of it has anything to do with the AI_Provider.

Two further Steering_Docs are deliberately not repeated here: the conventions every
Platform_Adapter follows (which Criterion_Field a Platform can express in a query is declared
in `capabilities.ts`, described below, but how an adapter *uses* it is theirs), and the start
flow and quality gate in `local-development.md`.

## Part A — Relevance_Service

### Where the pieces are

Everything in this part lives in `apps/api/src/relevance/`.

| File                             | What it owns                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `relevance-assessor.port.ts`     | The seam: `RelevanceAssessor`, `RelevanceOutcome`, the response schema, every shared bound  |
| `anthropic-relevance.assessor.ts`| One AI_Provider request: prompt construction, HTTP, reading the answer                      |
| `anthropic-relevance.schema.ts`  | The wire contract: the tool definition and the Messages API envelope                        |
| `relevance.service.ts`           | Retry chain, run budget, concurrency bound, the deactivated case                            |
| `relevance-enrichment.service.ts`| Candidate selection, the Posting_Store write, the per-Job_Posting Log_Stream lines           |
| `content-hash-gate.ts`           | `needsRelevanceAssessment` — the one condition that decides whether a request is sent       |
| `persisted-relevance.ts`         | One decision as the six `JobPosting` relevance columns                                      |
| `noop-relevance.assessor.ts`     | The deactivated Relevance_Service                                                           |
| `fixture-relevance.assessor.ts`  | The E2E double, selected by `SCRAPER_FIXTURE_MODE`                                          |
| `relevance.module.ts`            | Which of the three assessors `RELEVANCE_ASSESSOR` is bound to                               |

The split is worth knowing before changing anything: the assessor performs one request and
reports a code, the Relevance_Service turns codes into verdicts, and the enrichment stage is
the only part that reads or writes the Posting_Store. An assessor never throws — every way a
request can come to nothing is a value of `RelevanceOutcome`.

### Prompt construction

Two parts, both built in `AnthropicRelevanceAssessor`.

The system prompt is the exported constant `RELEVANCE_SYSTEM_PROMPT`. It is English per the
language convention and states the German output requirement explicitly, names the four
factors to judge (field of expertise, seniority level, work location against the search area,
staffing-agency placement versus direct permanent employment), requires exactly one call of
the `report_relevance` tool, and closes with the sentence that makes the advertisement text
data rather than instruction.

The user message is `userMessage`, and it carries the five posting fields of 15.2 plus the
benchmark and nothing else — no Posting_Id, no source URL, no Platform name:

```
<advertisement>
<title>…</title>
<employer>…</employer>
<work_location>…</work_location>
<publication_date>…</publication_date>
<description>
…
</description>
</advertisement>
<search_profile>
- jobTitle: "Projektmanagerin"
- searchRadiusKm: 30
…
</search_profile>
```

Four rules to keep when editing it:

- **An absent optional field is rendered, not omitted.** It becomes `unknown`
  (`UNKNOWN_FIELD_VALUE`), so a missing employer cannot be read as a stated one.
- **The publication date is the UTC calendar date only.** The clock time carries no relevance
  signal; an unparsable date becomes `unknown` rather than `Invalid Date`.
- **The description arrives already truncated.** `truncateDescription` in the port cuts it to
  `RELEVANCE_DESCRIPTION_MAX_LENGTH` (4,000 characters), hard, without an ellipsis. The
  assessor does not truncate again, so the bound is stated in exactly one place.
- **The benchmark is one line per Criterion_Field, value JSON-encoded**, in the order the
  Profile_Resolver emitted them. The `FieldProvenance` is deliberately left out: whether a
  value came from the Default_Search_Profile or from a Platform_Override is the Job_Tool's
  bookkeeping and no part of a relevance judgement.

The request is a POST to `https://api.anthropic.com/v1/messages` with the key in the
`x-api-key` header, `anthropic-version: 2023-06-01`, `temperature: 0`
(`ANTHROPIC_TEMPERATURE`), `max_tokens: 1024` (`ANTHROPIC_MAX_OUTPUT_TOKENS`), the model from
`ANTHROPIC_MODEL` or `DEFAULT_ANTHROPIC_MODEL` (`claude-sonnet-4-5`) when that is blank, and
`tool_choice: { type: 'tool', name: 'report_relevance' }`.

It goes through a plain injectable `fetch` behind the `ANTHROPIC_FETCH` token
(`type AnthropicFetch`), not through `@anthropic-ai/sdk`. That is load-bearing rather than
incidental: the SDK brings its own retry and timeout behaviour, which would sit *underneath*
the attempt count below and quietly make "at most twice" mean something else. It also keeps
the whole unit suite offline without an HTTP interceptor. If you reach for the SDK, you are
changing the retry semantics the requirements name.

### The expected structured response format

The answer is a tool call, never prose. `RELEVANCE_TOOL_DEFINITION` in
`anthropic-relevance.schema.ts` is the single tool the model may call, and its `input_schema`
is the whole contract:

```jsonc
{
  "name": "report_relevance",
  "input_schema": {
    "type": "object",
    "properties": {
      "verdict": { "type": "string", "enum": ["RELEVANT", "NOT_RELEVANT", "UNCERTAIN"] },
      "reason": { "type": "string", "maxLength": 300 }
    },
    "required": ["verdict", "reason"],
    "additionalProperties": false
  }
}
```

The enum and the length bound are derived from `ASSESSED_RELEVANCE_VERDICTS` and
`RELEVANCE_REASON_MAX_LENGTH` in the port, so the tool the model sees and the schema the
answer is checked against cannot drift apart. `NOT_ASSESSED` is **not** in the enum: it is
the Job_Tool's own record of "no usable answer arrived", and letting a model return it would
make that indistinguishable from `UNCERTAIN`.

Reading an answer is two gates. `anthropicMessageResponseSchema` accepts the envelope —
`model` (optional), `stop_reason` (nullish), `content` (array of blocks) — and drops
everything else; `reportRelevanceToolInput` finds the first `tool_use` block named
`report_relevance`; `parseRelevanceResponse` runs `relevanceResponseSchema`
(`verdict` enum, `reason` 1 to 300 characters) over its `input`, which stays typed `unknown`
until then. Unknown extra properties are stripped rather than rejected.

**A malformed response is `SCHEMA_VIOLATION`**, and that covers all three ways to be unusable:
an envelope that is not a Messages answer, an answer with no `report_relevance` tool call
(prose, a refusal, an output cut short by `max_tokens`), and a tool input the response schema
rejects. It is **not retried** — an identical second request is unlikely to produce a
different shape. The Job_Posting is stored with the Relevance_Verdict `NOT_ASSESSED` plus the
German note of `relevance.schemaViolation`, and the enrichment stage writes that Log_Stream
line after the write.

The other failures are codes of `RelevanceFailureCode`, and the split that matters is
retriability. `TIMEOUT`, `RATE_LIMIT` and `TRANSPORT` describe a request that may succeed
unchanged, so they are repeated; `SCHEMA_VIOLATION` and `NO_API_KEY` are final. The bounds,
all exported from the port:

| Constant                          | Value            | What it bounds                                      |
| --------------------------------- | ---------------- | --------------------------------------------------- |
| `RELEVANCE_REQUEST_TIMEOUT_MS`    | `30_000`         | One request, combined with the Scrape_Run's signal  |
| `RELEVANCE_MAX_ATTEMPTS`          | `3`              | Requests per Job_Posting: one plus two repetitions  |
| `RELEVANCE_RETRY_BACKOFF_MS`      | `[1_000, 4_000]` | One interval per repetition                         |
| `RELEVANCE_REASON_MAX_LENGTH`     | `300`            | The stored Relevance_Reason, matching its column     |
| `RELEVANCE_DESCRIPTION_MAX_LENGTH`| `4_000`          | The transmitted description text                    |

`RATE_LIMIT` is HTTP 429 **and** 529 (`ANTHROPIC_RATE_LIMIT_STATUSES`): the provider's
"overloaded" status describes the same situation from the other side and is answered the same
way, by waiting.

### Caching: the content hash gate

An assessment is reused when the posting's content has not changed. The whole condition is
`needsRelevanceAssessment` in `content-hash-gate.ts`:

```ts
!row.relevanceSetManually &&
  (row.relevanceContentHash === null || row.relevanceContentHash !== row.contentHash);
```

`contentHash` is the hash of the currently stored title and description text;
`relevanceContentHash` is the hash the *stored assessment* was based on. Equal means a stored
assessment covers the current content, so no request is sent and the stored Relevance_Verdict,
Relevance_Reason, model name and assessment time are retained.

Both values come from `computeContentHash(title, descriptionText)` in
`packages/domain/src/hash/content-hash.ts`: SHA-256, lowercase hex, over the normalized title
and description joined by a NUL separator. Each part is normalized to Unicode NFC with every
whitespace run collapsed to a single space and the ends trimmed. That is what makes a Platform
reflowing its markup free while a changed sentence costs a re-assessment, and the NUL
separator is what keeps a word moved from the end of the title to the start of the description
from hashing the same.

**One detail to get right before you touch `persisted-relevance.ts`:
`relevanceContentHash` is written `null` for every `NOT_ASSESSED` outcome** — a failed, a
discarded, a budget-skipped and a never-sent assessment alike. Only an assessment that
actually happened records the content it was about. That leaves the gate open, so the next
Scrape_Run asks again; writing the hash on a failure would close the gate on a Job_Posting
that was never assessed and no run would ever retry it. 15.11 and 15.12 both end in
"continue", not in "give up for good". `relevanceModel` and `relevanceAssessedAt` are `null`
for the same reason: a Job_Posting showing an assessment time but no verdict would claim an
assessment the data does not contain.

A cancelled Job_Posting is the one case that is not written at all. Its columns stay as they
are and the Relevance_Service counts it as outstanding, because a closed enrichment window is
a statement about the Scrape_Run and not a verdict about a Job_Posting.

### Cost limits

Three keys, all validated in `apps/api/src/config/env.schema.ts` and documented in
`.env.example`. All of them are among the required keys: a missing or empty value stops the
start and is reported by name.

| Key                     | Schema                   | Permitted range     | Default in `.env.example` |
| ----------------------- | ------------------------ | ------------------- | ------------------------- |
| `RELEVANCE_ENABLED`     | `booleanFlag()`          | `true` or `false`   | `true`                    |
| `RELEVANCE_MAX_PER_RUN` | `integerInRange(1, 1_000)` | 1 to 1,000 (integer) | `200`                    |
| `RELEVANCE_CONCURRENCY` | `integerInRange(1, 16)`  | 1 to 16 (integer)   | `4`                       |

`booleanFlag()` accepts the two spellings and nothing else, so a typo is a startup error
rather than a falsy value. `integerInRange` matches digits before converting, so `""` is not
0 and `"4.5"` is not 4 — both are named as invalid instead of silently changing meaning.

`RELEVANCE_MAX_PER_RUN` is the assessments per Scrape_Run of 15.7. `RelevanceService.assessAll`
allocates it **by position in the candidate list, before anything is sent**: candidate *n* is
assessed exactly when *n* < budget, so which Job_Posting are assessed never depends on how
fast the AI_Provider answers. The order is `compareRelevanceCandidates` — oldest `firstSeenAt`
first, `id` as the tie-break — which the candidate query's `orderBy` repeats. Oldest first
means a Job_Posting the budget pushed out of one run is at the front of the next one's list.
A repetition under `RELEVANCE_MAX_ATTEMPTS` is the same assessment asked again and costs one
unit of budget, not three.

`RELEVANCE_CONCURRENCY` is the simultaneous requests of 15.8, applied through the same
`Semaphore` the Scraper_Service bounds its Platform_Adapter with. Every candidate takes a
permit, including the ones the budget skipped, which bounds the Posting_Store writes as well:
a run with 2,000 candidates and a budget of 200 cannot open 1,800 concurrent writes.

What reaches the Log_Stream, and from where:

- `relevance.requestFailed` and `relevance.schemaViolation` — per Job_Posting, written by
  `RelevanceEnrichmentService` after the write. Each also sets the Relevance_Reason, because
  the cause is about that one Job_Posting.
- `relevance.budgetReached` — once per run, naming the number of skipped Job_Posting. No
  Relevance_Reason: a run-level number repeated on 1,800 rows explains nothing.
- The end-of-run counters of 15.16 — once per run, under `RELEVANCE_COUNTERS_LOG_CODE` with
  `relevanceCountersMessageDe` from `relevance.messages.ts`, emitted by
  `ScrapeRunService.reportRelevanceCounters` before the run summary. The German sentence names
  the assessed count, the "not relevant" count and the "not assessed" count; the log detail
  adds `considered`, `requested` and `skippedByBudget`. Zeros are reported rather than
  omitted, because a tally that leaves out its zeros cannot be told apart from one that was
  never taken.

### Without an API key, and with the service deactivated

`RELEVANCE_ASSESSOR` is **always bound**. This is the one place the relevance port differs
from its sibling `LOCATION_NORMALIZER`, which expresses "deactivated" as *no normalizer at
all*: 15.10 requires every Job_Posting to be stored with a verdict even when no AI_Provider
was asked, and 15.14 requires exactly one verdict per Job_Posting in every case, so "not
assessed" is a *result that has to be written* rather than an absent provider.
`RelevanceService` consequently injects the token without `@Optional()` and has one code path
instead of two.

`relevanceAssessorProvider` in `relevance.module.ts` is a factory with three branches, checked
in this order:

1. `relevanceDisabledReasonOf(env) !== null` → `NoopRelevanceAssessor`.
2. `isFixtureMode(env)` → `FixtureRelevanceAssessor` (the E2E double; `SCRAPER_FIXTURE_MODE`).
3. Otherwise → `AnthropicRelevanceAssessor`.

Binding the no-op is what makes "no request" a property of the object graph rather than of a
check inside a request path: with the switch off, no `AnthropicRelevanceAssessor` is
constructed at all, so nothing in the process can send a request and no credential is read
into one. `NoopRelevanceAssessor` holds no configuration, builds no HTTP client and reads no
credential; it answers `{ kind: 'FAILED', code: 'NO_API_KEY' }` and its `model` is the empty
string (`NO_RELEVANCE_MODEL`), because no model answered. The deactivated branch wins over
fixture mode: a fixture-mode run with `RELEVANCE_ENABLED=false` still binds the no-op, since
15.9 is about the user's decision not to have postings assessed.

`relevanceDisabledReasonOf` in `relevance.service.ts` reads the switch before the key:

- `RELEVANCE_ENABLED=false` → `'SWITCHED_OFF'`.
- Activated with a blank `ANTHROPIC_API_KEY` → `'NO_API_KEY'`.

Order matters for the German sentence: telling a user who deliberately switched the service
off to add an API key would be advice for a problem they do not have. Note what the
configuration schema means for the second branch in practice — `ANTHROPIC_API_KEY` is one of
the required keys and is trimmed before validation, so an empty or whitespace-only value stops
the start by name and never reaches a Scrape_Run. **The supported way to run the Job_Tool
without an AI_Provider account is therefore `RELEVANCE_ENABLED=false`, with a placeholder in
`ANTHROPIC_API_KEY` in the style of `.env.example` (`sk-ant-your-api-key`).** The
`NO_API_KEY` reason and the assessor's own blank-key check are the second guard behind that,
for a key that goes missing after startup; keep both.

What the user sees in either case, and it is deliberately little: every Job_Posting keeps the
Relevance_Verdict `NOT_ASSESSED`, the Relevance_Reason stays empty — the deactivation is
reported once per process as `relevance.disabled`, not copied onto every row — and the
Web_App's `RelevanceBadge` (`apps/web/src/components/PostingList/RelevanceBadge/index.tsx`)
**claims no origin at all**: `renderOrigin` shows "manuell gesetzt" when the verdict is the
user's, "durch KI bewertet" when an assessment time is stored, and nothing when neither side
has set the verdict. The landing page states the activation state from
`RelevanceService.activated`. Every other function — the retrieval phase, the Posting_Store
writes, the whole read layer — is unaffected. The commute determination is **almost**
unaffected, and the exception is the second permitted use of the AI_Provider below.

### The second permitted AI_Provider use: the Location_Normalizer (8.6, 8.7, 15.17)

15.17 permits the AI_Provider for the relevance assessment and for the work location
normalization of 8.6, and for nothing else. Both uses live behind one HTTP surface and are
driven by the same `RELEVANCE_ENABLED` switch, so this part of the document covers both.

The normalization side lives in `apps/api/src/commute/`, as the sibling of the relevance files:

| File                               | What it owns                                                          |
| ---------------------------------- | --------------------------------------------------------------------- |
| `location-normalizer.port.ts`      | The seam: `LocationNormalizer` and its three-value outcome             |
| `anthropic-location.normalizer.ts` | One AI_Provider request: prompt, HTTP, reading the answer              |
| `anthropic-location.schema.ts`     | The wire contract: the `report_work_location` tool and its answer gate |
| `fixture-location.normalizer.ts`   | The E2E double, selected by `SCRAPER_FIXTURE_MODE`                    |
| `commute.module.ts`                | `locationNormalizerProvider` — which of the two, or neither           |

`AnthropicLocationNormalizer` takes the host, the path, the version header, the retriable
statuses and the `ANTHROPIC_FETCH` seam from `../relevance/anthropic-relevance.assessor`, and
the Messages envelope from its schema module, rather than restating any of them. That is what
makes 15.17 checkable: `ANTHROPIC_API_BASE_URL` is declared in exactly one file, and
`apps/api/src/__tests__/ai-provider-use.test.ts` asserts that the files naming it or the
credential are exactly the permitted ones. Add a third use and that test names the file.

**The answer is a forced tool call, like the relevance one.** `LOCATION_TOOL_DEFINITION` is the
single tool, its input is `{ outcome: 'PLACE' | 'NO_PLACE', placeName?: string }`, and
`parseLocationResponse` is total over `unknown`. The `outcome` is explicit rather than a
nullable name, and that is load-bearing: `NO_PLACE` is a *result* the Commute_Service records
permanently, while a `PLACE` whose name is blank is no answer at all and becomes `FAILED`. One
confused model answer must not be able to close a work location for good.

#### The three branches of `locationNormalizerProvider`

Checked in the same order and on the same switch as `relevanceAssessorProvider`:

1. `relevanceDisabledReasonOf(env) !== null` → **no normalizer**, the factory answers
   `undefined`.
2. `isFixtureMode(env)` → `FixtureLocationNormalizer`.
3. Otherwise → `AnthropicLocationNormalizer`.

**The deactivated branch is an absent value and not a no-op, and the difference is visible to
the user.** 15.10 and 15.14 force the relevance port to be bound to something always; 8.5 says
the opposite for this one — with the Relevance_Service deactivated, a free-text work location
no rule resolves costs no request, stays "unknown", and **nothing is recorded**, so the value
still gets its single chance of 8.7 once the service is activated. A bound no-op could only
answer `FAILED`, which the enrichment stage maps to `commute.providerFailed` and so blames a
provider nobody asked, or `UNRESOLVABLE`, which is recorded as a permanent dead end and spends
the one chance. The absent value instead takes `CommuteService.normalizeOnce` to
`LOCATION_UNRECOGNIZED`, which is `commute.geocodeFailed` and the wording of 8.5. The
`@Optional()` injection in `CommuteService` is what reads the result, and it stays.

`undefined` rather than leaving the provider out of the array, because the `@Module` decorator
is evaluated at import time, before any configuration value exists.

#### The at-most-once bound of 8.7 is the Commute_Service's

The normalizer keeps no memory and may be called at most once per distinct value. What enforces
that is the `LocationNormalization` table plus the in-flight map in `CommuteService`:

- A `NORMALIZED` answer is geocoded and the row is written with the place name, the coordinate
  and `source: 'AI_PROVIDER'`. A failed geocoding still writes the row with the name alone —
  that row is what spent the request, and losing it would hand the value a second one.
- An `UNRESOLVABLE` answer writes the row with `normalizedName: null` and
  `source: 'AI_PROVIDER'`, which `resolveStored` later reads back as `LOCATION_UNRECOGNIZED`.
- A `FAILED` answer writes **nothing**. A one-minute outage must not cost every Job_Posting at
  that work location its Best_Commute_Time for good; the determination repeats in the next
  Scrape_Run (8.8).
- Two Job_Posting with the same work location enriched concurrently share one request through
  `CommuteService.normalizing`, so the bound holds within a run as well as across runs.

`apps/api/src/commute/__tests__/commute.normalization-binding.test.ts` drives all of that
through the real `CommuteModule` graph with only the two HTTP seams stubbed, which is the test
that would have caught the token being bound in no module at all.

### The manual verdict wins (15.15)

A Relevance_Verdict the user set stays in force over any later service assessment. Four places
enforce it, and all four are needed:

1. `PostingRepository.setRelevanceVerdict` (`apps/api/src/posting/posting.repository.ts`) is
   the **only** writer of `relevanceSetManually`, which it sets to `true`. It also clears
   `relevanceModel` and `relevanceAssessedAt`, because no model produced this verdict — which
   is exactly the distinction the Web_App badge reads.
2. `PostingRepository.writeRelevanceResult` leaves `relevanceSetManually` out of its `data`
   entirely, so an enrichment write can never clear it.
3. `needsRelevanceAssessment` has `!row.relevanceSetManually` as its first term, so no request
   is ever sent for such a Job_Posting.
4. The candidate query in `RelevanceEnrichmentService` narrows to `relevanceSetManually: false`
   before the gate runs.

The Web_App marks it "manuell gesetzt", the string living in
`de.postings.badges.verdictSetManually` in `apps/web/src/i18n/de.ts`.

**Where the user sets it.** `apps/web/src/components/RelevanceVerdictControl`, in the relevance
cell of each row under the badge that states the verdict in force. Until task 25.2 the four
enforcement points above existed and nothing in the Web_App ever sent the mutation — the only
caller was the E2E harness — so half of 15.15 was unreachable. Three things about the control
are decisions rather than details:

- **Three options, not four.** The buttons are built from `ASSESSED_RELEVANCE_VERDICTS`, which
  lives in `packages/domain/src/enums.ts` together with `RELEVANCE_REASON_MAX_LENGTH` so the
  AI_Provider's tool schema and this control read one declaration. `NOT_ASSESSED` is the
  Job_Tool's own record of "no usable answer arrived" and is not the user's to set.
- **The import is from `@job-scraper/domain/enums`, not from the package root.** The root barrel
  re-exports the content hash helper, which reaches `node:crypto`, and the `fast-check`
  arbitraries; a value import from it would pull both into the browser bundle.
- **The reason is the user's own words or nothing.** `reasonDe` comes from an optional text
  field and an empty one sends `null`, which clears the stored Relevance_Reason. The Web_App
  invents no sentence for the column: `relevanceReason` is an API_Service field, and a sentence
  written here would be shown under "Begründung" forever as though somebody had meant it.

### German text and secrets

The German-text ownership rule of `project-context.md` applies here in two spots, and the
ownership table at the top of `apps/web/src/i18n/de.ts` is the authority:

- **`JobPosting.relevanceReason` is the API_Service's**, written by the AI_Provider and stored.
  The Web_App holds no copy; it only owns the heading above it
  (`de.postings.badges.relevanceReasonLabel`) and the two origin markings.
- **`EffectiveCriterion.valueText` is the API_Service's** too — the resolved Criterion_Field
  value as one German line ("Festanstellung", "50 km"), built by
  `apps/api/src/platform-config/criterion-value-text.ts`. The Web_App owns the column titles
  and the two provenance labels of 4.12 (`FIELD_PROVENANCE_LABELS`: "aus Standardprofil",
  "überschrieben"), because the schema publishes the `FieldProvenance` enum and no label for
  it.

The German sentences that explain a relevance failure are rows of
`apps/api/src/common/error-mapping.ts`, never written inline: `relevance.requestFailed`,
`relevance.schemaViolation`, `relevance.budgetReached`, `relevance.disabled`. An assessor
reports a code, not prose.

**No configuration value is ever printed.** `SECRET_ENV_KEYS` in `env.schema.ts` lists
`DATABASE_URL`, `ROUTING_API_KEY` and `ANTHROPIC_API_KEY`, and every output path that reports
configuration replaces them with `SECRET_MASK` (`***`) — masked whole, not shortened, because
a prefix of a key is still key material. `describeEnvConfig` is the logging view that applies
it, and the Log_Stream masks secrets as well. `AnthropicRelevanceAssessor` masks in both
directions through `maskSecretsInText`: the key travels in a header and never in a URL, and
the strings that come *back* from the provider — the reported model name and every top-level
string of the tool input — are masked before they are parsed, because both are stored and both
are shown in the Web_App.

## Part B — Default_Search_Profile and Platform_Override (16.6)

### The constants live in the source code, in one file

**`packages/domain/src/search-profile/constants.ts`** holds all three, and these are the exact
names:

| Constant                  | What it is                                                        |
| ------------------------- | ----------------------------------------------------------------- |
| `DEFAULT_SEARCH_PROFILE`  | The Default_Search_Profile: exactly one typed `SearchProfile` (3.1) |
| `PLATFORM_OVERRIDES`      | Every Platform_Override, at most one per Platform (4.1)            |
| `PLATFORM_ACTIVATION`     | Whether each Platform is activated (4.6)                           |

In the delivered state `DEFAULT_SEARCH_PROFILE` is job title `Projektmanagerin`, six title
synonyms, industry `Pharma and Life Science`, search location `München`, radius 50 km,
`employmentType: 'PERMANENT'`, publication period 30 days. `PLATFORM_OVERRIDES` sets
`STEPSTONE: { searchRadiusKm: 30 }` and
`JOBVECTOR: { searchLocation: 'München', searchRadiusKm: 50 }`; the commented-out `GLASSDOOR`
entry is there on purpose — uncommenting it is a compile error, because Glassdoor does not
declare `employmentType` as supported.

The rest of the package:

| File                 | What it holds                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `types.ts`           | `SearchProfile` (the seven Criterion_Field), `CriterionField`, `EMPLOYMENT_TYPES`, `PlatformCapability`, `definePlatformCapability`, `PlatformOverrideFor` |
| `capabilities.ts`    | `PLATFORM_CAPABILITIES` — per Platform the supported Criterion_Field and the mandatory subset (4.2) — and `PlatformOverrideMap` |
| `profile-resolver.ts`| `resolveSearchProfile`, `FieldProvenance`, `EffectiveCriterion`, `effectiveProfilesEqual`, `formatEffectiveProfile` |
| `validate.ts`        | `validateDefaultSearchProfile` and `PROFILE_VALIDATION_LIMITS`                                  |

`PLATFORM_CAPABILITIES` is what makes 4.5 a compile-time guarantee rather than a runtime check:
each Platform declares `supportedFields` as a literal tuple through
`definePlatformCapability`, and `PlatformOverrideMap` derives each Platform_Override's type
from that tuple. A Platform_Override that sets an unsupported Criterion_Field fails
`pnpm check-types` and keeps the build from succeeding. Glassdoor and Jobvector support fewer
fields than Indeed and Stepstone, so check the declaration before adding one.

### How a value wins, and what is recorded about it

`resolveSearchProfile(platform, defaults, overrides, capabilities?)` walks
`capability.supportedFields` in order and, per field:

- the Platform_Override value where the override sets that field, with
  `provenance: 'OVERRIDE'`;
- otherwise the Default_Search_Profile value, with `provenance: 'DEFAULT'`;
- a supported but *optional* field neither source carries is omitted rather than invented;
- a supported **mandatory** field neither source carries is fatal for that Platform: the
  resolution returns `{ ok: false }` with the Platform and every missing Criterion_Field, and
  the Platform ends up with the Platform_Status "incomplete configuration" while the remaining
  Platform keep being served.

A Criterion_Field the Platform does not support never appears in the result, and the emission
order is `supportedFields` order, which is what makes a resolved profile comparable by value
through `effectiveProfilesEqual`. The `FieldProvenance` the resolver records per criterion is
what the read-only criteria view shows as "aus Standardprofil" or "überschrieben", and what
`formatEffectiveProfile` appends to the Log_Stream line of a configured Platform.

`validateDefaultSearchProfile` runs at API_Service startup against the ranges of
`PROFILE_VALIDATION_LIMITS` — free text 1 to 100 characters, 4 to 20 title synonyms of 2 to
100 characters each, radius an integer 1 to 200 km, publication period 1 to 365 days — and
reports **every** violation at once in German. An invalid Default_Search_Profile stops the
startup with a non-zero exit code (3.6); an incomplete per-Platform configuration does not,
because 4.9 requires the remaining Platform to keep being served.

### A change takes effect by editing the file and restarting the API_Service (3.9)

There is no reload, no watch and no cache invalidation to trigger.

1. Edit `packages/domain/src/search-profile/constants.ts`.
2. Restart the API_Service: Ctrl+C the Start_Script and run `pnpm start` again. Step 6 builds
   through Turborepo, so the changed `@job-scraper/domain` is rebuilt on the way.
3. Open `/criteria` in the Web_App and read the value back.

The restart is not a convention, it is how the state is held. `PlatformConfigurationService`
(`apps/api/src/platform-config/platform-config.service.ts`) calls
`resolvePlatformConfigurations` **in its constructor**, once, and holds the result for the
process lifetime. That is not a cache; the constants cannot change while the process runs, so
resolving once and handing the same answer to every reader *is* the whole truth. Both readers
take it from there — the Scraper_Service, which skips a Platform with an incomplete
configuration, and the `searchCriteria` query behind the criteria view — so the view can never
disagree with what a Scrape_Run does. The startup also writes one German Log_Stream line per
Platform (`platform.configured`, `platform.disabled`,
`platform.incompleteConfiguration`), with the resolved values and their provenance appended in
English identifiers.

### Verifying a change landed: the read-only criteria view

`/criteria` (`apps/web/src/routes/criteria.tsx`) is where a developer checks the result. It
shows, per supported Platform, every resolved Criterion_Field with its German value
(`valueText`) and its provenance, omitting the fields that Platform does not support, plus the
Platform_Status and the missing mandatory field names of an incompletely configured Platform.
It is read-only by design: there is no path from the user interface to these constants.

**This document is what that page points at.** Its hint reads: the search criteria are
constants in the source code, how they are changed is described in the Steering_Docs in
`.kiro/steering`, and a change takes effect after a restart of the Job_Tool
(`de.criteria.changeHint` in `apps/web/src/i18n/de.ts`, Requirement 4.13). The file name and
the constant names above are the answer to that pointer; if this document moves or is renamed,
that hint is what goes stale.

## Checklists

### Changing the search criteria

1. Edit `DEFAULT_SEARCH_PROFILE` or `PLATFORM_OVERRIDES` in
   `packages/domain/src/search-profile/constants.ts`. Only set a Criterion_Field in a
   Platform_Override when it should *differ* from the default.
2. Check `PLATFORM_CAPABILITIES` in `capabilities.ts` first if you are adding a field to an
   override — an unsupported field is a type error, by design.
3. Stay inside `PROFILE_VALIDATION_LIMITS`, or the API_Service will refuse to start and name
   the field.
4. `pnpm check-types`, then the rest of the quality gate from `local-development.md`.
5. Restart with `pnpm start` and read the value back at `/criteria`, provenance included.

### Tuning what a Scrape_Run spends

1. `RELEVANCE_MAX_PER_RUN` (1 to 1,000) caps assessments per Scrape_Run; the Log_Stream names
   how many Job_Posting the cap skipped, and the next run takes them first.
2. `RELEVANCE_CONCURRENCY` (1 to 16) caps simultaneous requests. Lower it when the AI_Provider
   reports rate limits; `RATE_LIMIT` is retried but each repetition costs wall-clock time
   inside the enrichment window.
3. `RELEVANCE_ENABLED=false` switches the assessment off entirely. Every Job_Posting then
   carries `NOT_ASSESSED` and every other function keeps working.
4. Changes to any of the three are read at startup through the validated configuration, so
   restart the API_Service. Never set them as a command prefix — put them in `.env`.
5. Before increasing a limit, check whether the content hash gate is doing its job: a run that
   re-assesses the same Job_Posting repeatedly points at a changing `contentHash`, not at too
   small a budget.

## Related Steering_Docs

- Project context, the operating model, the language convention and the German-text ownership
  table: `project-context.md`.
- The Start_Script, the five quality steps and the test suites: `local-development.md`.
- The conventions every Platform_Adapter follows, including the steps for adding one, and how
  an adapter turns a resolved Criterion_Field into a Platform query.
