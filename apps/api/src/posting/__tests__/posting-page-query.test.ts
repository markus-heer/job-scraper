/**
 * Unit tests for the decisions behind one page of the posting overview (8.11, 10.5, 10.6, 10.7,
 * 10.9, 10.11).
 *
 * Three questions, one per exported function, and all three answerable without a Posting_Store
 * because `./../posting-page-query.ts` is where the read path makes its decisions rather than where
 * it runs them:
 *
 * - **Which conjuncts a filter combination becomes.** The interesting part is not that a selected
 *   Platform narrows the result — it is that an *unset* marking or verdict filter is the default view
 *   of 10.6 and 10.11, that an explicit value replaces that default instead of being added to it,
 *   and that neither interacts with the Posting_Status conjunct (10.5).
 * - **Which order a sort key produces.** Asserted as the `orderBy` input, including the two places
 *   10.7 is specific about: the unknown Best_Commute_Time at the end in both directions and the
 *   verdict order through `relevanceRank`.
 * - **Which window a page number names.** Including the inputs that name no page at all, which is
 *   the error case of this module: page 0, a negative page, a fractional one, a page size above the
 *   25 of 10.9 and a non-finite number.
 *
 * What these tests deliberately do not assert is that PostgreSQL executes those inputs as described.
 * That is a statement about the engine, and it is made in
 * `./posting.repository.find-page.integration.test.ts` against a real database. The property-based
 * coverage of the filters, the order and the pagination is Properties 24 to 26 (tasks 15.5 to 15.7).
 */

import {
  INTEREST_FLAGS,
  PLATFORMS,
  POSTING_STATUSES,
  RELEVANCE_VERDICTS,
} from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTING_SORT,
  pageCountOf,
  POSTING_PAGE_SIZE,
  postingOrderByOf,
  postingPageWindowOf,
  type PostingSortField,
  postingWhereOf,
  REACHABILITIES,
} from '../posting-page-query';

/** The Commute_Threshold of 8.10, the value the reachability filter is read against. */
const THRESHOLD_MINUTES = 60;

/** The two conjuncts that are present whether or not the client set those filters. */
const DEFAULT_VIEW_CONJUNCTS = {
  interestFlag: { not: 'NOT_INTERESTING' },
  relevanceVerdict: { not: 'NOT_RELEVANT' },
} as const;

describe('postingWhereOf', () => {
  it('hides "not relevant" and "not interesting" postings when no filter is set (10.6, 10.11)', () => {
    expect(postingWhereOf({}, THRESHOLD_MINUTES)).toEqual(DEFAULT_VIEW_CONJUNCTS);
  });

  it('treats an empty selection as an unset filter, so a cleared multi-select keeps the default view', () => {
    expect(
      postingWhereOf(
        {
          platforms: [],
          reachability: [],
          postingStatuses: [],
          interestFlags: [],
          relevanceVerdicts: [],
        },
        THRESHOLD_MINUTES,
      ),
    ).toEqual(DEFAULT_VIEW_CONJUNCTS);
  });

  it('makes "not relevant" postings visible again through an explicit verdict filter (10.6)', () => {
    expect(postingWhereOf({ relevanceVerdicts: ['NOT_RELEVANT'] }, THRESHOLD_MINUTES)).toEqual({
      interestFlag: { not: 'NOT_INTERESTING' },
      relevanceVerdict: { in: ['NOT_RELEVANT'] },
    });
  });

  it('makes "not interesting" postings visible again through an explicit marking filter (10.11)', () => {
    expect(postingWhereOf({ interestFlags: [...INTEREST_FLAGS] }, THRESHOLD_MINUTES)).toEqual({
      interestFlag: { in: [...INTEREST_FLAGS] },
      relevanceVerdict: { not: 'NOT_RELEVANT' },
    });
  });

  it('keeps the marking and verdict filters independent of the Posting_Status filter (10.5)', () => {
    expect(
      postingWhereOf(
        {
          postingStatuses: ['NO_LONGER_LISTED'],
          interestFlags: ['NOT_INTERESTING'],
          relevanceVerdicts: ['RELEVANT', 'UNCERTAIN'],
        },
        THRESHOLD_MINUTES,
      ),
    ).toEqual({
      postingStatus: { in: ['NO_LONGER_LISTED'] },
      interestFlag: { in: ['NOT_INTERESTING'] },
      relevanceVerdict: { in: ['RELEVANT', 'UNCERTAIN'] },
    });
  });

  it('combines every set filter conjunctively (10.5)', () => {
    const firstSeenFrom = new Date('2026-03-01T00:00:00.000Z');
    const firstSeenTo = new Date('2026-03-31T23:59:59.999Z');

    expect(
      postingWhereOf(
        {
          platforms: ['STEPSTONE', 'JOBVECTOR'],
          reachability: ['WELL_REACHABLE'],
          postingStatuses: [...POSTING_STATUSES],
          interestFlags: ['UNMARKED'],
          relevanceVerdicts: [...RELEVANCE_VERDICTS],
          firstSeenFrom,
          firstSeenTo,
        },
        THRESHOLD_MINUTES,
      ),
    ).toEqual({
      platform: { in: ['STEPSTONE', 'JOBVECTOR'] },
      postingStatus: { in: [...POSTING_STATUSES] },
      interestFlag: { in: ['UNMARKED'] },
      relevanceVerdict: { in: [...RELEVANCE_VERDICTS] },
      firstSeenAt: { gte: firstSeenFrom, lte: firstSeenTo },
      OR: [{ bestCommuteMinutes: { lte: THRESHOLD_MINUTES } }],
    });
  });

  it('selects every Platform when none is chosen (10.5)', () => {
    expect(postingWhereOf({ platforms: [...PLATFORMS] }, THRESHOLD_MINUTES)).toMatchObject({
      platform: { in: [...PLATFORMS] },
    });
    expect(postingWhereOf({}, THRESHOLD_MINUTES)).not.toHaveProperty('platform');
  });

  it('reads the well-reachable filter against the threshold and so hides "unknown" (8.11)', () => {
    expect(postingWhereOf({ reachability: ['WELL_REACHABLE'] }, 45)).toMatchObject({
      OR: [{ bestCommuteMinutes: { lte: 45 } }],
    });
  });

  it('offers the three reachability classes as alternatives to each other (10.5)', () => {
    expect(postingWhereOf({ reachability: [...REACHABILITIES] }, THRESHOLD_MINUTES)).toMatchObject({
      OR: [
        { bestCommuteMinutes: { lte: THRESHOLD_MINUTES } },
        { bestCommuteMinutes: { gt: THRESHOLD_MINUTES } },
        { bestCommuteMinutes: null },
      ],
    });
  });

  it('accepts a half-open recording period (10.5)', () => {
    const firstSeenFrom = new Date('2026-03-01T00:00:00.000Z');
    const firstSeenTo = new Date('2026-03-31T23:59:59.999Z');

    expect(postingWhereOf({ firstSeenFrom }, THRESHOLD_MINUTES)).toMatchObject({
      firstSeenAt: { gte: firstSeenFrom },
    });
    expect(postingWhereOf({ firstSeenTo }, THRESHOLD_MINUTES)).toMatchObject({
      firstSeenAt: { lte: firstSeenTo },
    });
    expect(postingWhereOf({}, THRESHOLD_MINUTES)).not.toHaveProperty('firstSeenAt');
  });
});

describe('postingOrderByOf', () => {
  it('sorts by recording time descending by default (10.7)', () => {
    expect(DEFAULT_POSTING_SORT).toEqual({ field: 'FIRST_SEEN_AT', direction: 'DESC' });
    expect(postingOrderByOf(DEFAULT_POSTING_SORT)).toEqual([
      { firstSeenAt: 'desc' },
      { id: 'asc' },
    ]);
  });

  it('offers every sort key in both directions and ends every order with the unique tiebreaker (10.7, 10.9)', () => {
    const fields: readonly PostingSortField[] = [
      'FIRST_SEEN_AT',
      'PUBLISHED_AT',
      'BEST_COMMUTE_MINUTES',
      'RELEVANCE',
    ];

    for (const field of fields) {
      for (const direction of ['ASC', 'DESC'] as const) {
        const orderBy = postingOrderByOf({ field, direction });

        expect(orderBy).toHaveLength(2);
        expect(orderBy.at(-1)).toEqual({ id: 'asc' });
      }
    }
  });

  it('places an unknown Best_Commute_Time at the end of the list in both directions (10.7)', () => {
    expect(postingOrderByOf({ field: 'BEST_COMMUTE_MINUTES', direction: 'ASC' })[0]).toEqual({
      bestCommuteMinutes: { sort: 'asc', nulls: 'last' },
    });
    expect(postingOrderByOf({ field: 'BEST_COMMUTE_MINUTES', direction: 'DESC' })[0]).toEqual({
      bestCommuteMinutes: { sort: 'desc', nulls: 'last' },
    });
  });

  it('places a missing publication date at the end of the list in both directions', () => {
    expect(postingOrderByOf({ field: 'PUBLISHED_AT', direction: 'ASC' })[0]).toEqual({
      publishedAt: { sort: 'asc', nulls: 'last' },
    });
    expect(postingOrderByOf({ field: 'PUBLISHED_AT', direction: 'DESC' })[0]).toEqual({
      publishedAt: { sort: 'desc', nulls: 'last' },
    });
  });

  it('orders the Relevance_Verdict through the denormalized rank, ascending first (10.7)', () => {
    expect(postingOrderByOf({ field: 'RELEVANCE', direction: 'ASC' })[0]).toEqual({
      relevanceRank: 'asc',
    });
    expect(postingOrderByOf({ field: 'RELEVANCE', direction: 'DESC' })[0]).toEqual({
      relevanceRank: 'desc',
    });
  });
});

describe('postingPageWindowOf', () => {
  it('reads the first page when the overview is opened (10.9)', () => {
    expect(postingPageWindowOf(1, POSTING_PAGE_SIZE)).toEqual({
      page: 1,
      pageSize: 25,
      skip: 0,
      take: 25,
    });
  });

  it('skips the entries of the preceding pages (10.9)', () => {
    expect(postingPageWindowOf(3, POSTING_PAGE_SIZE)).toMatchObject({ skip: 50, take: 25 });
  });

  it('never reads more than 25 entries per page (10.9)', () => {
    for (const requested of [26, 100, 1_000_000]) {
      expect(postingPageWindowOf(1, requested)).toMatchObject({ pageSize: 25, take: 25 });
    }
  });

  it('reads the first page for a page number that names no page', () => {
    for (const requested of [0, -1, -42, 0.5]) {
      expect(postingPageWindowOf(requested, POSTING_PAGE_SIZE)).toMatchObject({
        page: 1,
        skip: 0,
      });
    }
  });

  it('truncates a fractional page number rather than skipping a fraction of a page', () => {
    expect(postingPageWindowOf(2.9, POSTING_PAGE_SIZE)).toMatchObject({ page: 2, skip: 25 });
  });

  it('reads at least one entry per page for a page size that names no page', () => {
    for (const requested of [0, -5, 0.4]) {
      expect(postingPageWindowOf(1, requested)).toMatchObject({ pageSize: 1, take: 1 });
    }
  });

  it('falls back to the first full page for a non-finite request', () => {
    expect(postingPageWindowOf(Number.NaN, Number.NaN)).toEqual({
      page: 1,
      pageSize: 25,
      skip: 0,
      take: 25,
    });
    expect(postingPageWindowOf(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toEqual({
      page: 1,
      pageSize: 25,
      skip: 0,
      take: 25,
    });
  });

  it('keeps a page beyond the last one as the empty window it is', () => {
    expect(postingPageWindowOf(99, POSTING_PAGE_SIZE)).toMatchObject({ page: 99, skip: 2450 });
  });
});

describe('pageCountOf', () => {
  it('reports the number of pages the entries fill (10.9)', () => {
    expect(pageCountOf(1, 25)).toBe(1);
    expect(pageCountOf(25, 25)).toBe(1);
    expect(pageCountOf(26, 25)).toBe(2);
    expect(pageCountOf(300, 25)).toBe(12);
  });

  it('reports no page for an empty result, which is the empty state of 10.12 and 10.13', () => {
    expect(pageCountOf(0, 25)).toBe(0);
  });

  it('reports no page for a page size that holds nothing', () => {
    expect(pageCountOf(10, 0)).toBe(0);
  });
});
