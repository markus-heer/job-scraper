import type { InterestFlag, Platform, PostingStatus, RelevanceVerdict } from '@job-scraper/domain';

import type { JobPosting, Prisma } from '../prisma/prisma.types';

/**
 * How reachable a Job_Posting is, as the filter of 10.5 offers it.
 *
 * Not a stored column and therefore not part of `@job-scraper/domain`: the three values are a
 * reading of `bestCommuteMinutes` against the configured Commute_Threshold, so the same stored row
 * answers to a different value once the user changes the threshold. Declared as a tuple so the
 * GraphQL enum of task 15.3 is registered from this list rather than from a second one.
 *
 * - `WELL_REACHABLE` — a Best_Commute_Time of at most the Commute_Threshold (8.3, 8.11).
 * - `NOT_WELL_REACHABLE` — a known Best_Commute_Time above the Commute_Threshold.
 * - `UNKNOWN` — no Best_Commute_Time at all, the "unbekannt" of 8.13 and 10.1.
 */
export const REACHABILITIES = ['WELL_REACHABLE', 'NOT_WELL_REACHABLE', 'UNKNOWN'] as const;

/** One of the three reachability values of 10.5. */
export type Reachability = (typeof REACHABILITIES)[number];

/**
 * The filters of 10.5, every one of them optional and all of them conjunctive.
 *
 * Each member restricts the result on its own column, and the restrictions are combined with AND —
 * "several set filters have to be met simultaneously". That is also what makes the marking and the
 * Relevance_Verdict filters "take effect independently of the filter Posting_Status": they are
 * separate conjuncts over separate columns, so no value of one is derived from or overridden by the
 * other.
 *
 * An absent member and an empty array mean the same thing: this filter is not set. Collapsing the
 * two is what keeps one rule for all six filters instead of a per-filter reading of `[]`, and it is
 * the only reading that stays usable — a multi-select the user clears would otherwise ask for "no
 * Platform at all" and return an empty list the user cannot explain. "Default all Platform" (10.5)
 * is exactly this behaviour.
 *
 * The consequence for the default view is deliberate and documented on
 * {@link postingWhereOf}: an unset marking or verdict filter is not "everything", it is the default
 * view of 10.6 and 10.11.
 */
export interface PostingFilter {
  /** The Platform to include; unset means every Platform (10.5). */
  readonly platforms?: readonly Platform[];
  /** The reachability classes to include, read against the Commute_Threshold (8.11, 10.5). */
  readonly reachability?: readonly Reachability[];
  /** The Posting_Status to include; independent of the two filters below (10.5). */
  readonly postingStatuses?: readonly PostingStatus[];
  /** The Interest_Flag to include; unset applies the default view of 10.11. */
  readonly interestFlags?: readonly InterestFlag[];
  /** The Relevance_Verdict to include; unset applies the default view of 10.6. */
  readonly relevanceVerdicts?: readonly RelevanceVerdict[];
  /** Start of the recording period, inclusive; compared against the time of first recording. */
  readonly firstSeenFrom?: Date;
  /** End of the recording period, inclusive. */
  readonly firstSeenTo?: Date;
}

/** The four sort keys of 10.7. */
export type PostingSortField =
  'FIRST_SEEN_AT' | 'PUBLISHED_AT' | 'BEST_COMMUTE_MINUTES' | 'RELEVANCE';

/** One sort key with its direction; both directions are offered for each key (10.7). */
export interface PostingSort {
  readonly field: PostingSortField;
  readonly direction: 'ASC' | 'DESC';
}

/**
 * The sorting in force when the user chose none: recording time descending (10.7).
 *
 * The newest first recording is the first row, which is also the order the "neu" grouping of 11.3
 * sorts within its two groups.
 */
export const DEFAULT_POSTING_SORT: PostingSort = {
  field: 'FIRST_SEEN_AT',
  direction: 'DESC',
};

/**
 * The page size of 10.9, which is both the default and the maximum.
 *
 * One constant for both, because 10.9 names one number: a page holds at most 25 entries, so there
 * is no larger size a caller could legitimately ask for and nothing to honour above it.
 */
export const POSTING_PAGE_SIZE = 25;

/** The Relevance_Verdict the default view of 10.6 hides. */
const DEFAULT_HIDDEN_VERDICT: RelevanceVerdict = 'NOT_RELEVANT';

/** The Interest_Flag the default view of 10.11 hides. */
const DEFAULT_HIDDEN_INTEREST_FLAG: InterestFlag = 'NOT_INTERESTING';

/** A filter member that is set, i.e. present and non-empty. See {@link PostingFilter}. */
const selected = <TValue>(values: readonly TValue[] | undefined): readonly TValue[] | null =>
  values === undefined || values.length === 0 ? null : values;

/**
 * The `bestCommuteMinutes` predicate of one reachability value, read against the
 * Commute_Threshold (8.3, 8.11, 8.13).
 *
 * `WELL_REACHABLE` excludes a stored "unknown" without naming it: a comparison against `null` is
 * never true in SQL, so `lte` already hides the Job_Posting 8.11 asks to hide. The three predicates
 * are mutually exclusive and cover every row, which is what lets several selected values be
 * combined with OR without a row appearing twice.
 */
const reachabilityWhereOf = (
  reachability: Reachability,
  commuteThresholdMinutes: number,
): Prisma.JobPostingWhereInput => {
  switch (reachability) {
    case 'WELL_REACHABLE':
      return { bestCommuteMinutes: { lte: commuteThresholdMinutes } };
    case 'NOT_WELL_REACHABLE':
      return { bestCommuteMinutes: { gt: commuteThresholdMinutes } };
    case 'UNKNOWN':
      return { bestCommuteMinutes: null };
  }
};

/**
 * The filters of 10.5 as one `where` input (8.11, 10.5, 10.6, 10.11).
 *
 * Every set filter contributes one conjunct, and the two filters with a default view contribute one
 * either way — that is the whole mechanism behind 10.6 and 10.11. A Job_Posting with the
 * Relevance_Verdict "not relevant" or the Interest_Flag "not interesting" is hidden by a `not`
 * conjunct as long as the client sends no value for that filter, and becomes visible again the
 * moment it does, because an explicit value replaces the `not` instead of being added to it. There
 * is no stored flag and no second query behind the default view, so "keep it displayable again
 * through the filter" (10.6, 10.11) needs nothing but the filter value the user picked.
 *
 * The two defaults are independent of each other and of the Posting_Status conjunct: hiding a
 * "not interesting" posting happens "independently of its Posting_Status" (10.11), and a user who
 * filters for "no longer listed" postings still gets the default view of the other two columns.
 *
 * Pure and exported for its own sake: this is the decision the reference predicate of the property
 * tests is compared against, and it is the part of the read path that can be asserted without a
 * database.
 *
 * @param filter The filter values the client sent.
 * @param commuteThresholdMinutes The Commute_Threshold in force (8.10); read only by the
 *   reachability filter, which is the only filter whose meaning depends on configuration.
 */
export const postingWhereOf = (
  filter: PostingFilter,
  commuteThresholdMinutes: number,
): Prisma.JobPostingWhereInput => {
  const platforms = selected(filter.platforms);
  const reachability = selected(filter.reachability);
  const postingStatuses = selected(filter.postingStatuses);
  const interestFlags = selected(filter.interestFlags);
  const relevanceVerdicts = selected(filter.relevanceVerdicts);

  return {
    ...(platforms === null ? {} : { platform: { in: [...platforms] } }),
    ...(postingStatuses === null ? {} : { postingStatus: { in: [...postingStatuses] } }),

    // Set or not, these two are always present: an unset filter is the default view of 10.6 and
    // 10.11, not the absence of a condition.
    interestFlag:
      interestFlags === null ? { not: DEFAULT_HIDDEN_INTEREST_FLAG } : { in: [...interestFlags] },
    relevanceVerdict:
      relevanceVerdicts === null ? { not: DEFAULT_HIDDEN_VERDICT } : { in: [...relevanceVerdicts] },

    // The recording period of 10.5, inclusive at both ends. Each bound is sent on its own, so a
    // half-open period is a filter the user can set; a `from` after the `to` yields the empty
    // result, which is the honest answer rather than an error.
    ...(filter.firstSeenFrom === undefined && filter.firstSeenTo === undefined
      ? {}
      : {
          firstSeenAt: {
            ...(filter.firstSeenFrom === undefined ? {} : { gte: filter.firstSeenFrom }),
            ...(filter.firstSeenTo === undefined ? {} : { lte: filter.firstSeenTo }),
          },
        }),

    // A disjunction inside the conjunction: the selected reachability classes are alternatives to
    // each other, while the whole term still has to be met alongside every other filter.
    ...(reachability === null
      ? {}
      : {
          OR: reachability.map((value) => reachabilityWhereOf(value, commuteThresholdMinutes)),
        }),
  };
};

/**
 * The sorting of 10.7 as a total order over the stored Job_Posting.
 *
 * Three decisions the requirement pins down, and one it leaves open:
 *
 * - **"unknown" last.** A Job_Posting without a Best_Commute_Time goes to the end of the list when
 *   sorting by Best_Commute_Time, in *both* directions: 10.7 says "at the end", not "at the
 *   ascending end", and a reader scanning a descending list for the longest commute is no more
 *   interested in the unknown ones than a reader of the ascending list. `nulls: 'last'` is what
 *   says that in SQL; PostgreSQL would otherwise sort `NULL` last ascending and first descending.
 * - **The verdict order.** Sorting by Relevance_Verdict orders by `relevanceRank`, the denormalized
 *   sort key written from `RELEVANCE_RANK` in the same statement as the verdict. Ascending is the
 *   order 10.7 prescribes — relevant, uncertain, not assessed, not relevant — because that is the
 *   order the rank table encodes. The enum column itself is unusable here: PostgreSQL orders an
 *   enum by its declaration order, which is a different order.
 * - **The publication date.** Nullable as well (6.4, 6.9), and 10.7 says nothing about where a
 *   Job_Posting without a readable publication date belongs. It is sorted like the unknown commute
 *   times, at the end in both directions, because in both cases "we do not know" is the least
 *   useful row and a reader looking for the newest or the oldest advertisement wants neither.
 *
 * The `id` tiebreaker is the open part made total. Every sort key above has duplicates in practice
 * — two postings first recorded in the same Scrape_Run share a `firstSeenAt` to the millisecond,
 * and the verdict has four values for any number of rows — and SQL does not promise a stable order
 * for equal keys. Without a tiebreaker a row could appear on two pages of one paginated read or on
 * none, which is the one way pagination can lose an entry (10.9). `id` is unique, so appending it
 * makes the order total; ascending always, because its direction carries no meaning and a stable
 * rule is worth more than a symmetric one.
 *
 * @param sort The sort key and direction the user chose.
 */
export const postingOrderByOf = (
  sort: PostingSort,
): Prisma.JobPostingOrderByWithRelationInput[] => {
  const direction = sort.direction === 'ASC' ? 'asc' : 'desc';
  const tiebreaker: Prisma.JobPostingOrderByWithRelationInput = { id: 'asc' };

  switch (sort.field) {
    case 'FIRST_SEEN_AT':
      return [{ firstSeenAt: direction }, tiebreaker];
    case 'PUBLISHED_AT':
      return [{ publishedAt: { sort: direction, nulls: 'last' } }, tiebreaker];
    case 'BEST_COMMUTE_MINUTES':
      return [{ bestCommuteMinutes: { sort: direction, nulls: 'last' } }, tiebreaker];
    case 'RELEVANCE':
      return [{ relevanceRank: direction }, tiebreaker];
  }
};

/** The page a read actually returns, with the window it reads. */
export interface PostingPageWindow {
  /** The page number in force, counted from 1. */
  readonly page: number;
  /** The page size in force, at most {@link POSTING_PAGE_SIZE}. */
  readonly pageSize: number;
  /** Rows to skip, never negative. */
  readonly skip: number;
  /** Rows to read, equal to `pageSize`. */
  readonly take: number;
}

/**
 * The window of one page, normalized so that every input names a real page (10.9).
 *
 * Normalizing rather than rejecting, for two reasons. The page size has an upper bound the
 * requirement fixes at 25, so a larger request has nothing to honour — serving 25 is the answer,
 * not an error, and the clamp is also what keeps a client from asking the Posting_Store for every
 * stored row at once. And a page number below 1 or a fractional one names no page at all, while the
 * user's intent is unambiguous: show the first one, which is what 10.9 asks for when the overview is
 * opened.
 *
 * A page *above* the last one is deliberately not clamped. It is a real window, it is empty, and
 * reporting it as such keeps the pages a partition of the result: pages 1 to `pageCount` hold every
 * entry exactly once and every page beyond holds nothing.
 *
 * @param page The requested page number, counted from 1.
 * @param pageSize The requested page size; capped at {@link POSTING_PAGE_SIZE}.
 */
export const postingPageWindowOf = (page: number, pageSize: number): PostingPageWindow => {
  const safePage = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
  const safePageSize = Number.isFinite(pageSize)
    ? Math.min(POSTING_PAGE_SIZE, Math.max(1, Math.trunc(pageSize)))
    : POSTING_PAGE_SIZE;

  return {
    page: safePage,
    pageSize: safePageSize,
    skip: (safePage - 1) * safePageSize,
    take: safePageSize,
  };
};

/**
 * The number of pages the filtered result is presented in (10.9).
 *
 * `ceil(totalCount / pageSize)`, and therefore 0 for an empty result: an empty list has no page to
 * navigate to, and the two empty states of 10.12 and 10.13 are what the Web_App shows instead of a
 * page. A caller that wants to print "page 1 of 1" for an empty result does that in the Web_App,
 * where the German text lives.
 */
export const pageCountOf = (totalCount: number, pageSize: number): number =>
  pageSize <= 0 ? 0 : Math.ceil(totalCount / pageSize);

/** One page of the posting overview (10.9). */
export interface PostingPage {
  /** The Job_Posting of this page, filtered, sorted and cut to the page size. */
  readonly items: readonly JobPosting[];
  /** How many Job_Posting the filter matched in total, across every page. */
  readonly totalCount: number;
  /** How many pages those entries fill: `ceil(totalCount / pageSize)`. */
  readonly pageCount: number;
  /**
   * The page number these entries are from, after normalization.
   *
   * Reported rather than left to the caller because the caller's number may have been normalized by
   * {@link postingPageWindowOf}, and 10.9 asks for the *current* page number to be displayed.
   */
  readonly page: number;
}

/**
 * Everything one paginated read of the posting overview needs (8.11, 10.5, 10.6, 10.7, 10.9, 10.11).
 *
 * Three of the five members are the user's request — the filter, the sorting and the page — and two
 * are context the caller resolves before asking: the Commute_Threshold in force and the identifier
 * of the most recently completed Scrape_Run. Both are passed in rather than looked up here, so the
 * repository keeps its single dependency on the `JobPosting` delegate and so one request reads one
 * consistent pair of context values instead of two queries that could disagree.
 */
export interface FindPostingPageInput {
  /** The filters of 10.5; an empty object is the default view of 10.6 and 10.11. */
  readonly filter: PostingFilter;
  /** The sorting of 10.7; {@link DEFAULT_POSTING_SORT} when the user chose none. */
  readonly sort: PostingSort;
  /** The requested page, counted from 1 and normalized by {@link postingPageWindowOf}. */
  readonly page: number;
  /** The requested page size, capped at {@link POSTING_PAGE_SIZE}. */
  readonly pageSize: number;
  /**
   * The Commute_Threshold in force, in minutes (8.10).
   *
   * Read only by the reachability filter of 8.11 and 10.5, and read by it on every request: the
   * user can change the threshold, and a stored Job_Posting then changes its reachability class
   * without being written. The caller takes it from `AppConfigService.commuteThresholdMinutes`,
   * which is the one place that knows whether the environment file or the last accepted value won.
   */
  readonly commuteThresholdMinutes: number;
  /**
   * Identifier of the most recently completed Scrape_Run, or `null` where none completed yet.
   *
   * The input the "neu" marking of 11.2 and the default grouping of 11.3 are derived from. It is
   * part of this contract because it is part of one read — resolving it separately would let the
   * grouping of a page disagree with the marking of its rows. The grouping itself arrives with task
   * 15.2, which is the one place that reads this value.
   */
  readonly latestCompletedRunId: string | null;
}
