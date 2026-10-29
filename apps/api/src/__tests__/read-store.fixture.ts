/**
 * In-memory stand-ins for the three Posting_Store delegates the read layer reads.
 *
 * Shared by `./read-layer.graphql.test.ts`, which boots the real resolvers, services and repository
 * over them. Deliberately not an in-memory query engine: a stand-in that filtered, sorted and cut
 * the rows itself would assert its own reading of the query instead of PostgreSQL's, and those
 * questions are already asked elsewhere — the filter and sort rules in
 * `../posting/__tests__/posting-page-query.test.ts`, the SQL semantics in the integration suite.
 *
 * What it does model faithfully is the part the booted test is about:
 *
 * - **How often each read was issued.** The reference run of the "neu" marking has to be selected
 *   once per request and the two batched edges once per request each, so the counters below are the
 *   assertions of the suite rather than an aid to it.
 * - **The two grouping filters of 11.3.** `firstSeenRunId` as an equality and as a `not` are applied,
 *   so the grouped read returns the marked postings first and a wrong group filter shows up as a
 *   wrong order instead of passing unnoticed. Every other filter term is ignored.
 * - **The window of a page.** `skip` and `take` are applied, so a page read stays a page read.
 *
 * Not a test file: the name keeps it out of the Vitest discovery pattern.
 */

import type {
  JobPosting,
  Platform,
  PlatformStatus,
  RunOutcome,
  RunStatus,
  ScrapeRun,
  ScrapeRunPlatformResult,
} from '../prisma/prisma.types';
import type { ScrapeRunReadStore } from '../scrape-run/scrape-run-read.service';

/** A stored `ScrapeRun` row as a test seeds it. */
export interface SeedRun {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: RunStatus;
  readonly runOutcome: RunOutcome | null;
}

/** A stored `ScrapeRunPlatformResult` row as a test seeds it. */
export interface SeedPlatformResult {
  readonly runId: string;
  readonly platform: Platform;
  readonly platformStatus: PlatformStatus;
  readonly newPostings: number;
  readonly updatedPostings: number;
}

/** A stored `JobPosting` row as a test seeds it; every other column takes its declared default. */
export interface SeedPosting {
  readonly id: string;
  readonly title: string;
  readonly firstSeenRunId: string;
  readonly bestCommuteMinutes?: number | null;
  readonly bestCommuteMode?: JobPosting['bestCommuteMode'];
  readonly descriptionText?: string | null;
}

/** The two configuration values the read layer asks `AppConfigService` for (8.10). */
export interface ReadConfigStub {
  readonly homeAddress: string;
  readonly commuteThresholdMinutes: number;
}

/** The stand-in store with its seeders and the counters the booted test asserts on. */
export interface ReadStoreFixture {
  readonly store: ScrapeRunReadStore;
  readonly config: ReadConfigStub;
  seedRun(run: SeedRun): void;
  seedPlatformResult(result: SeedPlatformResult): void;
  seedPosting(posting: SeedPosting): void;
  /** How often the most recently completed Scrape_Run was selected. */
  completedRunSelections(): number;
  /** The identifier lists the `firstSeenRun` loader asked for, one entry per batch. */
  runBatchReads(): readonly (readonly string[])[];
  /** The identifier lists the `platformResults` loader asked for, one entry per batch. */
  platformResultBatchReads(): readonly (readonly string[])[];
  /** One entry per `JobPosting` count, so the two group counts of 11.3 are visible. */
  postingCountFilters(): readonly unknown[];
}

/** The `where` terms this stand-in understands; everything else matches every row. */
interface PostingWhere {
  readonly AND?: readonly PostingWhere[];
  readonly firstSeenRunId?: string | { readonly not: string };
  readonly id?: { readonly in?: readonly string[] };
}

/** The columns `schema.prisma` declares for every column a test does not seed. */
const postingDefaults = (seed: SeedPosting): JobPosting => ({
  id: seed.id,
  platform: 'STEPSTONE',
  postingId: seed.id,
  title: seed.title,
  employer: 'Beispiel GmbH',
  workLocation: 'München',
  publishedAt: null,
  sourceUrl: `https://www.stepstone.de/stellenangebote--${seed.id}`,
  descriptionText: seed.descriptionText ?? null,
  firstSeenAt: new Date('2026-03-02T06:00:00.000Z'),
  lastSeenAt: new Date('2026-03-02T06:00:00.000Z'),
  firstSeenRunId: seed.firstSeenRunId,
  postingStatus: 'LISTED',
  interestFlag: 'UNMARKED',
  relevanceVerdict: 'NOT_ASSESSED',
  relevanceReason: null,
  relevanceModel: null,
  relevanceAssessedAt: null,
  relevanceSetManually: false,
  relevanceRank: 2,
  contentHash: `hash-${seed.id}`,
  relevanceContentHash: null,
  bicycleMinutes: null,
  transitMinutes: null,
  bestCommuteMinutes: seed.bestCommuteMinutes ?? null,
  bestCommuteMode: seed.bestCommuteMode ?? null,
  commutePrecision: 'EXACT',
  commuteLocationInput: 'München',
  commuteCheckedAt: null,
});

/** Whether one row satisfies the terms this stand-in models. See {@link PostingWhere}. */
const matches = (where: PostingWhere | undefined, row: JobPosting): boolean => {
  if (where === undefined) {
    return true;
  }

  if (where.AND !== undefined && !where.AND.every((term) => matches(term, row))) {
    return false;
  }

  const firstSeenRunId = where.firstSeenRunId;

  if (typeof firstSeenRunId === 'string' && row.firstSeenRunId !== firstSeenRunId) {
    return false;
  }

  if (
    typeof firstSeenRunId === 'object' &&
    firstSeenRunId !== null &&
    row.firstSeenRunId === firstSeenRunId.not
  ) {
    return false;
  }

  const ids = where.id?.in;

  return ids === undefined || ids.includes(row.id);
};

/** Creates the three stand-in delegates together with the configuration the read layer reads. */
export const createReadStore = (commuteThresholdMinutes: number): ReadStoreFixture => {
  const runs: ScrapeRun[] = [];
  const platformResults: ScrapeRunPlatformResult[] = [];
  const postings: JobPosting[] = [];

  let completedRunSelections = 0;
  const runBatchReads: string[][] = [];
  const platformResultBatchReads: string[][] = [];
  const postingCountFilters: unknown[] = [];

  const jobPosting = {
    // The argument is optional, because the third counter of 11.5 is a tally of the whole table and
    // is issued as `count()` without one.
    count: (args: { where?: PostingWhere } = {}) => {
      postingCountFilters.push(args.where);

      return Promise.resolve(postings.filter((row) => matches(args.where, row)).length);
    },

    findMany: ({ where, skip, take }: { where?: PostingWhere; skip?: number; take?: number }) => {
      const selected = postings.filter((row) => matches(where, row));
      const from = skip ?? 0;

      return Promise.resolve(selected.slice(from, take === undefined ? undefined : from + take));
    },

    findUnique: ({ where }: { where: { id: string } }) =>
      Promise.resolve(postings.find((row) => row.id === where.id) ?? null),
  };

  const scrapeRun = {
    findFirst: ({
      where,
    }: {
      where: { status?: RunStatus; runOutcome?: RunOutcome; finishedAt?: { not: null } };
    }) => {
      if (where.runOutcome === 'COMPLETED') {
        completedRunSelections += 1;

        const completed = runs
          .filter(
            (row) =>
              row.status === 'FINISHED' &&
              row.runOutcome === 'COMPLETED' &&
              row.finishedAt !== null,
          )
          .sort(
            (left, right) => (right.finishedAt?.getTime() ?? 0) - (left.finishedAt?.getTime() ?? 0),
          );

        return Promise.resolve(completed.at(0) ?? null);
      }

      const running = runs
        .filter((row) => row.status === where.status)
        .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime());

      return Promise.resolve(running.at(0) ?? null);
    },

    // The one named run of the Log_View (12.2, 12.10). Unfiltered by status and by Run_Outcome, so
    // a running, a cancelled and a recovered run are all answered.
    findUnique: ({ where }: { where: { id: string } }) =>
      Promise.resolve(runs.find((row) => row.id === where.id) ?? null),

    findMany: ({ where, take }: { where?: { id?: { in?: readonly string[] } }; take?: number }) => {
      const ids = where?.id?.in;

      if (ids !== undefined) {
        // The `firstSeenRun` batch. Recorded, because "one query per page" is what the design
        // promises for this edge.
        runBatchReads.push([...ids]);

        return Promise.resolve(runs.filter((row) => ids.includes(row.id)));
      }

      const recent = [...runs].sort(
        (left, right) => right.startedAt.getTime() - left.startedAt.getTime(),
      );

      return Promise.resolve(take === undefined ? recent : recent.slice(0, take));
    },
  };

  const scrapeRunPlatformResult = {
    findMany: ({ where }: { where: { runId?: { in?: readonly string[] } } }) => {
      const ids = where.runId?.in ?? [];

      platformResultBatchReads.push([...ids]);

      return Promise.resolve(platformResults.filter((row) => ids.includes(row.runId)));
    },

    aggregate: ({ where }: { where: { runId: string } }) => {
      const rows = platformResults.filter((row) => row.runId === where.runId);

      return Promise.resolve({
        _sum:
          rows.length === 0
            ? { newPostings: null, updatedPostings: null }
            : {
                newPostings: rows.reduce((sum, row) => sum + row.newPostings, 0),
                updatedPostings: rows.reduce((sum, row) => sum + row.updatedPostings, 0),
              },
      });
    },
  };

  // The delegates carry far more methods than the read layer calls; only the ones above are
  // modelled, and the cast is what keeps the fixture to the surface actually under test.
  const store = {
    jobPosting,
    scrapeRun,
    scrapeRunPlatformResult,
  } as unknown as ScrapeRunReadStore;

  return {
    store,
    config: { homeAddress: 'Hörkherstraße 1d, 80689 München', commuteThresholdMinutes },
    seedRun: (run) =>
      void runs.push({
        id: run.id,
        startedAt: new Date(run.startedAt),
        finishedAt: run.finishedAt === null ? null : new Date(run.finishedAt),
        status: run.status,
        runOutcome: run.runOutcome,
        closedByRecovery: false,
      }),
    seedPlatformResult: (result) =>
      void platformResults.push({
        id: `${result.runId}-${result.platform}`,
        runId: result.runId,
        platform: result.platform,
        platformStatus: result.platformStatus,
        pagesFetched: 1,
        newPostings: result.newPostings,
        updatedPostings: result.updatedPostings,
        partialResult: false,
        missingMandatoryFields: [],
        effectiveProfile: null,
      }),
    seedPosting: (posting) => void postings.push(postingDefaults(posting)),
    completedRunSelections: () => completedRunSelections,
    runBatchReads: () => runBatchReads,
    platformResultBatchReads: () => platformResultBatchReads,
    postingCountFilters: () => postingCountFilters,
  };
};
