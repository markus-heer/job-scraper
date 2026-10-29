/**
 * Property 26 of the job-search-tool design: pagination partitions the filtered and sorted result.
 *
 * The claim of 10.9 is not about one page, it is about all of them at once: the pages 1 to
 * `pageCount` hold every matching Job_Posting exactly once and in the global order, every page
 * beyond them holds nothing, no page holds more than the 25 entries of 10.9, the first page is what
 * an opened overview gets, and `pageCount` is `ceil(totalCount / pageSize)`. "Exactly once" is the
 * part that cannot be asserted page by page — an entry appearing on two pages, or on none, is a
 * relation between pages — and it is also the part with two real failure modes behind it: the window
 * arithmetic of {@link postingPageWindowOf}, and the split of one page into two windows that
 * {@link newFirstPageSlices} performs once the "neu" grouping of 11.3 is in force.
 *
 * ## What makes the claim true at all
 *
 * The `{ id: 'asc' }` tiebreaker of `postingOrderByOf`. Every sort key of 10.7 has duplicates in
 * practice — two postings recorded by the same Scrape_Run share `firstSeenAt` to the millisecond,
 * the Relevance_Verdict has four values for any number of rows — and SQL promises no order at all
 * for equal keys, so without a unique final key the engine may answer two `LIMIT/OFFSET` statements
 * over the same data in different orders and an entry lands on two pages or on none. The tiebreaker
 * makes the order total, and a total order is exactly what turns "cut at 25, 50, 75" into a
 * partition. The generated data below therefore carries ties in every sort key, and the evaluator
 * answers each statement with its own order for equal keys (see {@link tieOrderOf}) rather than
 * with a conveniently stable one; a `postingOrderByOf` without the tiebreaker makes the second
 * property fail with one entry on two pages.
 *
 * ## How the claim is evaluated, and why not against PostgreSQL
 *
 * Two of the three properties are pure arithmetic over the window functions, which is where the
 * partition is decided. The middle one runs the real `PostingRepository.findPage` — filter, order,
 * window, grouping, counts and all — against an in-memory `JobPosting` delegate that really
 * evaluates the `where`, the `orderBy` and the `skip`/`take` it is handed, as
 * `./posting.repository.new-first-page.test.ts` does for the grouping by example. That keeps this
 * file in `pnpm test`, which has to stay offline and Docker-free, while still covering the
 * composition `findPage` performs rather than only its parts: the grouped read is four statements
 * whose results are concatenated, and no arithmetic over windows alone would catch a page assembled
 * from the wrong two of them.
 *
 * The honest limit of that choice: against a stand-in, the reading of the query is the stand-in's
 * and not the engine's. The delegate therefore refuses any `where` or `orderBy` term it does not
 * model — a silently ignored term would turn into a false pass — and the engine's half of 10.9 is
 * asserted by example against real PostgreSQL in
 * `./posting.repository.find-page.integration.test.ts`, which runs in the separate
 * `pnpm test:integration` suite. The third option, driving this property against that container,
 * would buy the engine's reading at the price of taking the property out of the suite that runs on
 * every change.
 *
 * The oracle for "the filtered and sorted result" is the same read without a window: the unpaginated
 * list the evaluator returns for the same filter and the same order. Whether that filter and that
 * order are the right ones is the subject of Properties 24 and 25; this property takes them as given
 * and asks only whether the pages are that list, cut.
 *
 * Fully offline and deterministic: no database, no clock, no network.
 */

// Feature: job-search-tool, Property 26 - Pagination partitions the filtered and sorted result

import {
  INTEREST_FLAGS,
  PLATFORMS,
  POSTING_STATUSES,
  RELEVANCE_RANK,
  RELEVANCE_VERDICTS,
} from '@job-scraper/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JobPosting, Platform, PostingStatus, Prisma } from '../../prisma/prisma.types';
import { newFirstGroupingFor, newFirstPageSlices } from '../new-marking';
import { PostingRepository, type PostingStore } from '../posting.repository';
import {
  DEFAULT_POSTING_SORT,
  type FindPostingPageInput,
  pageCountOf,
  POSTING_PAGE_SIZE,
  type PostingFilter,
  postingOrderByOf,
  postingPageWindowOf,
  type PostingSort,
  type PostingSortField,
  postingWhereOf,
  REACHABILITIES,
} from '../posting-page-query';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** The Commute_Threshold these reads are made against (8.10). */
const THRESHOLD_MINUTES = 60;

/** The instant the generated recording times are counted from; nothing here reads a clock. */
const BASE_TIME = Date.UTC(2026, 2, 1, 8, 0, 0);

/** The Scrape_Run the generated Job_Posting were first recorded in (11.1). */
const RUN_IDS = ['run-1', 'run-2', 'run-3'] as const;

/** The four sort keys of 10.7. */
const SORT_FIELDS: readonly PostingSortField[] = [
  'FIRST_SEEN_AT',
  'PUBLISHED_AT',
  'BEST_COMMUTE_MINUTES',
  'RELEVANCE',
];

// --------------------------------------------------------------------------------------------
// Generated Job_Posting
// --------------------------------------------------------------------------------------------

/** The columns a generated Job_Posting varies in; the identifier comes from its position. */
interface RowSpec {
  readonly platform: Platform;
  readonly postingStatus: PostingStatus;
  readonly interestFlag: JobPosting['interestFlag'];
  readonly relevanceVerdict: JobPosting['relevanceVerdict'];
  /** Minutes after {@link BASE_TIME}; a small range, so recording times tie (10.7, 10.9). */
  readonly firstSeenOffsetMinutes: number;
  /** Days before {@link BASE_TIME}, or null where no publication date was readable (6.4, 6.9). */
  readonly publishedOffsetDays: number | null;
  /** The Best_Commute_Time in minutes, or null for the stored "unknown" of 8.13. */
  readonly bestCommuteMinutes: number | null;
  /** Which of {@link RUN_IDS} recorded it first, which is what the "neu" marking reads (11.2). */
  readonly runIndex: number;
}

const rowSpecArbitrary: fc.Arbitrary<RowSpec> = fc.record({
  platform: fc.constantFrom(...PLATFORMS),
  postingStatus: fc.constantFrom(...POSTING_STATUSES),
  interestFlag: fc.constantFrom(...INTEREST_FLAGS),
  relevanceVerdict: fc.constantFrom(...RELEVANCE_VERDICTS),
  // Ties in every sort key are the point: five recording instants, five publication dates and five
  // commute values over up to 300 rows, so the unique tiebreaker is what the order rests on.
  firstSeenOffsetMinutes: fc.integer({ min: 0, max: 4 }),
  publishedOffsetDays: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }),
  bestCommuteMinutes: fc.option(fc.integer({ min: 10, max: 14 }), { nil: null }),
  runIndex: fc.integer({ min: 0, max: RUN_IDS.length - 1 }),
});

/** The identifier of the Job_Posting at one position, padded so it sorts as the engine sorts. */
const idOf = (index: number): string => `posting-${String(index).padStart(3, '0')}`;

/** One stored Job_Posting, with every column the read does not branch on at its declared default. */
const rowOf = (spec: RowSpec, index: number): JobPosting => ({
  id: idOf(index),
  platform: spec.platform,
  postingId: `${spec.platform}-${index}`,
  title: `Projektmanagerin ${index}`,
  employer: null,
  workLocation: null,
  publishedAt:
    spec.publishedOffsetDays === null
      ? null
      : new Date(BASE_TIME - spec.publishedOffsetDays * 86_400_000),
  sourceUrl: `https://example.invalid/${index}`,
  descriptionText: null,
  firstSeenAt: new Date(BASE_TIME + spec.firstSeenOffsetMinutes * 60_000),
  lastSeenAt: new Date(BASE_TIME + spec.firstSeenOffsetMinutes * 60_000),
  firstSeenRunId: RUN_IDS[spec.runIndex] ?? RUN_IDS[0],
  postingStatus: spec.postingStatus,
  interestFlag: spec.interestFlag,
  relevanceVerdict: spec.relevanceVerdict,
  relevanceReason: null,
  relevanceModel: null,
  relevanceAssessedAt: null,
  relevanceSetManually: false,

  // The denormalized sort key of 10.7 has to agree with the verdict, or sorting by Relevance_Verdict
  // would be asserted against data no write of the repository can produce.
  relevanceRank: RELEVANCE_RANK[spec.relevanceVerdict],
  contentHash: `hash-${index}`,
  relevanceContentHash: null,
  bicycleMinutes: null,
  transitMinutes: null,
  bestCommuteMinutes: spec.bestCommuteMinutes,
  bestCommuteMode: null,
  commutePrecision: 'UNKNOWN',
  commuteLocationInput: null,
  commuteCheckedAt: null,
});

// --------------------------------------------------------------------------------------------
// Generated request
// --------------------------------------------------------------------------------------------

/** One bound of the recording period, inside the span of the generated recording times. */
const recordingTimeArbitrary: fc.Arbitrary<Date> = fc
  .integer({ min: 0, max: 4 })
  .map((minutes) => new Date(BASE_TIME + minutes * 60_000));

/**
 * The filters of 10.5, each one set or unset.
 *
 * Generated rather than fixed so that "the filtered result" is a real restriction and the pages are
 * a partition of *it* — including the default view of 10.6 and 10.11, which an unset marking or
 * verdict filter is.
 */
const filterArbitrary: fc.Arbitrary<PostingFilter> = fc.record({
  platforms: fc.option(fc.uniqueArray(fc.constantFrom(...PLATFORMS), { minLength: 1 }), {
    nil: undefined,
  }),
  reachability: fc.option(fc.uniqueArray(fc.constantFrom(...REACHABILITIES), { minLength: 1 }), {
    nil: undefined,
  }),
  postingStatuses: fc.option(
    fc.uniqueArray(fc.constantFrom(...POSTING_STATUSES), { minLength: 1 }),
    {
      nil: undefined,
    },
  ),
  interestFlags: fc.option(fc.uniqueArray(fc.constantFrom(...INTEREST_FLAGS), { minLength: 1 }), {
    nil: undefined,
  }),
  relevanceVerdicts: fc.option(
    fc.uniqueArray(fc.constantFrom(...RELEVANCE_VERDICTS), { minLength: 1 }),
    { nil: undefined },
  ),

  // The recording period of 10.5, each bound on its own, inside the span of the generated recording
  // times so that it really narrows the result. A `from` after the `to` is a filter the user can set
  // and yields the empty result, which is a partition of nothing.
  firstSeenFrom: fc.option(recordingTimeArbitrary, { nil: undefined }),
  firstSeenTo: fc.option(recordingTimeArbitrary, { nil: undefined }),
});

/**
 * The sorting of one read, with the default drawn half the time.
 *
 * The default is what puts the "neu" grouping of 11.3 in force, and the grouped read is the one that
 * assembles a page out of two windows; drawing it as often as all seven other orders together keeps
 * both code paths covered in every run of the suite.
 */
const sortArbitrary: fc.Arbitrary<PostingSort> = fc.oneof(
  fc.constant(DEFAULT_POSTING_SORT),
  fc.record({
    field: fc.constantFrom(...SORT_FIELDS),
    direction: fc.constantFrom<PostingSort['direction']>('ASC', 'DESC'),
  }),
);

/**
 * A requested page size: inside the 1 to 25 of 10.9, and above it often enough to matter.
 *
 * A request above the maximum is not an error but a clamp, so "no page holds more than 25 entries"
 * is a claim over *every* requested size rather than over the permitted ones.
 */
const pageSizeArbitrary: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 1, max: POSTING_PAGE_SIZE }),
  fc.integer({ min: POSTING_PAGE_SIZE + 1, max: 500 }),
);

// --------------------------------------------------------------------------------------------
// The in-memory evaluator
// --------------------------------------------------------------------------------------------

/** An `in`/`not` term over an enum column, as {@link postingWhereOf} emits it. */
interface EnumTerm<TValue extends string> {
  readonly not?: TValue;
  readonly in?: readonly TValue[];
}

/** Exactly the `where` terms the paginated read emits; anything else is refused below. */
interface EvaluatedWhere {
  readonly AND?: readonly EvaluatedWhere[];
  readonly OR?: readonly EvaluatedWhere[];
  readonly id?: { readonly in: readonly string[] };
  readonly platform?: { readonly in: readonly Platform[] };
  readonly postingStatus?: { readonly in: readonly PostingStatus[] };
  readonly interestFlag?: EnumTerm<JobPosting['interestFlag']>;
  readonly relevanceVerdict?: EnumTerm<JobPosting['relevanceVerdict']>;
  readonly firstSeenRunId?: string | { readonly not: string };
  readonly firstSeenAt?: { readonly gte?: Date; readonly lte?: Date };
  readonly bestCommuteMinutes?: null | { readonly lte?: number; readonly gt?: number };
}

const WHERE_KEYS: readonly string[] = [
  'AND',
  'OR',
  'id',
  'platform',
  'postingStatus',
  'interestFlag',
  'relevanceVerdict',
  'firstSeenRunId',
  'firstSeenAt',
  'bestCommuteMinutes',
];

/**
 * Reads a `where` input as a term the evaluator models, and refuses it otherwise.
 *
 * The refusal is the whole safeguard of this fixture: a term it silently ignored would widen the
 * result and the property would pass on a read nobody evaluated.
 */
const asEvaluatedWhere = (where: object): EvaluatedWhere => {
  for (const key of Object.keys(where)) {
    if (!WHERE_KEYS.includes(key)) {
      throw new Error(`The in-memory evaluator does not model the where term "${key}".`);
    }
  }

  const evaluated = where as EvaluatedWhere;

  for (const nested of [...(evaluated.AND ?? []), ...(evaluated.OR ?? [])]) {
    asEvaluatedWhere(nested);
  }

  return evaluated;
};

const matchesEnumTerm = <TValue extends string>(
  value: TValue,
  term: EnumTerm<TValue> | undefined,
): boolean =>
  term === undefined ||
  ((term.not === undefined || value !== term.not) &&
    (term.in === undefined || term.in.includes(value)));

const matchesWhere = (row: JobPosting, where: EvaluatedWhere): boolean => {
  if (where.AND !== undefined && !where.AND.every((term) => matchesWhere(row, term))) {
    return false;
  }

  if (where.OR !== undefined && !where.OR.some((term) => matchesWhere(row, term))) {
    return false;
  }

  if (where.id !== undefined && !where.id.in.includes(row.id)) {
    return false;
  }

  if (where.platform !== undefined && !where.platform.in.includes(row.platform)) {
    return false;
  }

  if (where.postingStatus !== undefined && !where.postingStatus.in.includes(row.postingStatus)) {
    return false;
  }

  if (
    !matchesEnumTerm(row.interestFlag, where.interestFlag) ||
    !matchesEnumTerm(row.relevanceVerdict, where.relevanceVerdict)
  ) {
    return false;
  }

  if (where.firstSeenRunId !== undefined) {
    const term = where.firstSeenRunId;
    const held =
      typeof term === 'string' ? row.firstSeenRunId === term : row.firstSeenRunId !== term.not;

    if (!held) {
      return false;
    }
  }

  if (where.firstSeenAt !== undefined) {
    const recorded = row.firstSeenAt.getTime();
    const { gte, lte } = where.firstSeenAt;

    if (
      (gte !== undefined && recorded < gte.getTime()) ||
      (lte !== undefined && recorded > lte.getTime())
    ) {
      return false;
    }
  }

  if (where.bestCommuteMinutes !== undefined) {
    const term = where.bestCommuteMinutes;

    if (term === null) {
      return row.bestCommuteMinutes === null;
    }

    // A comparison against a stored "unknown" is never true, which is how `lte` already hides the
    // Job_Posting 8.11 asks to hide.
    if (row.bestCommuteMinutes === null) {
      return false;
    }

    if (term.lte !== undefined && row.bestCommuteMinutes > term.lte) {
      return false;
    }

    if (term.gt !== undefined && row.bestCommuteMinutes <= term.gt) {
      return false;
    }
  }

  return true;
};

/** The sort keys the evaluator compares numerically; `id` is the string tiebreaker. */
type NumericSortKey = 'firstSeenAt' | 'publishedAt' | 'bestCommuteMinutes' | 'relevanceRank';

type RowComparator = (left: JobPosting, right: JobPosting) => number;

const numericKeyOf = (row: JobPosting, key: NumericSortKey): number | null => {
  switch (key) {
    case 'firstSeenAt':
      return row.firstSeenAt.getTime();
    case 'publishedAt':
      return row.publishedAt === null ? null : row.publishedAt.getTime();
    case 'bestCommuteMinutes':
      return row.bestCommuteMinutes;
    case 'relevanceRank':
      return row.relevanceRank;
  }
};

const compareNumbers = (left: number, right: number): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** One `orderBy` term over a nullable or non-nullable numeric column. */
const numericComparator = (
  key: NumericSortKey,
  direction: 'asc' | 'desc',
  nullsLast: boolean,
): RowComparator => {
  return (left, right) => {
    const a = numericKeyOf(left, key);
    const b = numericKeyOf(right, key);

    if (a === null || b === null) {
      if (a === null && b === null) {
        return 0;
      }

      // Independent of the direction, which is what `nulls: 'last'` says in SQL and what 10.7 asks
      // for: the unknown values stay at the end of the list in both directions.
      return (a === null ? 1 : -1) * (nullsLast ? 1 : -1);
    }

    return direction === 'asc' ? compareNumbers(a, b) : compareNumbers(b, a);
  };
};

/** Exactly the `orderBy` terms {@link postingOrderByOf} emits; anything else is refused. */
interface EvaluatedOrderBy {
  readonly firstSeenAt?: 'asc' | 'desc';
  readonly publishedAt?: { readonly sort: 'asc' | 'desc'; readonly nulls?: 'first' | 'last' };
  readonly bestCommuteMinutes?: {
    readonly sort: 'asc' | 'desc';
    readonly nulls?: 'first' | 'last';
  };
  readonly relevanceRank?: 'asc' | 'desc';
  readonly id?: 'asc' | 'desc';
}

const ORDER_BY_KEYS: readonly string[] = [
  'firstSeenAt',
  'publishedAt',
  'bestCommuteMinutes',
  'relevanceRank',
  'id',
];

const comparatorOfTerm = (term: object): RowComparator => {
  for (const key of Object.keys(term)) {
    if (!ORDER_BY_KEYS.includes(key)) {
      throw new Error(`The in-memory evaluator does not model the orderBy term "${key}".`);
    }
  }

  const evaluated = term as EvaluatedOrderBy;

  if (evaluated.firstSeenAt !== undefined) {
    return numericComparator('firstSeenAt', evaluated.firstSeenAt, true);
  }

  if (evaluated.publishedAt !== undefined) {
    return numericComparator(
      'publishedAt',
      evaluated.publishedAt.sort,
      evaluated.publishedAt.nulls !== 'first',
    );
  }

  if (evaluated.bestCommuteMinutes !== undefined) {
    return numericComparator(
      'bestCommuteMinutes',
      evaluated.bestCommuteMinutes.sort,
      evaluated.bestCommuteMinutes.nulls !== 'first',
    );
  }

  if (evaluated.relevanceRank !== undefined) {
    return numericComparator('relevanceRank', evaluated.relevanceRank, true);
  }

  if (evaluated.id !== undefined) {
    const direction = evaluated.id;

    return (left, right) =>
      direction === 'asc' ? compareStrings(left.id, right.id) : compareStrings(right.id, left.id);
  }

  throw new Error('The in-memory evaluator received an empty orderBy term.');
};

const comparatorOf = (orderBy: readonly object[]): RowComparator => {
  const comparators = orderBy.map(comparatorOfTerm);

  return (left, right) =>
    comparators.reduce((decided, compare) => (decided === 0 ? compare(left, right) : decided), 0);
};

const orderByListOf = (
  orderBy: Prisma.JobPostingFindManyArgs['orderBy'],
): readonly Prisma.JobPostingOrderByWithRelationInput[] => {
  if (orderBy === undefined) {
    return [];
  }

  return Array.isArray(orderBy) ? orderBy : [orderBy];
};

/**
 * A per-statement ordering of rows whose sort keys are equal, modelling what SQL does not promise.
 *
 * This is the one place the evaluator is deliberately hostile. PostgreSQL gives no order for equal
 * keys, so two `LIMIT/OFFSET` statements over the same data may disagree about them, and an entry
 * then lands on two pages or on none. A stand-in whose `Array.prototype.sort` happens to be stable
 * would hide exactly that — it would answer every statement in the same order and the partition
 * would hold even without a unique final sort key. Deriving a tie order from the statement number
 * instead means the property passes only because {@link postingOrderByOf} ends every order with
 * `{ id: 'asc' }`, which is what 10.9 rests on.
 */
const tieOrderOf = (statement: number, id: string): number => {
  let hash = Math.imul(statement + 1, 2_654_435_761);

  for (const character of id) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  }

  return hash;
};

/** A `JobPosting` delegate over generated rows, plus the unpaginated read used as the oracle. */
interface EvaluatorFixture {
  readonly store: PostingStore;
  /** The filtered and sorted result of one read, without a window; one statement of its own. */
  rowsFor(
    where: Prisma.JobPostingWhereInput,
    orderBy: readonly Prisma.JobPostingOrderByWithRelationInput[],
  ): readonly JobPosting[];
}

/**
 * An in-memory `JobPosting` delegate that really evaluates the filter, the order and the window.
 *
 * The repository's own decisions stay the real ones — this replaces the storage, not the read. The
 * filtered selections are memoized, which keeps a 300-row result affordable across the pages of one
 * property run; the order is not, because each statement orders equal keys its own way (see
 * {@link tieOrderOf}).
 */
const createEvaluator = (rows: readonly JobPosting[]): EvaluatorFixture => {
  const selections = new Map<string, readonly JobPosting[]>();
  let statements = 0;

  const selectionFor = (where: Prisma.JobPostingWhereInput): readonly JobPosting[] => {
    const key = JSON.stringify(where);
    const cached = selections.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const evaluated = asEvaluatedWhere(where);
    const selected = rows.filter((row) => matchesWhere(row, evaluated));

    selections.set(key, selected);

    return selected;
  };

  const rowsFor = (
    where: Prisma.JobPostingWhereInput,
    orderBy: readonly Prisma.JobPostingOrderByWithRelationInput[],
  ): readonly JobPosting[] => {
    const compare = comparatorOf(orderBy);
    const selection = selectionFor(where);

    statements += 1;

    // One tie order per statement, computed once rather than per comparison.
    const tieOrder = new Map(selection.map((row) => [row.id, tieOrderOf(statements, row.id)]));
    const tieOrderIn = (row: JobPosting): number => tieOrder.get(row.id) ?? 0;

    return [...selection].sort(
      (left, right) => compare(left, right) || compareNumbers(tieOrderIn(left), tieOrderIn(right)),
    );
  };

  const store: PostingStore = {
    jobPosting: {
      count: (args: Prisma.JobPostingCountArgs) =>
        Promise.resolve(selectionFor(args.where ?? {}).length),

      findMany: (args: Prisma.JobPostingFindManyArgs) => {
        const ordered = rowsFor(args.where ?? {}, orderByListOf(args.orderBy));
        const skip = args.skip ?? 0;

        return Promise.resolve(ordered.slice(skip, skip + (args.take ?? ordered.length)));
      },
      // Only the two methods the read calls are modelled; the cast keeps the fixture to the surface
      // under test, as in `./job-posting-delegate.fixture.ts`.
    } as unknown as PostingStore['jobPosting'],
  };

  return { store, rowsFor };
};

/**
 * The oracle: the identifiers of the filtered and sorted result of one read, unpaginated.
 *
 * The same filter and the same order as the read under test, and the grouping of 11.3 where it is in
 * force — the grouped list is the concatenation "marked, then unmarked", so its unpaginated form is
 * the concatenation of the two unpaginated groups.
 */
const unpaginatedIdsOf = (
  fixture: EvaluatorFixture,
  input: FindPostingPageInput,
): readonly string[] => {
  const where = postingWhereOf(input.filter, input.commuteThresholdMinutes);
  const orderBy = postingOrderByOf(input.sort);
  const groups = newFirstGroupingFor(input.sort, input.latestCompletedRunId);
  const idsOf = (groupWhere: Prisma.JobPostingWhereInput): readonly string[] =>
    fixture.rowsFor(groupWhere, orderBy).map((row) => row.id);

  return groups === null
    ? idsOf(where)
    : [...idsOf({ AND: [where, groups.marked] }), ...idsOf({ AND: [where, groups.unmarked] })];
};

// --------------------------------------------------------------------------------------------
// Properties
// --------------------------------------------------------------------------------------------

describe('Property 26: Pagination partitions the filtered and sorted result', () => {
  /**
   * **Validates: Requirements 10.9**
   *
   * The window arithmetic on its own: for all result sizes from 0 to 300 and all requested page
   * sizes, the windows of the pages 1 to `pageCount` cut the result into consecutive pieces that
   * concatenate back to it, every page holds at most the page size and at most 25 entries, every
   * page up to `pageCount` holds at least one entry, every page beyond it holds none, `pageCount`
   * is `ceil(totalCount / pageSize)`, and a request that names no page is read as the first one.
   */
  it('cuts a result of any size into consecutive pages of at most 25 entries', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 300 }), pageSizeArbitrary, (totalCount, requested) => {
        const entries = Array.from({ length: totalCount }, (_unused, index) => idOf(index));
        const { pageSize } = postingPageWindowOf(1, requested);
        const pageCount = pageCountOf(totalCount, pageSize);

        expect(pageSize).toBeLessThanOrEqual(POSTING_PAGE_SIZE);
        expect(pageCount).toBe(Math.ceil(totalCount / pageSize));

        const pages: string[][] = [];

        // Two pages past the last one: 10.9 navigates to the next page, and the page after the last
        // is a real, empty window rather than the last page served again.
        for (let page = 1; page <= pageCount + 2; page += 1) {
          const window = postingPageWindowOf(page, requested);

          expect(window).toMatchObject({ page, pageSize, take: pageSize });
          expect(window.skip).toBe((page - 1) * pageSize);

          const entriesOfPage = entries.slice(window.skip, window.skip + window.take);

          expect(entriesOfPage.length).toBeLessThanOrEqual(pageSize);
          expect(entriesOfPage.length).toBeLessThanOrEqual(POSTING_PAGE_SIZE);
          expect(entriesOfPage.length > 0).toBe(page <= pageCount);

          pages.push(entriesOfPage);
        }

        // The partition: every entry on exactly one page, in the global order.
        expect(pages.flat()).toEqual(entries);

        // The first page is what an opened overview gets, whatever the client sent (10.9).
        for (const opening of [0, -7, 0.5, Number.NaN]) {
          expect(postingPageWindowOf(opening, requested)).toMatchObject({ page: 1, skip: 0 });
        }
      }),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 10.9**
   *
   * The same claim through `findPage`, over generated Job_Posting, filters, sortings and page sizes,
   * with and without the "neu" grouping of 11.3: the pages 1 to the reported `pageCount` hold every
   * entry of the filtered and sorted result exactly once and in its order, no page holds more than
   * 25 entries, the pages beyond `pageCount` are empty, `totalCount` is the size of the unpaginated
   * result, `pageCount` is `ceil(totalCount / pageSize)`, and an opened overview is answered with
   * the first page.
   */
  it('returns the filtered and sorted result exactly once across the pages of a read', async () => {
    await fc.assert(
      fc.asyncProperty(
        // `size: 'max'` because the design's generator asks for result sizes up to 300, and the
        // default sizing of fast-check 4 would keep every generated list in the single digits —
        // below one page, where there is no partition to speak of.
        fc.array(rowSpecArbitrary, { minLength: 0, maxLength: 300, size: 'max' }),
        filterArbitrary,
        sortArbitrary,
        pageSizeArbitrary,
        fc.option(fc.constantFrom(...RUN_IDS), { nil: null }),
        async (specs, filter, sort, pageSize, latestCompletedRunId) => {
          const fixture = createEvaluator(specs.map(rowOf));
          const repository = new PostingRepository(fixture.store);
          const input: FindPostingPageInput = {
            filter,
            sort,
            page: 1,
            pageSize,
            commuteThresholdMinutes: THRESHOLD_MINUTES,
            latestCompletedRunId,
          };

          const expectedIds = unpaginatedIdsOf(fixture, input);
          const effectivePageSize = postingPageWindowOf(1, pageSize).pageSize;
          const expectedPageCount = pageCountOf(expectedIds.length, effectivePageSize);
          const readIds: string[] = [];

          for (let page = 1; page <= expectedPageCount + 2; page += 1) {
            const result = await repository.findPage({ ...input, page });

            expect(result).toMatchObject({
              page,
              totalCount: expectedIds.length,
              pageCount: expectedPageCount,
            });
            expect(result.items.length).toBeLessThanOrEqual(effectivePageSize);
            expect(result.items.length).toBeLessThanOrEqual(POSTING_PAGE_SIZE);
            expect(result.items.length > 0).toBe(page <= expectedPageCount);

            readIds.push(...result.items.map((item) => item.id));
          }

          // Every entry exactly once and in the global order — which is only decidable because the
          // `{ id: 'asc' }` tiebreaker makes that order total.
          expect(readIds).toEqual([...expectedIds]);
          expect(new Set(readIds).size).toBe(readIds.length);

          // The first page is what the opened overview gets (10.9).
          const opened = await repository.findPage({ ...input, page: 0 });
          const first = await repository.findPage({ ...input, page: 1 });

          expect(opened.page).toBe(1);
          expect(opened.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
        },
      ),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 10.9**
   *
   * The grouped read assembles one page out of two windows, and those two windows are a partition of
   * that page: for all sizes of the marked and the unmarked group and all page sizes, the tail of the
   * marked group plus the head of the unmarked one is exactly the window of the page over the
   * concatenation, the two windows together ask for the page size, and the pages of the grouped list
   * concatenate back to it.
   *
   * The example-based coverage of `./new-marking.test.ts` states this for group sizes 0 to 30 and
   * four pages; what is generated here is the arithmetic itself, independently of the repository, so
   * a page that straddles the group boundary cannot lose or repeat an entry (11.3, 10.9).
   */
  it('splits every page of the grouped list into two windows that partition it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }),
        fc.integer({ min: 0, max: 60 }),
        pageSizeArbitrary,
        (markedCount, unmarkedCount, requested) => {
          const marked = Array.from({ length: markedCount }, (_unused, index) => `marked-${index}`);
          const unmarked = Array.from(
            { length: unmarkedCount },
            (_unused, index) => `unmarked-${index}`,
          );
          const grouped = [...marked, ...unmarked];
          const { pageSize } = postingPageWindowOf(1, requested);
          const pageCount = pageCountOf(grouped.length, pageSize);
          const readIds: string[] = [];

          for (let page = 1; page <= pageCount + 2; page += 1) {
            const window = postingPageWindowOf(page, requested);
            const slices = newFirstPageSlices({
              markedCount,
              skip: window.skip,
              take: window.take,
            });

            // The window of the page over the concatenation, as the repository would read it: a
            // group the page does not reach into contributes nothing.
            const entriesOfPage = [
              ...marked.slice(slices.markedSkip, slices.markedSkip + slices.markedTake),
              ...unmarked.slice(slices.unmarkedSkip, slices.unmarkedSkip + slices.unmarkedTake),
            ];

            expect(slices.markedTake + slices.unmarkedTake).toBe(window.take);
            expect(entriesOfPage).toEqual(grouped.slice(window.skip, window.skip + window.take));

            readIds.push(...entriesOfPage);
          }

          expect(readIds).toEqual(grouped);
        },
      ),
      PROPERTY_RUNS,
    );
  });
});
