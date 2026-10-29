/**
 * Parity between every closed value list and the union type derived from it, plus the totality of
 * `RELEVANCE_RANK` over `RELEVANCE_VERDICTS` (10.7).
 *
 * Each parity check pairs the runtime tuple with an exhaustive `Record<Union, true>` written out by
 * hand. That catches drift in both directions: adding a value to the tuple without touching the
 * record fails the type check, because the record then misses a key of the union; removing one from
 * the tuple fails the runtime set comparison. Prisma parity is asserted separately in
 * `apps/api/src/prisma/__tests__/enum-parity.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  COMMUTE_MODES,
  COMMUTE_PRECISIONS,
  type CommuteMode,
  type CommutePrecision,
  INTEREST_FLAGS,
  type InterestFlag,
  type Platform,
  PLATFORM_STATUSES,
  PLATFORMS,
  type PlatformStatus,
  POSTING_STATUSES,
  type PostingStatus,
  RELEVANCE_RANK,
  RELEVANCE_VERDICTS,
  type RelevanceVerdict,
  RUN_OUTCOMES,
  RUN_STATUSES,
  type RunOutcome,
  type RunStatus,
} from '../src/enums.js';
import { EMPLOYMENT_TYPES, type EmploymentType } from '../src/search-profile/types.js';

/**
 * Asserts that the tuple and the union hold exactly the same values and that the tuple is free of
 * duplicates.
 */
function expectVocabularyParity<T extends string>(
  values: readonly T[],
  exhaustive: Readonly<Record<T, true>>,
): void {
  const unionMembers = Object.keys(exhaustive);

  expect(new Set(values)).toEqual(new Set(unionMembers));
  expect(new Set(values).size).toBe(values.length);
  expect(values.length).toBe(unionMembers.length);
}

describe('closed value lists', () => {
  it('keeps PLATFORMS and Platform in parity', () => {
    expectVocabularyParity<Platform>(PLATFORMS, {
      GLASSDOOR: true,
      JOBVECTOR: true,
      INDEED: true,
      STEPSTONE: true,
    });
  });

  it('keeps PLATFORM_STATUSES and PlatformStatus in parity over all 14 values', () => {
    expectVocabularyParity<PlatformStatus>(PLATFORM_STATUSES, {
      COMPLETED: true,
      DISABLED: true,
      INCOMPLETE_CONFIGURATION: true,
      SIGN_IN_REQUIRED: true,
      PLATFORM_BLOCKED: true,
      PLATFORM_UNREACHABLE: true,
      PAGE_LAYOUT_UNKNOWN: true,
      PAGE_LIMIT_REACHED: true,
      FETCH_RATE_LIMITED: true,
      FAILED: true,
      EXCLUDED_BY_ROBOTS_TXT: true,
      ROBOTS_TXT_UNAVAILABLE: true,
      CANCELLED_BY_TIME_LIMIT: true,
      NOT_YET_RUN: true,
    });
    expect(PLATFORM_STATUSES).toHaveLength(14);
  });

  it('keeps POSTING_STATUSES and PostingStatus in parity', () => {
    expectVocabularyParity<PostingStatus>(POSTING_STATUSES, {
      LISTED: true,
      NO_LONGER_LISTED: true,
    });
  });

  it('keeps INTEREST_FLAGS and InterestFlag in parity', () => {
    expectVocabularyParity<InterestFlag>(INTEREST_FLAGS, {
      UNMARKED: true,
      NOT_INTERESTING: true,
    });
  });

  it('keeps RELEVANCE_VERDICTS and RelevanceVerdict in parity', () => {
    expectVocabularyParity<RelevanceVerdict>(RELEVANCE_VERDICTS, {
      RELEVANT: true,
      NOT_RELEVANT: true,
      UNCERTAIN: true,
      NOT_ASSESSED: true,
    });
  });

  it('keeps RUN_OUTCOMES and RunOutcome in parity', () => {
    expectVocabularyParity<RunOutcome>(RUN_OUTCOMES, {
      COMPLETED: true,
      CANCELLED_BY_USER: true,
      CANCELLED_BY_TIME_LIMIT: true,
    });
  });

  it('keeps RUN_STATUSES and RunStatus in parity', () => {
    expectVocabularyParity<RunStatus>(RUN_STATUSES, { RUNNING: true, FINISHED: true });
  });

  it('keeps COMMUTE_MODES and CommuteMode in parity', () => {
    expectVocabularyParity<CommuteMode>(COMMUTE_MODES, { BICYCLE: true, TRANSIT: true });
  });

  it('keeps COMMUTE_PRECISIONS and CommutePrecision in parity', () => {
    expectVocabularyParity<CommutePrecision>(COMMUTE_PRECISIONS, {
      EXACT: true,
      IMPRECISE: true,
      UNKNOWN: true,
    });
  });

  it('keeps EMPLOYMENT_TYPES and EmploymentType in parity', () => {
    expectVocabularyParity<EmploymentType>(EMPLOYMENT_TYPES, {
      PERMANENT: true,
      TEMPORARY: true,
      CONTRACT: true,
      ANY: true,
    });
  });
});

describe('RELEVANCE_RANK', () => {
  it('is total over RELEVANCE_VERDICTS and assigns a distinct rank to each verdict', () => {
    expect(new Set(Object.keys(RELEVANCE_RANK))).toEqual(new Set(RELEVANCE_VERDICTS));

    const ranks = RELEVANCE_VERDICTS.map((verdict) => RELEVANCE_RANK[verdict]);

    expect(new Set(ranks).size).toBe(RELEVANCE_VERDICTS.length);
    expect([...ranks].sort((left, right) => left - right)).toEqual([0, 1, 2, 3]);
  });

  it('orders relevant before uncertain before not assessed before not relevant (10.7)', () => {
    expect(RELEVANCE_RANK.RELEVANT).toBeLessThan(RELEVANCE_RANK.UNCERTAIN);
    expect(RELEVANCE_RANK.UNCERTAIN).toBeLessThan(RELEVANCE_RANK.NOT_ASSESSED);
    expect(RELEVANCE_RANK.NOT_ASSESSED).toBeLessThan(RELEVANCE_RANK.NOT_RELEVANT);
  });

  it('sorts an arbitrarily ordered list of verdicts into the order of criterion 10.7', () => {
    const shuffled: readonly RelevanceVerdict[] = [
      'NOT_RELEVANT',
      'NOT_ASSESSED',
      'RELEVANT',
      'UNCERTAIN',
      'NOT_RELEVANT',
      'RELEVANT',
    ];

    const sorted = [...shuffled].sort(
      (left, right) => RELEVANCE_RANK[left] - RELEVANCE_RANK[right],
    );

    expect(sorted).toEqual([
      'RELEVANT',
      'RELEVANT',
      'UNCERTAIN',
      'NOT_ASSESSED',
      'NOT_RELEVANT',
      'NOT_RELEVANT',
    ]);
  });
});
