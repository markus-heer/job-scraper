/**
 * The read layer of the posting overview against real PostgreSQL, compared against an independent
 * in-memory reference over the same seeded data (10.5, 10.7, 10.9).
 *
 * Task 15.10. What is left for this file is narrower than its title, because three quarters of the
 * read are already pinned elsewhere, and a near-duplicate would only cost container time:
 *
 * - **Filtering** is compared against an independent reference predicate on real PostgreSQL by
 *   `./property-24-conjunctive-filters.integration.test.ts`, over generated data and with an
 *   exhaustive pinned example. That is the filter half of this task, and it is done.
 * - **The `relevanceRank` consistency assertion for every verdict value** exists verbatim in
 *   `./posting.repository.find-page.integration.test.ts` ("keeps the stored sort key in agreement
 *   with the rank table for every verdict value"), together with the unknown-last order in both
 *   directions and one page walk at a page size of 2.
 * - **Sorting and pagination**, by contrast, are quantified *offline*:
 *   `./property-25-sort-order.test.ts` runs an interpreter that models the `ORDER BY` semantics of
 *   PostgreSQL, and `./property-26-pagination-partition.test.ts` runs a stand-in `JobPosting`
 *   delegate. Both name the same residual risk in their header: if the engine disagreed with the
 *   model, neither file would notice.
 *
 * This file closes exactly that gap. One seeded data set, read through the real
 * `PostingRepository.findPage` against a real PostgreSQL 16, and compared against a reference
 * comparator written from the sentences of 10.7 and 11.3 — for every one of the eight orders of
 * 10.7, page by page, at the page size 10.9 actually prescribes. Four claims only the engine can
 * answer come out of that:
 *
 * 1. **The eight orders are the orders the requirement describes.** The chosen key, the chosen
 *    direction, unknown values last in *both* directions, and the verdict order relevant,
 *    uncertain, not assessed, not relevant — the last of which the enum column cannot express,
 *    since PostgreSQL orders an enum by its declaration order and that order is `RELEVANT`,
 *    `NOT_RELEVANT`, `UNCERTAIN`, `NOT_ASSESSED`. A read that ordered by the column instead of by
 *    the denormalized `relevanceRank` disagrees with the reference here.
 * 2. **The pages partition the result at the real page size.** The existing example walks three
 *    pages of two entries; the data set below leaves more than 25 Job_Posting visible in the
 *    default view, which is the "more than 25 entries" of 10.9 and the first time the configured
 *    `POSTING_PAGE_SIZE` is cut by the engine at all.
 * 3. **The partition survives ties in every sort key.** Equal keys are ordered by nothing but the
 *    `id` tiebreaker, and SQL promises no order for them without it, so an entry could land on two
 *    pages or on none. The seeded data carries ties in all four keys — deliberately, and guarded by
 *    a test of its own — and the identifiers run *counter* to the insertion order, so a tiebreaker
 *    that silently did nothing would not be rescued by the physical row order.
 * 4. **The grouped read assembles one page from two statements correctly.** The default grouping of
 *    11.3 is four statements whose results are concatenated, and the page that straddles the group
 *    boundary is the one that can be assembled out of the wrong two windows. The data set puts that
 *    boundary inside page 1 at the real page size, and the walk at a page size of 4 crosses it
 *    again at several boundaries.
 *
 * Filters appear here only as the *input* of the order and the window: whether a filter selects the
 * right set is Property 24's claim, while whether a non-default sort and a page beyond the first
 * still compose with a set filter is this file's. Property 24 reads page 1 in the default order
 * alone.
 *
 * **The oracle** is a comparator written from 10.7 and 11.3 and from nothing else. It reads neither
 * `postingOrderByOf` nor `RELEVANCE_RANK`: the rank table is *how* the subject implements the
 * verdict order, so a reference reading it could not tell a wrong table from a right one. The
 * verdict positions are therefore spelled out as the requirement spells them out. The reference
 * sorts the rows as they came back out of the store, so the identifiers and the stored values it
 * compares are the engine's own.
 *
 * Seeded once in `beforeAll` and never written again — every test here reads — which is why the
 * harness runs without its per-test truncation.
 *
 * Requirements: 10.5, 10.7, 10.9, 11.3.
 */

import {
  computeContentHash,
  type InterestFlag,
  type Platform,
  PLATFORMS,
  type PostingStatus,
  RELEVANCE_RANK,
  RELEVANCE_VERDICTS,
  type RelevanceVerdict,
} from '@job-scraper/domain';
import { beforeAll, describe, expect, it } from 'vitest';

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
  type PostingSort,
  type PostingSortField,
  type Reachability,
} from '../posting-page-query';

/** The Commute_Threshold these reads are made against: the default of 8.10. */
const THRESHOLD_MINUTES = 60;

/** The earlier Scrape_Run, whose postings are the unmarked group of 11.3. */
const EARLIER_RUN_ID = '44444444-4444-4444-8444-444444444444';
const EARLIER_RUN_STARTED_AT = new Date(SEEDED_RUN_STARTED_AT.getTime() - 24 * 60 * 60_000);

/**
 * How many Job_Posting are stored.
 *
 * Chosen so that the default view of 10.6 and 10.11 keeps more than {@link POSTING_PAGE_SIZE} of
 * them: 34 stored minus the 3 marked "not interesting" and the 4 judged "not relevant" leaves 27,
 * and 10.9 is a statement about a result "with more than 25 entries".
 */
const POSTING_COUNT = 34;

/** The three Relevance_Verdict the default view keeps, cycled over the stored rows. */
const VISIBLE_VERDICTS: readonly RelevanceVerdict[] = ['RELEVANT', 'UNCERTAIN', 'NOT_ASSESSED'];

/**
 * The Best_Commute_Time values cycled over the stored rows, in minutes.
 *
 * Six values over 34 rows, so every value occurs several times: ties in this sort key are the point.
 * Three lie at or below the Commute_Threshold and three above it, so both sides of the "at most" of
 * 8.3 are populated and the reachability filter has something to select on either side.
 */
const COMMUTE_CYCLE: readonly number[] = [20, 45, 60, 61, 90, 120];

/** Publication dates as days after {@link PUBLISHED_EPOCH}, cycled; `4` twice, so dates repeat. */
const PUBLISHED_DAY_CYCLE: readonly number[] = [1, 4, 2, 4, 3];

/** The day the cycle above counts from. */
const PUBLISHED_EPOCH = Date.UTC(2026, 1, 20);

/** The columns the filters of 10.5, the order of 10.7 and the grouping of 11.3 read. */
interface ReferenceRow {
  readonly id: string;
  readonly postingId: string;
  readonly platform: Platform;
  readonly postingStatus: PostingStatus;
  readonly interestFlag: InterestFlag;
  readonly relevanceVerdict: RelevanceVerdict;
  readonly bestCommuteMinutes: number | null;
  readonly publishedAt: Date | null;
  readonly firstSeenAt: Date;
  readonly firstSeenRunId: string;
}

/** Minutes after the reference run's start time as an absolute instant. */
const recordedAt = (offsetMinutes: number): Date =>
  new Date(SEEDED_RUN_STARTED_AT.getTime() + offsetMinutes * 60_000);

/**
 * The value a cycle takes at one row index.
 *
 * The throw is unreachable — the modulo of a non-empty list is always inside it — and exists because
 * `noUncheckedIndexedAccess` types the access as possibly absent, which is a guarantee worth keeping
 * rather than asserting away.
 */
const cycled = <TValue>(values: readonly TValue[], index: number): TValue => {
  const value = values[index % values.length];

  if (value === undefined) {
    throw new Error(
      `The cycle of ${String(values.length)} values has no entry for ${String(index)}.`,
    );
  }

  return value;
};

/**
 * The stored data set, as a function of the row index.
 *
 * Every column cycles with a different period, so no two of them are correlated and a read that
 * confused one for another fails rather than coincidentally agreeing. Three periods are chosen for
 * what they produce rather than for variety:
 *
 * - `firstSeenAt` advances every third row, so three rows share the default sort key to the
 *   millisecond — the tie two postings recorded by the same Scrape_Run really have;
 * - the identifier counts *down* while the rows are inserted in ascending index order, so the `id`
 *   tiebreaker of 10.9 orders tied rows contrary to both the insertion order and the index;
 * - the recording run alternates, so the two groups of 11.3 are of comparable size and the group
 *   boundary falls inside the first page at the real page size.
 *
 * The identifier is a UUID-shaped string whose varying part is decimal digits only. Ordering it is
 * then the same under the database collation and under a JavaScript string comparison, so the
 * reference below compares like with like instead of asserting a collation.
 */
const specOf = (index: number): ReferenceRow => ({
  id: `aaaaaaaa-0000-4000-8000-${String(POSTING_COUNT - 1 - index).padStart(12, '0')}`,
  postingId: `p${String(index).padStart(2, '0')}`,
  platform: cycled(PLATFORMS, index),
  postingStatus: index % 8 === 5 ? 'NO_LONGER_LISTED' : 'LISTED',
  interestFlag: index % 11 === 6 ? 'NOT_INTERESTING' : 'UNMARKED',
  relevanceVerdict: index % 9 === 4 ? 'NOT_RELEVANT' : cycled(VISIBLE_VERDICTS, index),
  bestCommuteMinutes: index % 5 === 2 ? null : cycled(COMMUTE_CYCLE, index),
  publishedAt:
    index % 7 === 3
      ? null
      : new Date(PUBLISHED_EPOCH + cycled(PUBLISHED_DAY_CYCLE, index) * 24 * 60 * 60_000),
  firstSeenAt: recordedAt(Math.floor(index / 3)),
  firstSeenRunId: index % 2 === 0 ? SEEDED_RUN_ID : EARLIER_RUN_ID,
});

/**
 * Where a Relevance_Verdict stands in the order of 10.7.
 *
 * Read off the sentence of the requirement — "relevant before uncertain before not assessed before
 * not relevant" — and deliberately not off `RELEVANCE_RANK`: that table is the subject's
 * implementation of this order, and a reference that read it could not tell a wrong table from a
 * right one. That the two agree is asserted once, separately, in
 * `./posting.repository.find-page.integration.test.ts`.
 */
const VERDICT_POSITION: Readonly<Record<RelevanceVerdict, number>> = {
  RELEVANT: 0,
  UNCERTAIN: 1,
  NOT_ASSESSED: 2,
  NOT_RELEVANT: 3,
};

/** The reachability class of a stored Best_Commute_Time (8.3, 8.11, 8.13). */
const reachabilityOf = (bestCommuteMinutes: number | null): Reachability => {
  if (bestCommuteMinutes === null) {
    return 'UNKNOWN';
  }

  return bestCommuteMinutes <= THRESHOLD_MINUTES ? 'WELL_REACHABLE' : 'NOT_WELL_REACHABLE';
};

/** A filter member that is set: present and non-empty. Both other readings mean "not set" (10.5). */
const isSet = <TValue>(values: readonly TValue[] | undefined): values is readonly TValue[] =>
  values !== undefined && values.length > 0;

/**
 * Whether a stored Job_Posting belongs in the result of a filter (10.5, 10.6, 10.11).
 *
 * The same six conjuncts as the reference predicate of Property 24, and for the same reason: an
 * unset marking or verdict filter is the default view rather than the absence of a condition. Here
 * it is not the claim but the input of one — which set the filters select is Property 24's subject,
 * while this file asks whether the order and the pages of that set are right.
 */
const matchesFilter = (row: ReferenceRow, filter: PostingFilter): boolean =>
  (!isSet(filter.platforms) || filter.platforms.includes(row.platform)) &&
  (!isSet(filter.postingStatuses) || filter.postingStatuses.includes(row.postingStatus)) &&
  (isSet(filter.interestFlags)
    ? filter.interestFlags.includes(row.interestFlag)
    : row.interestFlag !== 'NOT_INTERESTING') &&
  (isSet(filter.relevanceVerdicts)
    ? filter.relevanceVerdicts.includes(row.relevanceVerdict)
    : row.relevanceVerdict !== 'NOT_RELEVANT') &&
  (!isSet(filter.reachability) ||
    filter.reachability.includes(reachabilityOf(row.bestCommuteMinutes))) &&
  (filter.firstSeenFrom === undefined ||
    row.firstSeenAt.getTime() >= filter.firstSeenFrom.getTime()) &&
  (filter.firstSeenTo === undefined || row.firstSeenAt.getTime() <= filter.firstSeenTo.getTime());

/**
 * The sort key of one row, or `null` where it is unknown (10.7).
 *
 * `null` is the "unknown" of 8.13 for the Best_Commute_Time and the unreadable publication date of
 * 6.4 and 6.9. Both belong at the end of the list, which the comparator below decides.
 */
const sortKeyOf = (row: ReferenceRow, field: PostingSortField): number | null => {
  switch (field) {
    case 'FIRST_SEEN_AT':
      return row.firstSeenAt.getTime();
    case 'PUBLISHED_AT':
      return row.publishedAt === null ? null : row.publishedAt.getTime();
    case 'BEST_COMMUTE_MINUTES':
      return row.bestCommuteMinutes;
    case 'RELEVANCE':
      return VERDICT_POSITION[row.relevanceVerdict];
  }
};

/** Whether the default grouping of 11.3 applies: the user chose no deviating sorting. */
const isDefaultSort = (sort: PostingSort): boolean =>
  sort.field === DEFAULT_POSTING_SORT.field && sort.direction === DEFAULT_POSTING_SORT.direction;

/** Whether a row carries the marking "neu" (11.2). */
const isMarked = (row: ReferenceRow): boolean => row.firstSeenRunId === SEEDED_RUN_ID;

/**
 * The reference order over a filtered set (10.7, 10.9, 11.3).
 *
 * Four rules, each one sentence of a requirement:
 *
 * 1. where the user chose no deviating sorting, every Job_Posting marked "neu" stands above every
 *    unmarked one (11.3);
 * 2. a row whose sort key is unknown stands at the end of the list — in both directions, because
 *    10.7 says "at the end" and not "at the ascending end";
 * 3. known keys are compared in the chosen direction;
 * 4. equal keys are separated by the identifier ascending, which is what makes the order total and
 *    therefore the pages of 10.9 a partition.
 */
const referenceOrder = (
  rows: readonly ReferenceRow[],
  sort: PostingSort,
): readonly ReferenceRow[] => {
  const grouped = isDefaultSort(sort);

  return [...rows].sort((left, right) => {
    if (grouped) {
      const groupDifference = Number(!isMarked(left)) - Number(!isMarked(right));

      if (groupDifference !== 0) {
        return groupDifference;
      }
    }

    const leftKey = sortKeyOf(left, sort.field);
    const rightKey = sortKeyOf(right, sort.field);

    if (leftKey === null || rightKey === null) {
      if (leftKey !== rightKey) {
        return leftKey === null ? 1 : -1;
      }
    } else if (leftKey !== rightKey) {
      return sort.direction === 'ASC' ? leftKey - rightKey : rightKey - leftKey;
    }

    return left.id < right.id ? -1 : 1;
  });
};

/** The Posting_Id the reference selects and orders for one read. */
const referenceIds = (
  rows: readonly ReferenceRow[],
  filter: PostingFilter,
  sort: PostingSort,
): readonly string[] =>
  referenceOrder(
    rows.filter((row) => matchesFilter(row, filter)),
    sort,
  ).map((row) => row.postingId);

/** The eight orders 10.7 offers: each of the four keys in both directions. */
const SORTS: readonly PostingSort[] = (
  ['FIRST_SEEN_AT', 'PUBLISHED_AT', 'BEST_COMMUTE_MINUTES', 'RELEVANCE'] as const
).flatMap((field) => (['ASC', 'DESC'] as const).map((direction) => ({ field, direction })));

/**
 * A filter with a value set in five dimensions at once, used to check that a set filter still
 * composes with a non-default sort and with a page beyond the first (10.5, 10.7, 10.9).
 */
const COMBINED_FILTER: PostingFilter = {
  platforms: ['STEPSTONE', 'INDEED'],
  postingStatuses: ['LISTED'],
  reachability: ['WELL_REACHABLE', 'UNKNOWN'],
  firstSeenFrom: recordedAt(1),
  firstSeenTo: recordedAt(10),
};

/** Every Interest_Flag and every Relevance_Verdict selected: the whole store, visible again (10.6). */
const EVERYTHING_FILTER: PostingFilter = {
  interestFlags: ['UNMARKED', 'NOT_INTERESTING'],
  relevanceVerdicts: [...RELEVANCE_VERDICTS],
};

// Seeded once in `beforeAll`; every test reads, so no test needs an empty store.
const postgres = usePostgres({ truncateBetweenTests: false });

/** The stored rows as they came back out of the Posting_Store, the reference's input. */
let storedRows: readonly ReferenceRow[] = [];

/** The same rows by Posting_Id, so an assertion can read the columns of a returned entry. */
let storedByPostingId: ReadonlyMap<string, ReferenceRow> = new Map();

let repository: PostingRepository;

/** The stored row one returned Posting_Id belongs to. */
const rowOf = (postingId: string): ReferenceRow => {
  const row = storedByPostingId.get(postingId);

  if (row === undefined) {
    throw new Error(`The read returned an unknown Posting_Id: ${postingId}`);
  }

  return row;
};

/** One page of a read, with the counts 10.9 asks to be displayed. */
interface WalkResult {
  /** The Posting_Id of every page in order, concatenated. */
  readonly ids: readonly string[];
  readonly totalCount: number;
  readonly pageCount: number;
  /** How many entries each page held, so the bound of 10.9 can be read off per page. */
  readonly pageSizes: readonly number[];
}

/**
 * Reads every page of one filter and one order, and concatenates them (10.9).
 *
 * Also asserts what has to hold page by page: the reported total and page count do not move between
 * pages, each page reports the number it was asked for, and no page holds more than the page size.
 */
const walkPages = async (
  filter: PostingFilter,
  sort: PostingSort,
  pageSize: number,
): Promise<WalkResult> => {
  const first = await repository.findPage({
    filter,
    sort,
    page: 1,
    pageSize,
    commuteThresholdMinutes: THRESHOLD_MINUTES,
    latestCompletedRunId: SEEDED_RUN_ID,
  });

  const ids: string[] = [...first.items.map((item) => item.postingId)];
  const pageSizes: number[] = [first.items.length];

  for (let page = 2; page <= first.pageCount; page += 1) {
    const result = await repository.findPage({
      filter,
      sort,
      page,
      pageSize,
      commuteThresholdMinutes: THRESHOLD_MINUTES,
      latestCompletedRunId: SEEDED_RUN_ID,
    });

    expect(result.page).toBe(page);
    expect(result.totalCount).toBe(first.totalCount);
    expect(result.pageCount).toBe(first.pageCount);

    ids.push(...result.items.map((item) => item.postingId));
    pageSizes.push(result.items.length);
  }

  for (const size of pageSizes) {
    expect(size).toBeLessThanOrEqual(pageSize);
  }

  return { ids, totalCount: first.totalCount, pageCount: first.pageCount, pageSizes };
};

describe('The posting overview read against PostgreSQL', () => {
  beforeAll(async () => {
    repository = new PostingRepository(postgres.prisma);

    await seedScrapeRun(postgres.prisma, {
      id: EARLIER_RUN_ID,
      startedAt: EARLIER_RUN_STARTED_AT,
    });
    await seedScrapeRun(postgres.prisma);

    await postgres.prisma.jobPosting.createMany({
      data: Array.from({ length: POSTING_COUNT }, (_unused, index) => {
        const spec = specOf(index);
        const title = `Projektmanagerin ${spec.postingId}`;
        const descriptionText = 'Sie steuern Projekte im Bereich Life Science.';

        return {
          id: spec.id,
          platform: spec.platform,
          postingId: spec.postingId,
          title,
          employer: 'Beispiel Pharma GmbH',
          workLocation: 'München',
          publishedAt: spec.publishedAt,
          sourceUrl: `https://www.${spec.platform.toLowerCase()}.example/--${spec.postingId}`,
          descriptionText,
          firstSeenAt: spec.firstSeenAt,
          lastSeenAt: spec.firstSeenAt,
          firstSeenRunId: spec.firstSeenRunId,
          postingStatus: spec.postingStatus,
          interestFlag: spec.interestFlag,
          relevanceVerdict: spec.relevanceVerdict,
          // Written from the rank table exactly as both relevance writers do, so the order this
          // read produces is the order a stored assessment would really have produced (10.7).
          relevanceRank: RELEVANCE_RANK[spec.relevanceVerdict],
          contentHash: computeContentHash(title, descriptionText),
          bestCommuteMinutes: spec.bestCommuteMinutes,
          bestCommuteMode: spec.bestCommuteMinutes === null ? null : 'BICYCLE',
          commutePrecision: spec.bestCommuteMinutes === null ? 'UNKNOWN' : 'EXACT',
        };
      }),
    });

    // Read back rather than reused from the specification: the reference then compares the values
    // and the identifiers the store really holds.
    storedRows = await postgres.prisma.jobPosting.findMany({
      select: {
        id: true,
        postingId: true,
        platform: true,
        postingStatus: true,
        interestFlag: true,
        relevanceVerdict: true,
        bestCommuteMinutes: true,
        publishedAt: true,
        firstSeenAt: true,
        firstSeenRunId: true,
      },
    });
    storedByPostingId = new Map(storedRows.map((row) => [row.postingId, row]));
  });

  it('seeds a data set with ties in every sort key and more than one page of visible postings', () => {
    expect(storedRows).toHaveLength(POSTING_COUNT);

    // The premise of the partition claim: without ties the `id` tiebreaker would never be reached
    // and a read without it would pass. Counted per key over the stored rows.
    const tiedKeyCount = (key: (row: ReferenceRow) => unknown): number => {
      const seen = new Map<string, number>();

      for (const row of storedRows) {
        const value = JSON.stringify(key(row));

        seen.set(value, (seen.get(value) ?? 0) + 1);
      }

      return [...seen.values()].filter((count) => count > 1).length;
    };

    expect(tiedKeyCount((row) => row.firstSeenAt)).toBeGreaterThan(0);
    expect(tiedKeyCount((row) => row.publishedAt)).toBeGreaterThan(0);
    expect(tiedKeyCount((row) => row.bestCommuteMinutes)).toBeGreaterThan(0);
    expect(tiedKeyCount((row) => row.relevanceVerdict)).toBeGreaterThan(0);

    // Every Relevance_Verdict occurs, so the four-group order of 10.7 is assertable at all.
    expect(new Set(storedRows.map((row) => row.relevanceVerdict))).toEqual(
      new Set(RELEVANCE_VERDICTS),
    );

    // Both directions of the unknown-last rule need rows without the key.
    expect(storedRows.some((row) => row.bestCommuteMinutes === null)).toBe(true);
    expect(storedRows.some((row) => row.publishedAt === null)).toBe(true);

    // 10.9 is about a result "with more than 25 entries"; the default view is one.
    expect(referenceIds(storedRows, {}, DEFAULT_POSTING_SORT).length).toBeGreaterThan(
      POSTING_PAGE_SIZE,
    );
    expect(referenceIds(storedRows, COMBINED_FILTER, DEFAULT_POSTING_SORT).length).toBeGreaterThan(
      4,
    );
  });

  it.each(SORTS)(
    'returns the default view in the reference order for $field $direction, page by page at the page size of 10.9 (10.7, 10.9)',
    async (sort) => {
      const expected = referenceIds(storedRows, {}, sort);
      const walk = await walkPages({}, sort, POSTING_PAGE_SIZE);

      expect(walk.totalCount).toBe(expected.length);
      expect(walk.pageCount).toBe(Math.ceil(expected.length / POSTING_PAGE_SIZE));

      // The whole list, in order: equality here is the order of 10.7 and the partition of 10.9 at
      // once — every entry on exactly one page, and the pages concatenating to the global order.
      expect(walk.ids).toEqual(expected);
      expect(new Set(walk.ids).size).toBe(walk.ids.length);

      // Every page but the last one is full, which is what "at most 25 per page" means for a
      // result that fills several pages.
      expect(walk.pageSizes.slice(0, -1).every((size) => size === POSTING_PAGE_SIZE)).toBe(true);
    },
  );

  it.each(SORTS)(
    'composes a set filter with $field $direction across small pages (10.5, 10.7, 10.9)',
    async (sort) => {
      const expected = referenceIds(storedRows, COMBINED_FILTER, sort);
      const walk = await walkPages(COMBINED_FILTER, sort, 4);

      expect(walk.totalCount).toBe(expected.length);
      expect(walk.pageCount).toBe(Math.ceil(expected.length / 4));
      expect(walk.ids).toEqual(expected);
    },
  );

  it('orders all four Relevance_Verdict groups as 10.7 prescribes, not as the enum is declared', async () => {
    const ascending = await walkPages(
      EVERYTHING_FILTER,
      { field: 'RELEVANCE', direction: 'ASC' },
      POSTING_PAGE_SIZE,
    );
    const descending = await walkPages(
      EVERYTHING_FILTER,
      { field: 'RELEVANCE', direction: 'DESC' },
      POSTING_PAGE_SIZE,
    );

    expect(ascending.totalCount).toBe(POSTING_COUNT);
    expect(ascending.ids).toEqual(
      referenceIds(storedRows, EVERYTHING_FILTER, { field: 'RELEVANCE', direction: 'ASC' }),
    );
    expect(descending.ids).toEqual(
      referenceIds(storedRows, EVERYTHING_FILTER, { field: 'RELEVANCE', direction: 'DESC' }),
    );

    const verdictOf = (postingId: string): RelevanceVerdict => rowOf(postingId).relevanceVerdict;

    // The four groups in the order of the sentence, read off the returned rows: relevant,
    // uncertain, not assessed, not relevant. The enum column is declared in a different order
    // (`RELEVANT`, `NOT_RELEVANT`, `UNCERTAIN`, `NOT_ASSESSED`), which PostgreSQL would sort by —
    // so a read that ordered by the column rather than by `relevanceRank` fails here.
    const positions = ascending.ids.map((postingId) => VERDICT_POSITION[verdictOf(postingId)]);

    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(new Set(positions)).toEqual(new Set([0, 1, 2, 3]));
    expect(positions.at(-1)).toBe(VERDICT_POSITION.NOT_RELEVANT);

    // The same list reversed in the other direction, group by group.
    expect(descending.ids.map((postingId) => VERDICT_POSITION[verdictOf(postingId)])).toEqual(
      [...positions].reverse(),
    );
  });

  it('places an unknown value at the end of the list in both directions (10.7)', async () => {
    for (const field of ['BEST_COMMUTE_MINUTES', 'PUBLISHED_AT'] as const) {
      for (const direction of ['ASC', 'DESC'] as const) {
        const walk = await walkPages(EVERYTHING_FILTER, { field, direction }, POSTING_PAGE_SIZE);
        const unknownAt = walk.ids
          .map((postingId, position) => ({ postingId, position }))
          .filter(({ postingId }) => sortKeyOf(rowOf(postingId), field) === null)
          .map(({ position }) => position);

        expect(unknownAt.length).toBeGreaterThan(0);

        // The unknown rows are the tail of the list: their positions are the last ones.
        const tail = Array.from(
          { length: unknownAt.length },
          (_unused, offset) => walk.ids.length - unknownAt.length + offset,
        );

        expect(unknownAt).toEqual(tail);
      }
    }
  });

  it('keeps the marked postings above the unmarked ones across the page boundary (11.3)', async () => {
    const walk = await walkPages({}, DEFAULT_POSTING_SORT, POSTING_PAGE_SIZE);
    const marked = new Set(storedRows.filter((row) => isMarked(row)).map((row) => row.postingId));
    const flags = walk.ids.map((postingId) => marked.has(postingId));
    const markedInResult = flags.filter((flag) => flag).length;

    // The premise of this test: the group boundary falls inside the first page, which is the page
    // the grouped read has to assemble out of both group queries.
    expect(markedInResult).toBeGreaterThan(0);
    expect(markedInResult).toBeLessThan(POSTING_PAGE_SIZE);
    expect(walk.ids.length).toBeGreaterThan(POSTING_PAGE_SIZE);

    // Marked first, then unmarked, with no marked one after an unmarked one.
    expect(flags).toEqual([
      ...Array.from({ length: markedInResult }, () => true),
      ...Array.from({ length: flags.length - markedInResult }, () => false),
    ]);

    // And within both groups, recording time descending (10.7, 11.3) — the reference order.
    expect(walk.ids).toEqual(referenceIds(storedRows, {}, DEFAULT_POSTING_SORT));
  });

  it('partitions the grouped list at every boundary of a small page (10.9, 11.3)', async () => {
    const walk = await walkPages({}, DEFAULT_POSTING_SORT, 4);

    expect(walk.ids).toEqual(referenceIds(storedRows, {}, DEFAULT_POSTING_SORT));
    expect(new Set(walk.ids).size).toBe(walk.ids.length);
    expect(walk.pageCount).toBe(Math.ceil(walk.totalCount / 4));
  });
});
