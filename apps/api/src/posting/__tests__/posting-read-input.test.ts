/**
 * The translation between the published GraphQL input and the read contract (10.5, 10.6, 10.7,
 * 10.11).
 *
 * One question, asked three ways: does a filter the client *cleared* reach the repository as "not
 * set"? A nullable GraphQL field arrives as `null` when the client sends it explicitly, and
 * `postingWhereOf` reads "not set" as the default view of 10.6 and 10.11 — so a `null` that got
 * through as a value would be compared against a stored column and the overview would answer a
 * cleared multi-select with an empty list.
 *
 * Requirements: 10.5, 10.6, 10.7, 10.11.
 */

import { describe, expect, it } from 'vitest';

import type { JobPostingFilterInput } from '../models/job-posting-filter.input';
import type { JobPostingSortInput } from '../models/job-posting-sort.input';
import { DEFAULT_POSTING_SORT } from '../posting-page-query';
import { postingFilterOf, postingSortOf } from '../posting-read-input';

describe('postingFilterOf', () => {
  it('passes every set filter through unchanged (10.5)', () => {
    const input: JobPostingFilterInput = {
      platforms: ['STEPSTONE', 'INDEED'],
      reachability: ['WELL_REACHABLE'],
      postingStatuses: ['LISTED'],
      interestFlags: ['UNMARKED', 'NOT_INTERESTING'],
      relevanceVerdicts: ['RELEVANT', 'UNCERTAIN'],
      firstSeenFrom: new Date('2026-03-01T00:00:00.000Z'),
      firstSeenTo: new Date('2026-03-31T23:59:59.000Z'),
    };

    expect(postingFilterOf(input)).toEqual({
      platforms: ['STEPSTONE', 'INDEED'],
      reachability: ['WELL_REACHABLE'],
      postingStatuses: ['LISTED'],
      interestFlags: ['UNMARKED', 'NOT_INTERESTING'],
      relevanceVerdicts: ['RELEVANT', 'UNCERTAIN'],
      firstSeenFrom: new Date('2026-03-01T00:00:00.000Z'),
      firstSeenTo: new Date('2026-03-31T23:59:59.000Z'),
    });
  });

  it('reads an explicitly cleared filter as not set rather than as a value (10.6, 10.11)', () => {
    const cleared: JobPostingFilterInput = {
      platforms: null,
      reachability: null,
      postingStatuses: null,
      interestFlags: null,
      relevanceVerdicts: null,
      firstSeenFrom: null,
      firstSeenTo: null,
    };

    const filter = postingFilterOf(cleared);

    expect(filter.platforms).toBeUndefined();
    expect(filter.reachability).toBeUndefined();
    expect(filter.postingStatuses).toBeUndefined();
    expect(filter.interestFlags).toBeUndefined();
    expect(filter.relevanceVerdicts).toBeUndefined();
    expect(filter.firstSeenFrom).toBeUndefined();
    expect(filter.firstSeenTo).toBeUndefined();
  });

  it('answers an absent argument with the empty filter, which is the default view', () => {
    expect(postingFilterOf(undefined)).toEqual({});
    expect(postingFilterOf(null)).toEqual({});
  });

  it('keeps an empty list, which the read contract reads as not set as well (10.5)', () => {
    expect(postingFilterOf({ platforms: [] }).platforms).toEqual([]);
  });
});

describe('postingSortOf', () => {
  it('passes the chosen sorting through (10.7)', () => {
    const input: JobPostingSortInput = { field: 'BEST_COMMUTE_MINUTES', direction: 'ASC' };

    expect(postingSortOf(input)).toEqual({ field: 'BEST_COMMUTE_MINUTES', direction: 'ASC' });
  });

  it('answers an absent argument with the recording time descending (10.7)', () => {
    expect(postingSortOf(undefined)).toEqual(DEFAULT_POSTING_SORT);
    expect(postingSortOf(null)).toEqual(DEFAULT_POSTING_SORT);
  });
});
