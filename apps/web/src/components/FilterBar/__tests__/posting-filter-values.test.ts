import { INTEREST_FLAGS, RELEVANCE_VERDICTS } from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import {
  ALL_VALUES,
  DEFAULT_FILTER_VALUES,
  DEFAULT_VIEW,
  hasSetFilter,
  postingFilterInputOf,
  type PostingFilterValues,
} from '../posting-filter-values';

/**
 * Tests of the translation from the filter bar's form state into `JobPostingFilterInput`
 * (task 17.2).
 *
 * The markup of the bar is the subject of the component tests of task 17.7. What is asserted here
 * is the decision those tests cannot see: which filter member reaches the API_Service and which one
 * is left out. That distinction is load-bearing, because `postingWhereOf` on the API_Service side
 * reads an absent marking or Relevance_Verdict filter as the default view of 10.6 and 10.11 rather
 * than as "no restriction" — so the difference between omitting a member and sending its complete
 * value list is the difference between a Job_Posting staying hidden and becoming visible again.
 *
 * Requirements: 8.11, 10.5, 10.6, 10.11, 10.13.
 */

/** The default filter set with single fields replaced, so each case names only what it is about. */
const valuesWith = (overrides: Partial<PostingFilterValues>): PostingFilterValues => ({
  ...DEFAULT_FILTER_VALUES,
  ...overrides,
});

describe('posting filter values', () => {
  it('sends no filter at all for the state the overview opens in', () => {
    // The empty input is the default view of 10.6 and 10.11, not "everything": the API_Service adds
    // the two exclusions itself when the members are absent.
    expect(postingFilterInputOf(DEFAULT_FILTER_VALUES)).toEqual({});
    expect(hasSetFilter(DEFAULT_FILTER_VALUES)).toBe(false);
  });

  it('omits a list filter nothing is ticked in, which is "default all" (10.5)', () => {
    const input = postingFilterInputOf(
      valuesWith({ platforms: [], reachability: [], postingStatuses: [] }),
    );

    expect(input).not.toHaveProperty('platforms');
    expect(input).not.toHaveProperty('reachability');
    expect(input).not.toHaveProperty('postingStatuses');
  });

  it('sends every ticked value of a list filter', () => {
    const input = postingFilterInputOf(
      valuesWith({
        platforms: ['INDEED', 'STEPSTONE'],
        reachability: ['WELL_REACHABLE'],
        postingStatuses: ['NO_LONGER_LISTED'],
      }),
    );

    expect(input.platforms).toEqual(['INDEED', 'STEPSTONE']);
    // 8.11: "nur gut erreichbare Treffer" is this one value; the API_Service's `lte` comparison
    // then hides the Job_Posting with an unknown Best_Commute_Time without naming it.
    expect(input.reachability).toEqual(['WELL_REACHABLE']);
    expect(input.postingStatuses).toEqual(['NO_LONGER_LISTED']);
  });

  it('sends the complete value list for "Alle" on the marking and the verdict filter', () => {
    const input = postingFilterInputOf(
      valuesWith({ marking: ALL_VALUES, relevanceVerdict: ALL_VALUES }),
    );

    // Complete, and therefore an explicit filter that replaces the default-view exclusion. An
    // incomplete list here would keep exactly the Job_Posting hidden that the user asked to see.
    expect([...(input.interestFlags ?? [])].sort()).toEqual([...INTEREST_FLAGS].sort());
    expect([...(input.relevanceVerdicts ?? [])].sort()).toEqual([...RELEVANCE_VERDICTS].sort());
  });

  it('distinguishes "Alle" from the default view on both filters', () => {
    const defaultView = postingFilterInputOf(DEFAULT_FILTER_VALUES);
    const all = postingFilterInputOf(
      valuesWith({ marking: ALL_VALUES, relevanceVerdict: ALL_VALUES }),
    );

    expect(defaultView).not.toHaveProperty('interestFlags');
    expect(defaultView).not.toHaveProperty('relevanceVerdicts');
    expect(all.interestFlags).toBeDefined();
    expect(all.relevanceVerdicts).toBeDefined();
  });

  it('sends one picked value as a single-element list', () => {
    const input = postingFilterInputOf(
      valuesWith({ marking: 'NOT_INTERESTING', relevanceVerdict: 'NOT_RELEVANT' }),
    );

    // The two values the default view hides. Picking them is how 10.6 and 10.11 keep a hidden
    // Job_Posting "displayable again through the filter".
    expect(input.interestFlags).toEqual(['NOT_INTERESTING']);
    expect(input.relevanceVerdicts).toEqual(['NOT_RELEVANT']);
  });

  it('keeps the two filters independent of the Posting_Status filter (10.5)', () => {
    const input = postingFilterInputOf(
      valuesWith({
        postingStatuses: ['LISTED'],
        marking: 'NOT_INTERESTING',
        relevanceVerdict: ALL_VALUES,
      }),
    );

    // Three separate members over three separate columns: no value of one is derived from another,
    // which is what "take effect independently" amounts to on this side of the wire.
    expect(input.postingStatuses).toEqual(['LISTED']);
    expect(input.interestFlags).toEqual(['NOT_INTERESTING']);
    expect(input.relevanceVerdicts).toHaveLength(RELEVANCE_VERDICTS.length);
  });

  it('turns the recording period into bounds that include both picked days', () => {
    const input = postingFilterInputOf(
      valuesWith({ firstSeenFrom: '2026-10-05', firstSeenTo: '2026-10-05' }),
    );

    // One picked day for both ends has to match everything recorded on it, so the bounds are the
    // first and the last instant of that day rather than midnight twice.
    expect(input.firstSeenFrom).toBe('2026-10-05T00:00:00.000Z');
    expect(input.firstSeenTo).toBe('2026-10-05T23:59:59.999Z');
  });

  it('sends either bound of the recording period on its own', () => {
    const fromOnly = postingFilterInputOf(valuesWith({ firstSeenFrom: '2026-01-02' }));
    const toOnly = postingFilterInputOf(valuesWith({ firstSeenTo: '2026-01-02' }));

    expect(fromOnly.firstSeenFrom).toBe('2026-01-02T00:00:00.000Z');
    expect(fromOnly).not.toHaveProperty('firstSeenTo');
    expect(toOnly).not.toHaveProperty('firstSeenFrom');
    expect(toOnly.firstSeenTo).toBe('2026-01-02T23:59:59.999Z');
  });

  it('treats an incomplete date as no bound rather than as a timestamp', () => {
    const input = postingFilterInputOf(valuesWith({ firstSeenFrom: '2026-10', firstSeenTo: '' }));

    expect(input).not.toHaveProperty('firstSeenFrom');
    expect(input).not.toHaveProperty('firstSeenTo');
  });

  it('never sends a member as null', () => {
    // `postingFilterInputOf` on the API_Service side collapses null into "not set", so a null would
    // be read as the default view instead of as the value the user chose.
    const everything = postingFilterInputOf(
      valuesWith({
        platforms: ['GLASSDOOR'],
        reachability: ['UNKNOWN'],
        postingStatuses: ['LISTED'],
        marking: ALL_VALUES,
        relevanceVerdict: 'UNCERTAIN',
        firstSeenFrom: '2026-03-01',
        firstSeenTo: '2026-03-31',
      }),
    );

    expect(Object.values(everything)).not.toContain(null);
    expect(Object.keys(everything)).toHaveLength(7);
  });

  it('reports a set filter per filter dimension, and none for the default view', () => {
    expect(hasSetFilter(valuesWith({ platforms: ['INDEED'] }))).toBe(true);
    expect(hasSetFilter(valuesWith({ reachability: ['UNKNOWN'] }))).toBe(true);
    expect(hasSetFilter(valuesWith({ postingStatuses: ['LISTED'] }))).toBe(true);
    expect(hasSetFilter(valuesWith({ marking: ALL_VALUES }))).toBe(true);
    expect(hasSetFilter(valuesWith({ relevanceVerdict: 'RELEVANT' }))).toBe(true);
    expect(hasSetFilter(valuesWith({ firstSeenFrom: '2026-10-05' }))).toBe(true);
    expect(hasSetFilter(valuesWith({ firstSeenTo: '2026-10-05' }))).toBe(true);

    expect(
      hasSetFilter(valuesWith({ marking: DEFAULT_VIEW, relevanceVerdict: DEFAULT_VIEW })),
    ).toBe(false);
  });
});
