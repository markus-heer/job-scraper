/**
 * Property 24 of the job-search-tool design: the filters of the posting overview are conjunctive and
 * the default view hides the right postings (8.11, 10.5, 10.6, 10.11).
 *
 * The claim is about *all* stored sets of Job_Posting and *all* filter combinations at once, which
 * is what makes it a property rather than the nine-row data set of
 * `./posting.repository.find-page.integration.test.ts`: every returned Job_Posting meets every set
 * filter simultaneously, no stored Job_Posting that meets them is missing, the marking and the
 * Relevance_Verdict filters act independently of the Posting_Status filter, the default view hides
 * exactly the Job_Posting with the Relevance_Verdict "not relevant" or the Interest_Flag
 * "not interesting", and the well-reachable filter hides the Job_Posting whose Best_Commute_Time is
 * "unknown".
 *
 * **Where the predicate is evaluated, and why.** Against real PostgreSQL, through
 * `PostingRepository.findPage`, rather than against a hand-written evaluator of the `where` shapes
 * `postingWhereOf` emits. The design's oracle compares the reference predicate against "the
 * repository", and two of the clauses above are statements about SQL and about nothing else: 8.11
 * holds because `bestCommuteMinutes <= :threshold` is never true for a stored `NULL`, and the three
 * reachability classes partition the rows only because `IS NULL` is the complement of that
 * comparison. An evaluator written in TypeScript would answer both from its own reading of SQL
 * three-valued logic, so a disagreement between that reading and the engine's — the one failure
 * mode worth catching here — would pass unnoticed. The harness and the two existing read tests both
 * name Properties 24 to 26 as PostgreSQL questions, and this file follows that.
 *
 * `pnpm test` stays offline: the file is an `*.integration.test.ts` and therefore excluded from the
 * unit configuration, like Properties 7 to 9.
 *
 * **The oracle** is a reference predicate over the generated specifications, written from the
 * Requirements rather than from `postingWhereOf`: six independent per-dimension decisions combined
 * with AND, where an absent *and* an empty selection both mean "not set" (10.5), an unset marking or
 * verdict filter becomes the exclusion of 10.11 and 10.6 instead, and the reachability class of a
 * row is derived from its Best_Commute_Time against the generated Commute_Threshold (8.3, 8.11,
 * 8.13). It never looks at a row's Posting_Status when it decides the marking or the verdict clause,
 * which is the independence of 10.5 expressed as code.
 *
 * Three clauses are asserted beyond the set comparison, because each is a statement the comparison
 * alone would let a *shared* misreading slip through:
 *
 * - **Independence of the Posting_Status filter.** Clearing that one filter and intersecting the
 *   result with the rows of the selected Posting_Status has to reproduce the result exactly. A read
 *   that let the status selection change *how* the marking or the verdict filter behaves would
 *   differ here even if the reference predicate made the same mistake.
 * - **The default view and the way back out of it.** Read with no filter at all, and read again with
 *   every Interest_Flag and every Relevance_Verdict explicitly selected: the first is the stored set
 *   minus the hidden rows, the second is the stored set in full. That is "keep it displayable again
 *   through the filter" (10.6, 10.11) — an explicit value replaces the exclusion rather than being
 *   added to it.
 * - **8.11 directly.** Every row behind the well-reachable filter carries a known Best_Commute_Time
 *   of at most the threshold, read off the returned rows.
 *
 * The generated Commute_Threshold stays inside the 5 to 240 minutes of 8.10, and two thirds of the
 * generated commute times are drawn *relative to it*, so the boundary 8.3 calls "at most" is hit in
 * every iteration instead of by luck.
 *
 * Each iteration stores at most 12 Job_Posting, which is below the 25 of 10.9, so one page holds
 * every match and the comparison is against the whole filtered set rather than against its first
 * page — pagination is Property 26. That one page is guarded explicitly: a read whose page held
 * fewer rows than it counted would fail before the set comparison is made.
 *
 * Every iteration clears the store and recreates its two Scrape_Run, because a Job_Posting needs its
 * recording run as a foreign key (11.1). Two runs rather than one, and the latest completed one is
 * passed in, so the read takes its grouped path (11.3): the filter then has to hold inside both
 * group queries, and a conjunct dropped in one of the two halves is caught.
 */

// Feature: job-search-tool, Property 24 - Filters are conjunctive and the default view hides the right postings

import {
  computeContentHash,
  INTEREST_FLAGS,
  type InterestFlag,
  type Platform,
  PLATFORMS,
  POSTING_STATUSES,
  type PostingStatus,
  RELEVANCE_RANK,
  RELEVANCE_VERDICTS,
  type RelevanceVerdict,
} from '@job-scraper/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { usePostgres } from '../../testing/postgres-harness';
import {
  SEEDED_RUN_ID,
  SEEDED_RUN_STARTED_AT,
  seedScrapeRun,
} from '../../testing/posting-store.fixture';
import { PostingRepository } from '../posting.repository';
import {
  DEFAULT_POSTING_SORT,
  POSTING_PAGE_SIZE,
  type PostingFilter,
  REACHABILITIES,
  type Reachability,
} from '../posting-page-query';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** Stored Job_Posting per iteration, kept below the 25 of 10.9 so one page holds every match. */
const MAX_POSTINGS = 12;

/** The second Scrape_Run of an iteration, so both "neu" groups of 11.3 can be non-empty. */
const EARLIER_RUN_ID = '33333333-3333-4333-8333-333333333333';

/** The earlier run started a day before the one the marking refers to. */
const EARLIER_RUN_STARTED_AT = new Date(SEEDED_RUN_STARTED_AT.getTime() - 24 * 60 * 60_000);

/** Minutes after {@link SEEDED_RUN_STARTED_AT} a generated recording time can land on. */
const MAX_RECORDING_OFFSET = 11;

/** The Best_Commute_Time of a generated Job_Posting, resolved against the threshold at seed time. */
type CommuteSpec =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'relative'; readonly offsetMinutes: number }
  | { readonly kind: 'absolute'; readonly minutes: number };

/** One generated Job_Posting, in the columns the filters of 10.5 read. */
interface PostingSpec {
  readonly platform: Platform;
  readonly postingStatus: PostingStatus;
  readonly interestFlag: InterestFlag;
  readonly relevanceVerdict: RelevanceVerdict;
  readonly commute: CommuteSpec;
  /** Minutes after the reference run's start time; ties are deliberate and harmless here. */
  readonly recordingOffsetMinutes: number;
  /** Whether the reference run recorded it, which is the "neu" marking of 11.2. */
  readonly recordedByLatestRun: boolean;
}

/** A generated Job_Posting with the Posting_Id it is stored and compared under. */
interface SeededSpec extends PostingSpec {
  readonly postingId: string;
}

/**
 * The Best_Commute_Time in minutes, or null for the stored "unknown" of 8.13.
 *
 * A relative specification is what puts a row exactly on, just below and just above the
 * Commute_Threshold in every iteration — the "at most" boundary of 8.3.
 */
const commuteMinutesOf = (commute: CommuteSpec, thresholdMinutes: number): number | null => {
  switch (commute.kind) {
    case 'unknown':
      return null;
    case 'relative':
      return Math.max(1, thresholdMinutes + commute.offsetMinutes);
    case 'absolute':
      return commute.minutes;
  }
};

/** The recording time of a generated Job_Posting. */
const recordedAt = (offsetMinutes: number): Date =>
  new Date(SEEDED_RUN_STARTED_AT.getTime() + offsetMinutes * 60_000);

/**
 * The reachability class of a stored Best_Commute_Time (8.3, 8.11, 8.13).
 *
 * Written from the Requirements, not from `reachabilityWhereOf`: "unknown" is the absent value,
 * "well reachable" is at most the threshold, and everything else is not well reachable. The three
 * are mutually exclusive and cover every row, which is what the reachability filter relies on.
 */
const reachabilityOf = (
  bestCommuteMinutes: number | null,
  thresholdMinutes: number,
): Reachability => {
  if (bestCommuteMinutes === null) {
    return 'UNKNOWN';
  }

  return bestCommuteMinutes <= thresholdMinutes ? 'WELL_REACHABLE' : 'NOT_WELL_REACHABLE';
};

/** A filter member that is set: present and non-empty. Both other readings mean "not set" (10.5). */
const isSet = <TValue>(values: readonly TValue[] | undefined): values is readonly TValue[] =>
  values !== undefined && values.length > 0;

/**
 * The reference predicate: does this Job_Posting belong in the result of that filter?
 *
 * Six independent decisions, combined with AND (10.5). The two with a default view decide without
 * reading the Posting_Status at all, which is the independence 10.5 and 10.11 ask for.
 */
const matchesFilter = (
  spec: SeededSpec,
  filter: PostingFilter,
  thresholdMinutes: number,
): boolean => {
  const platformMatches = !isSet(filter.platforms) || filter.platforms.includes(spec.platform);

  const statusMatches =
    !isSet(filter.postingStatuses) || filter.postingStatuses.includes(spec.postingStatus);

  // 10.11: no marking filter means the default view, which hides "not interesting"; an explicit
  // selection replaces that exclusion instead of being added to it.
  const interestMatches = isSet(filter.interestFlags)
    ? filter.interestFlags.includes(spec.interestFlag)
    : spec.interestFlag !== 'NOT_INTERESTING';

  // 10.6: the same rule for the Relevance_Verdict and "not relevant".
  const verdictMatches = isSet(filter.relevanceVerdicts)
    ? filter.relevanceVerdicts.includes(spec.relevanceVerdict)
    : spec.relevanceVerdict !== 'NOT_RELEVANT';

  const reachabilityMatches =
    !isSet(filter.reachability) ||
    filter.reachability.includes(
      reachabilityOf(commuteMinutesOf(spec.commute, thresholdMinutes), thresholdMinutes),
    );

  // 10.5: the recording period, inclusive at both ends and each bound sendable on its own.
  const recordedAtMillis = recordedAt(spec.recordingOffsetMinutes).getTime();
  const fromMatches =
    filter.firstSeenFrom === undefined || recordedAtMillis >= filter.firstSeenFrom.getTime();
  const toMatches =
    filter.firstSeenTo === undefined || recordedAtMillis <= filter.firstSeenTo.getTime();

  return (
    platformMatches &&
    statusMatches &&
    interestMatches &&
    verdictMatches &&
    reachabilityMatches &&
    fromMatches &&
    toMatches
  );
};

/** The Posting_Id the reference predicate selects out of a stored set. */
const expectedIds = (
  specs: readonly SeededSpec[],
  filter: PostingFilter,
  thresholdMinutes: number,
): Set<string> =>
  new Set(
    specs
      .filter((spec) => matchesFilter(spec, filter, thresholdMinutes))
      .map((spec) => spec.postingId),
  );

const commuteArbitrary: fc.Arbitrary<CommuteSpec> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<CommuteSpec>({ kind: 'unknown' }) },
  {
    weight: 2,
    arbitrary: fc
      .integer({ min: -2, max: 2 })
      .map((offsetMinutes) => ({ kind: 'relative', offsetMinutes }) as const),
  },
  {
    weight: 1,
    arbitrary: fc
      .integer({ min: 1, max: 300 })
      .map((minutes) => ({ kind: 'absolute', minutes }) as const),
  },
);

const postingArbitrary = fc.record<PostingSpec>({
  platform: fc.constantFrom(...PLATFORMS),
  postingStatus: fc.constantFrom(...POSTING_STATUSES),
  interestFlag: fc.constantFrom(...INTEREST_FLAGS),
  relevanceVerdict: fc.constantFrom(...RELEVANCE_VERDICTS),
  commute: commuteArbitrary,
  recordingOffsetMinutes: fc.integer({ min: 0, max: MAX_RECORDING_OFFSET }),
  recordedByLatestRun: fc.boolean(),
});

/** Names each generated Job_Posting by its position, so the unique key of 9.2 holds by itself. */
const withPostingIds = (specs: readonly PostingSpec[]): readonly SeededSpec[] =>
  specs.map((spec, index) => ({ ...spec, postingId: `p${String(index)}` }));

/** The stored set of one iteration. */
const postingSetArbitrary: fc.Arbitrary<readonly SeededSpec[]> = fc
  .array(postingArbitrary, { maxLength: MAX_POSTINGS })
  .map(withPostingIds);

/** A selection of one filter dimension: absent, cleared or a subset (10.5). */
const selectionArbitrary = <TValue>(
  values: readonly TValue[],
): fc.Arbitrary<readonly TValue[] | undefined> =>
  fc.option(fc.subarray([...values]), { nil: undefined });

/** A bound of the recording period, placed so that it coincides with stored times often. */
const boundArbitrary = fc.option(
  fc.integer({ min: -1, max: MAX_RECORDING_OFFSET + 1 }).map(recordedAt),
  { nil: undefined },
);

/**
 * One generated filter combination.
 *
 * Each dimension is drawn on its own, so the generator reaches the empty filter — the default view
 * of 10.6 and 10.11 — as well as a `from` after the `to`, which 10.5 answers with the empty result
 * rather than with an error.
 */
const filterArbitrary: fc.Arbitrary<PostingFilter> = fc.record<PostingFilter>({
  platforms: selectionArbitrary(PLATFORMS),
  reachability: selectionArbitrary(REACHABILITIES),
  postingStatuses: selectionArbitrary(POSTING_STATUSES),
  interestFlags: selectionArbitrary(INTEREST_FLAGS),
  relevanceVerdicts: selectionArbitrary(RELEVANCE_VERDICTS),
  firstSeenFrom: boundArbitrary,
  firstSeenTo: boundArbitrary,
});

/** The Commute_Threshold the read is made against, inside the range 8.10 permits. */
const thresholdArbitrary = fc.integer({ min: 5, max: 240 });

/**
 * A stored set that holds every enum value and every commute case at once.
 *
 * Pinned as a generation example so the exhaustive case is exercised in every run: four Platform,
 * both Posting_Status, both Interest_Flag, all four Relevance_Verdict, a commute time on the
 * threshold, one on either side of it and an unknown one, and the row that carries both default-view
 * exclusions together — the row a default view implemented as an OR would leak.
 */
const EXAMPLE_SPECS: readonly PostingSpec[] = [
  {
    platform: 'STEPSTONE',
    postingStatus: 'LISTED',
    interestFlag: 'UNMARKED',
    relevanceVerdict: 'RELEVANT',
    commute: { kind: 'relative', offsetMinutes: 0 },
    recordingOffsetMinutes: 0,
    recordedByLatestRun: true,
  },
  {
    platform: 'JOBVECTOR',
    postingStatus: 'LISTED',
    interestFlag: 'UNMARKED',
    relevanceVerdict: 'UNCERTAIN',
    commute: { kind: 'relative', offsetMinutes: -1 },
    recordingOffsetMinutes: 1,
    recordedByLatestRun: true,
  },
  {
    platform: 'INDEED',
    postingStatus: 'NO_LONGER_LISTED',
    interestFlag: 'UNMARKED',
    relevanceVerdict: 'NOT_ASSESSED',
    commute: { kind: 'relative', offsetMinutes: 1 },
    recordingOffsetMinutes: 2,
    recordedByLatestRun: false,
  },
  {
    platform: 'GLASSDOOR',
    postingStatus: 'LISTED',
    interestFlag: 'NOT_INTERESTING',
    relevanceVerdict: 'RELEVANT',
    commute: { kind: 'unknown' },
    recordingOffsetMinutes: 3,
    recordedByLatestRun: false,
  },
  {
    platform: 'STEPSTONE',
    postingStatus: 'NO_LONGER_LISTED',
    interestFlag: 'UNMARKED',
    relevanceVerdict: 'NOT_RELEVANT',
    commute: { kind: 'absolute', minutes: 300 },
    recordingOffsetMinutes: 4,
    recordedByLatestRun: true,
  },
  {
    platform: 'INDEED',
    postingStatus: 'NO_LONGER_LISTED',
    interestFlag: 'NOT_INTERESTING',
    relevanceVerdict: 'NOT_RELEVANT',
    commute: { kind: 'unknown' },
    recordingOffsetMinutes: 5,
    recordedByLatestRun: false,
  },
];

/** The Commute_Threshold the pinned example is read against: the default of 8.10. */
const EXAMPLE_THRESHOLD_MINUTES = 60;

/** The filter the pinned example is read under: one value set in every dimension at once. */
const EXAMPLE_FILTER: PostingFilter = {
  platforms: ['STEPSTONE', 'INDEED', 'GLASSDOOR'],
  reachability: ['WELL_REACHABLE', 'UNKNOWN'],
  postingStatuses: ['LISTED', 'NO_LONGER_LISTED'],
  interestFlags: [...INTEREST_FLAGS],
  relevanceVerdicts: [...RELEVANCE_VERDICTS],
  firstSeenFrom: recordedAt(0),
  firstSeenTo: recordedAt(5),
};

const postgres = usePostgres();

/** Writes the two Scrape_Run of an iteration and the generated Job_Posting into the empty store. */
const seedPostings = async (specs: readonly SeededSpec[], thresholdMinutes: number) => {
  await seedScrapeRun(postgres.prisma, { id: EARLIER_RUN_ID, startedAt: EARLIER_RUN_STARTED_AT });
  await seedScrapeRun(postgres.prisma);

  if (specs.length === 0) {
    return;
  }

  await postgres.prisma.jobPosting.createMany({
    data: specs.map((spec) => {
      const title = `Projektmanagerin ${spec.postingId}`;
      const descriptionText = 'Sie steuern Projekte im Bereich Life Science.';
      const bestCommuteMinutes = commuteMinutesOf(spec.commute, thresholdMinutes);

      return {
        platform: spec.platform,
        postingId: spec.postingId,
        title,
        employer: 'Beispiel Pharma GmbH',
        workLocation: 'München',
        publishedAt: null,
        sourceUrl: `https://www.${spec.platform.toLowerCase()}.example/--${spec.postingId}`,
        descriptionText,
        firstSeenAt: recordedAt(spec.recordingOffsetMinutes),
        lastSeenAt: recordedAt(spec.recordingOffsetMinutes),
        firstSeenRunId: spec.recordedByLatestRun ? SEEDED_RUN_ID : EARLIER_RUN_ID,
        postingStatus: spec.postingStatus,
        interestFlag: spec.interestFlag,
        relevanceVerdict: spec.relevanceVerdict,
        // Written from the rank table exactly as both relevance writers do (10.7).
        relevanceRank: RELEVANCE_RANK[spec.relevanceVerdict],
        contentHash: computeContentHash(title, descriptionText),
        bestCommuteMinutes,
        bestCommuteMode: bestCommuteMinutes === null ? null : 'BICYCLE',
        commutePrecision: bestCommuteMinutes === null ? 'UNKNOWN' : 'EXACT',
      };
    }),
  });
};

describe('Property 24: Filters are conjunctive and the default view hides the right postings', () => {
  /**
   * **Validates: Requirements 8.11, 10.5, 10.6, 10.11**
   *
   * For all stored sets of Job_Posting and for all filter combinations, the read returns exactly the
   * Job_Posting the reference predicate selects: every returned one meets every set filter
   * simultaneously and no stored one that meets them all is missing. The marking and the
   * Relevance_Verdict filters act independently of the Posting_Status filter, the default view
   * excludes exactly the Job_Posting with the Relevance_Verdict "not relevant" or the Interest_Flag
   * "not interesting" and an explicit filter value brings them back, and the filter for well
   * reachable postings returns only Job_Posting with a known Best_Commute_Time of at most the
   * Commute_Threshold.
   */
  it('returns exactly the postings every set filter selects, with the default view applied', async () => {
    await fc.assert(
      fc.asyncProperty(
        postingSetArbitrary,
        filterArbitrary,
        thresholdArbitrary,
        async (specs, filter, thresholdMinutes) => {
          await postgres.truncate();
          await seedPostings(specs, thresholdMinutes);

          const repository = new PostingRepository(postgres.prisma);

          /** Reads page 1 under `readFilter` and reports the Posting_Id it holds. */
          const read = async (readFilter: PostingFilter): Promise<Set<string>> => {
            const page = await repository.findPage({
              filter: readFilter,
              sort: DEFAULT_POSTING_SORT,
              page: 1,
              pageSize: POSTING_PAGE_SIZE,
              commuteThresholdMinutes: thresholdMinutes,
              // Set, so the read takes the grouped path of 11.3 and the filter has to hold in both
              // group queries.
              latestCompletedRunId: SEEDED_RUN_ID,
            });

            // The stored set is smaller than one page, so this page is the whole filtered result —
            // the premise every comparison below rests on.
            expect(page.items).toHaveLength(page.totalCount);

            return new Set(page.items.map((item) => item.postingId));
          };

          // 10.5, 10.6, 10.11: the result is exactly the set the reference predicate selects. Set
          // equality is both halves of the claim at once — nothing returned that fails a filter,
          // nothing missing that passes them all.
          const returned = await read(filter);

          expect(returned).toEqual(expectedIds(specs, filter, thresholdMinutes));

          // 10.5: the marking and the verdict filters act independently of the Posting_Status
          // filter. Dropping that one filter and intersecting with the selected Posting_Status
          // reproduces the same set, so the status selection changes nothing but its own conjunct.
          const withoutStatus = { ...filter, postingStatuses: undefined };
          const statusMatched = new Set(
            specs
              .filter(
                (spec) =>
                  !isSet(filter.postingStatuses) ||
                  filter.postingStatuses.includes(spec.postingStatus),
              )
              .map((spec) => spec.postingId),
          );
          const intersected = new Set(
            [...(await read(withoutStatus))].filter((id) => statusMatched.has(id)),
          );

          expect(intersected).toEqual(returned);

          // 10.6, 10.11: the default view is the stored set minus the hidden Job_Posting, whatever
          // their Posting_Status, and selecting every value explicitly brings every one of them back.
          const defaultView = await read({});
          const allSelected = await read({
            interestFlags: [...INTEREST_FLAGS],
            relevanceVerdicts: [...RELEVANCE_VERDICTS],
          });

          expect(defaultView).toEqual(
            new Set(
              specs
                .filter(
                  (spec) =>
                    spec.interestFlag !== 'NOT_INTERESTING' &&
                    spec.relevanceVerdict !== 'NOT_RELEVANT',
                )
                .map((spec) => spec.postingId),
            ),
          );
          expect(allSelected).toEqual(new Set(specs.map((spec) => spec.postingId)));

          // 8.11: behind the well-reachable filter there is no unknown Best_Commute_Time and no
          // value above the Commute_Threshold. Read off the returned rows, so the engine's reading
          // of the comparison is what answers.
          const wellReachable = await repository.findPage({
            filter: { reachability: ['WELL_REACHABLE'] },
            sort: DEFAULT_POSTING_SORT,
            page: 1,
            pageSize: POSTING_PAGE_SIZE,
            commuteThresholdMinutes: thresholdMinutes,
            latestCompletedRunId: SEEDED_RUN_ID,
          });

          for (const item of wellReachable.items) {
            expect(item.bestCommuteMinutes).not.toBeNull();
            expect(item.bestCommuteMinutes).toBeLessThanOrEqual(thresholdMinutes);
          }
        },
      ),
      {
        ...PROPERTY_RUNS,
        examples: [[withPostingIds(EXAMPLE_SPECS), EXAMPLE_FILTER, EXAMPLE_THRESHOLD_MINUTES]],
      },
    );
  });
});
