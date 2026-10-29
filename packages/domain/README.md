# @job-scraper/domain

The shared domain layer: the closed value lists of the glossary, the search criteria types and the pure helpers that
both `apps/api` and `apps/web` depend on. Nothing in here touches the network, the database or the file system, so every
export is testable without a container.

## Closed value lists

`src/enums.ts` declares each closed value list from the requirements glossary exactly once, as a `const` tuple plus a
union type derived from it:

| Export               | Values | Glossary term     |
| -------------------- | -----: | ----------------- |
| `PLATFORMS`          |      4 | Platform          |
| `PLATFORM_STATUSES`  |     14 | Platform_Status   |
| `POSTING_STATUSES`   |      2 | Posting_Status    |
| `INTEREST_FLAGS`     |      2 | Interest_Flag     |
| `RELEVANCE_VERDICTS` |      4 | Relevance_Verdict |
| `RUN_OUTCOMES`       |      3 | Run_Outcome       |
| `RUN_STATUSES`       |      2 | Scrape_Run status |
| `COMMUTE_MODES`      |      2 | Commute_Mode      |
| `COMMUTE_PRECISIONS` |      3 | Commute_Precision |

The tuple is the single source of truth: the union type is `(typeof TUPLE)[number]`, so a value can never exist in the
type without existing at runtime. Prisma mirrors these lists as database enums, and the enum parity test in `apps/api`
asserts set equality in both directions rather than trusting that the two files were edited together.

`RELEVANCE_RANK` maps the Relevance_Verdict values onto the sort order the posting overview uses — relevant, uncertain,
not assessed, not relevant — and is typed as `Record<RelevanceVerdict, number>` so adding a verdict without ranking it
fails the type check.

## Search criteria types

`src/search-profile/types.ts` holds the Search_Profile shape (`SearchProfile`, `CriterionField`, `EMPLOYMENT_TYPES`) and
the Platform capability declaration. A Platform declares through `definePlatformCapability` which Criterion_Field it can
express in its query (`supportedFields`) and which of those it needs to produce a result list (`mandatoryFields`). The
helper is an identity function whose only job is typing: its `const` type parameters keep the field lists as tuples of
literals, and `TMandatory extends readonly TSupported[number][]` rejects a mandatory field that is not supported.

`PlatformOverrideFor<Capability>` derives from those tuples as `Partial<Pick<SearchProfile, SupportedFields[number]>>`,
which is the mechanism behind Requirement 4.5: a Platform_Override that sets a field its Platform does not support is a
compile error, so `pnpm check-types` and `pnpm build` both fail instead of the mismatch surfacing at scrape time.

## Profile_Resolver

`src/search-profile/profile-resolver.ts` resolves the Default_Search_Profile and the optional Platform_Override of one
Platform into exactly one effective Search_Profile. It is a pure function — no Nest dependency, no I/O, no clock — so
the FOR ALL criteria 5.4 to 5.7 can be driven by fast-check without a testing module or a database.

Per Criterion_Field the Platform supports: the override value wins where the override sets the field (provenance
`OVERRIDE`), otherwise the Default_Search_Profile value is taken (provenance `DEFAULT`). Criteria are emitted in
`supportedFields` order, which makes the result deterministic down to list order, so `effectiveProfilesEqual` can
compare two resolutions by value. A field the Platform does not support never appears.

Two cases are worth knowing before reading the code:

- A supported but **optional** field that neither source carries is omitted rather than invented — there is no value to
  emit. With a complete Default_Search_Profile this never happens, which is why the result carries one entry per
  supported field.
- A supported **mandatory** field in that situation is fatal for the Platform: the resolution returns no profile and an
  error naming the Platform and every missing field, which the API_Service turns into the Platform_Status "incomplete
  configuration".

`defaults` is typed `Partial<SearchProfile>` on purpose. Criterion 5.8 is about the Default_Search_Profile itself
missing a mandatory value, and a total type would make that case unreachable and the error path untestable.

`EffectiveSearchProfile` is structurally the `PrismaJson.EffectiveSearchProfileJson` declared in `apps/api`, so a run
snapshot is persisted without a cast. `formatEffectiveProfile` renders one stable line for the Log_Stream
(`STEPSTONE: jobTitle="Projektmanagerin" (DEFAULT), searchRadiusKm=30 (OVERRIDE)`); the field names and provenance
tokens stay English identifiers because this is the value rendering a German log message embeds, not the message text.

## Layout

```
src/index.ts                    the public surface; consumers import from '@job-scraper/domain' only
src/enums.ts                    closed value lists and the Relevance_Verdict rank
src/search-profile/types.ts     Search_Profile, Criterion_Field and the Platform capability declaration
src/search-profile/profile-resolver.ts   the pure Profile_Resolver and its value-equality and rendering helpers
```

`tsconfig.json` type-checks the sources, the tests and the Vitest config without emitting; `tsconfig.build.json` narrows
the inputs to `src/` and emits `dist/` with declarations. Apps type-check against the built output, so `pnpm build` runs
here before any consumer.
