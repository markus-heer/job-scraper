/**
 * Integration tests for the paginated read of the posting overview against real PostgreSQL
 * (8.11, 10.5, 10.6, 10.7, 10.9, 10.11).
 *
 * The rules behind the read are asserted without a database in `./posting-page-query.test.ts`, and
 * the wiring in `./posting.repository.find-page.test.ts`. What is left is the half those two cannot
 * answer: whether the engine executes the query the way the rules assume. Three of the claims of
 * 10.7 and 10.9 are statements about SQL and about nothing else —
 *
 * - a Job_Posting with an unknown Best_Commute_Time sorts to the end of the list in *both*
 *   directions, which PostgreSQL does not do by default (it orders `NULL` last ascending and first
 *   descending);
 * - the Relevance_Verdict sorts as relevant, uncertain, not assessed, not relevant, which the enum
 *   column cannot express because PostgreSQL orders an enum by its declaration order — so the
 *   denormalized `relevanceRank` is what the order actually comes out of, and the stored rank has to
 *   agree with `RELEVANCE_RANK` for every verdict value;
 * - the pages partition the filtered result: every entry appears on exactly one page, which is only
 *   true because the order is total. Without the `id` tiebreaker the engine is free to return equal
 *   keys in a different order per statement, and an entry would be able to land on two pages or on
 *   none.
 *
 * A stand-in delegate would answer all three with its own reading instead of the engine's, which is
 * why these cases live here and not in the offline suite. They run in `pnpm test:integration`; the
 * reference-predicate comparison over generated data is task 15.10, and the property-based coverage
 * is Properties 24 to 26 (tasks 15.5 to 15.7).
 *
 * Requirements: 8.11, 10.5, 10.6, 10.7, 10.9, 10.11.
 */

import {
  computeContentHash,
  type InterestFlag,
  type Platform,
  type PostingStatus,
  RELEVANCE_RANK,
  RELEVANCE_VERDICTS,
  type RelevanceVerdict,
} from '@job-scraper/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import { usePostgres } from '../../testing/postgres-harness';
import {
  SEEDED_RUN_ID,
  SEEDED_RUN_STARTED_AT,
  seedScrapeRun,
} from '../../testing/posting-store.fixture';
import { PostingRepository } from '../posting.repository';
import {
  DEFAULT_POSTING_SORT,
  type FindPostingPageInput,
  POSTING_PAGE_SIZE,
} from '../posting-page-query';

/** The Commute_Threshold these reads are made against (8.10). */
const THRESHOLD_MINUTES = 60;

/** One seeded Job_Posting, named by its Posting_Id so a failing expectation names the row. */
interface SeedSpec {
  readonly postingId: string;
  readonly platform: Platform;
  readonly postingStatus: PostingStatus;
  readonly interestFlag: InterestFlag;
  readonly relevanceVerdict: RelevanceVerdict;
  /** Minutes of the Best_Commute_Time, or null for the stored "unknown" of 8.13. */
  readonly bestCommuteMinutes: number | null;
  /** Publication date, or null where none was readable (6.4, 6.9). */
  readonly publishedAt: Date | null;
  /** Minutes after the Scrape_Run start, so the recording times are distinct and ordered. */
  readonly firstSeenOffsetMinutes: number;
}

/**
 * The data set: nine Job_Posting covering every value the filters and the order branch on.
 *
 * Each column varies independently of the others, so a filter that accidentally reads the wrong
 * column fails rather than coincidentally agreeing. The two "unknown" commute times, the missing
 * publication date, the two marked postings and the two "not relevant" ones are the rows the
 * default view and the ordering rules are about; `p9` carries both exclusions at once, which is the
 * row a default view implemented as an OR would leak.
 */
const SEEDS: readonly SeedSpec[] = [
  {
    postingId: 'p1',
    platform: 'STEPSTONE',
    postingStatus: 'LISTED',
    interestFlag: 'UNMARKED',
    relevanceVerdict: 'RELEVANT',
    bestCommuteMinutes: 20,
    publishedAt: new Date('2026-02-20T00:00:00.000Z'),
    firstSeenOffsetMinutes: 0,
  },
  {
    postingId: 'p2',
    platform: 'STEPSTONE',
    postingStatus: 'LISTED',
    interestFlag: 'UNMARKED',
    relevanceVerdict: 'UNCERTAIN',
    // Exactly the threshold, which 8.3 counts as well reachable ("at most").
    bestCommuteMinutes: THRESHOLD_MINUTES,
    publishedAt: new Date('2026-02-21T00:00:00.000Z'),
    firstSeenOffsetMinutes: 1,
  },
  {
    postingId: 'p3',
    platform: 'JOBVECTOR',
    postingStatus: 'LISTED',
    interestFlag: 'UNMARKED',
    relevanceVerdict: 'NOT_ASSESSED',
    // One minute above the threshold: the other side of the same boundary.
    bestCommuteMinutes: THRESHOLD_MINUTES + 1,
    publishedAt: null,
    firstSeenOffsetMinutes: 2,
  },
  {
    postingId: 'p4',
    platform: 'JOBVECTOR',
    postingStatus: 'LISTED',
    interestFlag: 'UNMARKED',
    relevanceVerdict: 'NOT_RELEVANT',
    bestCommuteMinutes: 120,
    publishedAt: new Date('2026-02-23T00:00:00.000Z'),
    firstSeenOffsetMinutes: 3,
  },
  {
    postingId: 'p5',
    platform: 'INDEED',
    postingStatus: 'LISTED',
    interestFlag: 'NOT_INTERESTING',
    relevanceVerdict: 'RELEVANT',
    bestCommuteMinutes: 30,
    publishedAt: new Date('2026-02-24T00:00:00.000Z'),
    firstSeenOffsetMinutes: 4,
  },
  {
    postingId: 'p6',
    platform: 'INDEED',
    postingStatus: 'NO_LONGER_LISTED',
    interestFlag: 'UNMARKED',
    relevanceVerdict: 'RELEVANT',
    bestCommuteMinutes: null,
    publishedAt: new Date('2026-02-25T00:00:00.000Z'),
    firstSeenOffsetMinutes: 5,
  },
  {
    postingId: 'p7',
    platform: 'GLASSDOOR',
    postingStatus: 'LISTED',
    interestFlag: 'UNMARKED',
    relevanceVerdict: 'UNCERTAIN',
    bestCommuteMinutes: null,
    publishedAt: new Date('2026-02-26T00:00:00.000Z'),
    firstSeenOffsetMinutes: 6,
  },
  {
    postingId: 'p8',
    platform: 'GLASSDOOR',
    postingStatus: 'LISTED',
    interestFlag: 'UNMARKED',
    relevanceVerdict: 'NOT_ASSESSED',
    bestCommuteMinutes: 45,
    publishedAt: new Date('2026-02-27T00:00:00.000Z'),
    firstSeenOffsetMinutes: 7,
  },
  {
    postingId: 'p9',
    platform: 'STEPSTONE',
    postingStatus: 'NO_LONGER_LISTED',
    interestFlag: 'NOT_INTERESTING',
    relevanceVerdict: 'NOT_RELEVANT',
    bestCommuteMinutes: 15,
    publishedAt: new Date('2026-02-28T00:00:00.000Z'),
    firstSeenOffsetMinutes: 8,
  },
];

/** The six Job_Posting the default view of 10.6 and 10.11 leaves visible. */
const DEFAULT_VIEW_IDS = ['p1', 'p2', 'p3', 'p6', 'p7', 'p8'] as const;

const postgres = usePostgres();

/** The input of one read, with the parts a test does not vary at their defaults. */
const readInput = (overrides: Partial<FindPostingPageInput> = {}): FindPostingPageInput => ({
  filter: {},
  sort: DEFAULT_POSTING_SORT,
  page: 1,
  pageSize: POSTING_PAGE_SIZE,
  commuteThresholdMinutes: THRESHOLD_MINUTES,
  latestCompletedRunId: SEEDED_RUN_ID,
  ...overrides,
});

/** Minutes after the Scrape_Run start as an absolute instant. */
const recordedAt = (offsetMinutes: number): Date =>
  new Date(SEEDED_RUN_STARTED_AT.getTime() + offsetMinutes * 60_000);

describe('PostingRepository.findPage against PostgreSQL', () => {
  let repository: PostingRepository;

  beforeEach(async () => {
    repository = new PostingRepository(postgres.prisma);

    await seedScrapeRun(postgres.prisma);
    await postgres.prisma.jobPosting.createMany({
      data: SEEDS.map((seed) => {
        const title = `Projektmanagerin ${seed.postingId}`;
        const descriptionText = 'Sie steuern Projekte im Bereich Life Science.';

        return {
          platform: seed.platform,
          postingId: seed.postingId,
          title,
          employer: 'Beispiel Pharma GmbH',
          workLocation: 'München',
          publishedAt: seed.publishedAt,
          sourceUrl: `https://www.${seed.platform.toLowerCase()}.example/--${seed.postingId}`,
          descriptionText,
          firstSeenAt: recordedAt(seed.firstSeenOffsetMinutes),
          lastSeenAt: recordedAt(seed.firstSeenOffsetMinutes),
          firstSeenRunId: SEEDED_RUN_ID,
          postingStatus: seed.postingStatus,
          interestFlag: seed.interestFlag,
          relevanceVerdict: seed.relevanceVerdict,
          // Written from the rank table exactly as both relevance writers do, so the order this
          // read produces is the order a stored assessment would really have produced.
          relevanceRank: RELEVANCE_RANK[seed.relevanceVerdict],
          contentHash: computeContentHash(title, descriptionText),
          bestCommuteMinutes: seed.bestCommuteMinutes,
          bestCommuteMode: seed.bestCommuteMinutes === null ? null : 'BICYCLE',
          commutePrecision: seed.bestCommuteMinutes === null ? 'UNKNOWN' : 'EXACT',
        };
      }),
    });
  });

  /** The Posting_Id of one read, in the order the engine returned them. */
  const idsOf = async (
    overrides: Partial<FindPostingPageInput> = {},
  ): Promise<readonly string[]> => {
    const page = await repository.findPage(readInput(overrides));

    return page.items.map((item) => item.postingId);
  };

  it('hides the "not relevant" and the "not interesting" postings by default (10.6, 10.11)', async () => {
    const page = await repository.findPage(readInput());

    // Newest first recording first, which is the default sorting of 10.7.
    expect(page.items.map((item) => item.postingId)).toEqual([...DEFAULT_VIEW_IDS].reverse());
    expect(page.totalCount).toBe(DEFAULT_VIEW_IDS.length);
    expect(page.pageCount).toBe(1);
  });

  it('shows a hidden posting again through an explicit filter value (10.6, 10.11)', async () => {
    await expect(idsOf({ filter: { relevanceVerdicts: ['NOT_RELEVANT'] } })).resolves.toEqual([
      'p4',
    ]);
    await expect(idsOf({ filter: { interestFlags: ['NOT_INTERESTING'] } })).resolves.toEqual([
      'p5',
    ]);

    // Both exclusions lifted at once is the only way to reach `p9`, which carries both.
    await expect(
      idsOf({
        filter: { relevanceVerdicts: ['NOT_RELEVANT'], interestFlags: ['NOT_INTERESTING'] },
      }),
    ).resolves.toEqual(['p9']);
  });

  it('applies the marking and verdict filters independently of the Posting_Status filter (10.5)', async () => {
    await expect(
      idsOf({
        filter: {
          postingStatuses: ['NO_LONGER_LISTED'],
          interestFlags: ['NOT_INTERESTING'],
          relevanceVerdicts: [...RELEVANCE_VERDICTS],
        },
      }),
    ).resolves.toEqual(['p9']);
  });

  it('meets every set filter simultaneously (10.5)', async () => {
    await expect(
      idsOf({
        filter: {
          platforms: ['STEPSTONE', 'GLASSDOOR'],
          postingStatuses: ['LISTED'],
          firstSeenFrom: recordedAt(1),
          firstSeenTo: recordedAt(7),
        },
      }),
    ).resolves.toEqual(['p8', 'p7', 'p2']);
  });

  it('includes both bounds of the recording period (10.5)', async () => {
    await expect(
      idsOf({ filter: { firstSeenFrom: recordedAt(1), firstSeenTo: recordedAt(2) } }),
    ).resolves.toEqual(['p3', 'p2']);
  });

  it('hides the unknown and the far postings behind the well-reachable filter (8.11, 10.5)', async () => {
    await expect(idsOf({ filter: { reachability: ['WELL_REACHABLE'] } })).resolves.toEqual([
      // 45 and 60 minutes; 60 is "at most the threshold" and therefore included (8.3).
      'p8',
      'p2',
      'p1',
    ]);
  });

  it('offers the unknown and the not-well-reachable postings as their own filter values (10.5)', async () => {
    await expect(idsOf({ filter: { reachability: ['UNKNOWN'] } })).resolves.toEqual(['p7', 'p6']);
    await expect(idsOf({ filter: { reachability: ['NOT_WELL_REACHABLE'] } })).resolves.toEqual([
      'p3',
    ]);
    await expect(
      idsOf({ filter: { reachability: ['UNKNOWN', 'NOT_WELL_REACHABLE'] } }),
    ).resolves.toEqual(['p7', 'p6', 'p3']);
  });

  it('places an unknown Best_Commute_Time at the end of the list in both directions (10.7)', async () => {
    const ascending = await idsOf({
      sort: { field: 'BEST_COMMUTE_MINUTES', direction: 'ASC' },
    });
    const descending = await idsOf({
      sort: { field: 'BEST_COMMUTE_MINUTES', direction: 'DESC' },
    });

    // 20, 45, 60, 61 — then the two postings without a Best_Commute_Time, in either order, because
    // their sort key is equal and only the unique tiebreaker separates them.
    expect(ascending.slice(0, 4)).toEqual(['p1', 'p8', 'p2', 'p3']);
    expect(new Set(ascending.slice(4))).toEqual(new Set(['p6', 'p7']));

    expect(descending.slice(0, 4)).toEqual(['p3', 'p2', 'p8', 'p1']);
    expect(new Set(descending.slice(4))).toEqual(new Set(['p6', 'p7']));
  });

  it('places a missing publication date at the end of the list in both directions', async () => {
    const ascending = await idsOf({ sort: { field: 'PUBLISHED_AT', direction: 'ASC' } });
    const descending = await idsOf({ sort: { field: 'PUBLISHED_AT', direction: 'DESC' } });

    expect(ascending).toEqual(['p1', 'p2', 'p6', 'p7', 'p8', 'p3']);
    expect(descending).toEqual(['p8', 'p7', 'p6', 'p2', 'p1', 'p3']);
  });

  it('orders the Relevance_Verdict as 10.7 prescribes, out of the stored rank', async () => {
    const page = await repository.findPage(
      readInput({ sort: { field: 'RELEVANCE', direction: 'ASC' } }),
    );

    // relevant before uncertain before not assessed; "not relevant" is absent from the default
    // view, so the fourth group is asserted through the rank below rather than through this read.
    expect(page.items.map((item) => item.relevanceVerdict)).toEqual([
      'RELEVANT',
      'RELEVANT',
      'UNCERTAIN',
      'UNCERTAIN',
      'NOT_ASSESSED',
      'NOT_ASSESSED',
    ]);

    const descending = await repository.findPage(
      readInput({ sort: { field: 'RELEVANCE', direction: 'DESC' } }),
    );

    expect(descending.items.map((item) => item.relevanceVerdict)).toEqual([
      'NOT_ASSESSED',
      'NOT_ASSESSED',
      'UNCERTAIN',
      'UNCERTAIN',
      'RELEVANT',
      'RELEVANT',
    ]);
  });

  it('keeps the stored sort key in agreement with the rank table for every verdict value (10.7)', async () => {
    const rows = await postgres.prisma.jobPosting.findMany({
      select: { relevanceVerdict: true, relevanceRank: true },
    });

    expect(new Set(rows.map((row) => row.relevanceVerdict))).toEqual(new Set(RELEVANCE_VERDICTS));

    for (const row of rows) {
      expect(row.relevanceRank).toBe(RELEVANCE_RANK[row.relevanceVerdict]);
    }
  });

  it('partitions the filtered result into pages of at most the page size (10.9)', async () => {
    const pageSize = 2;
    const unpaginated = await idsOf({ pageSize: POSTING_PAGE_SIZE });
    const first = await repository.findPage(readInput({ page: 1, pageSize }));

    expect(first.totalCount).toBe(DEFAULT_VIEW_IDS.length);
    expect(first.pageCount).toBe(3);

    const collected: string[] = [];

    for (let page = 1; page <= first.pageCount; page += 1) {
      const result = await repository.findPage(readInput({ page, pageSize }));

      expect(result.items.length).toBeLessThanOrEqual(pageSize);
      expect(result.page).toBe(page);
      expect(result.totalCount).toBe(first.totalCount);

      collected.push(...result.items.map((item) => item.postingId));
    }

    // Every entry exactly once, in the order of the unpaginated read: the pages are a partition,
    // which is only true because the order is total.
    expect(collected).toEqual(unpaginated);
  });

  it('answers a page beyond the last one with no entries and keeps the reported total (10.9)', async () => {
    const page = await repository.findPage(readInput({ page: 4, pageSize: 2 }));

    expect(page.items).toEqual([]);
    expect(page.page).toBe(4);
    expect(page.totalCount).toBe(DEFAULT_VIEW_IDS.length);
    expect(page.pageCount).toBe(3);
  });

  it('answers a filter combination that matches nothing with an empty page (10.13)', async () => {
    const page = await repository.findPage(
      readInput({ filter: { platforms: ['INDEED'], reachability: ['NOT_WELL_REACHABLE'] } }),
    );

    expect(page.items).toEqual([]);
    expect(page.totalCount).toBe(0);
    expect(page.pageCount).toBe(0);
  });
});
