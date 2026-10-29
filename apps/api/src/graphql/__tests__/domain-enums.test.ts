/**
 * The GraphQL enum references are derived from the domain tuples, not typed out again.
 *
 * `packages/domain` is the single declaration of every closed value list, Prisma mirrors it (the
 * enum parity test guards that edge) and the GraphQL schema is the third consumer. This test guards
 * the third edge: each reference object must carry exactly the members of its tuple, mapped onto
 * themselves, so a GraphQL enum member and the value stored in the Posting_Store are the same
 * string.
 *
 * Requirements: 2.2 (the Web_App renders a fixed set of named states, which it reads from the
 * generated schema).
 */

import {
  COMMUTE_MODES,
  COMMUTE_PRECISIONS,
  INTEREST_FLAGS,
  PLATFORM_STATUSES,
  PLATFORMS,
  POSTING_STATUSES,
  RELEVANCE_VERDICTS,
  RUN_OUTCOMES,
  RUN_STATUSES,
} from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import {
  CommuteModeEnumRef,
  CommutePrecisionEnumRef,
  DOMAIN_ENUM_NAMES,
  DOMAIN_ENUM_REFS,
  InterestFlagEnumRef,
  PlatformEnumRef,
  PlatformStatusEnumRef,
  PostingStatusEnumRef,
  RelevanceVerdictEnumRef,
  RunOutcomeEnumRef,
  RunStatusEnumRef,
} from '../domain-enums';

const ENUM_REFS_BY_NAME = [
  { name: 'Platform', ref: PlatformEnumRef, tuple: PLATFORMS },
  { name: 'PlatformStatus', ref: PlatformStatusEnumRef, tuple: PLATFORM_STATUSES },
  { name: 'PostingStatus', ref: PostingStatusEnumRef, tuple: POSTING_STATUSES },
  { name: 'InterestFlag', ref: InterestFlagEnumRef, tuple: INTEREST_FLAGS },
  { name: 'RelevanceVerdict', ref: RelevanceVerdictEnumRef, tuple: RELEVANCE_VERDICTS },
  { name: 'RunOutcome', ref: RunOutcomeEnumRef, tuple: RUN_OUTCOMES },
  { name: 'RunStatus', ref: RunStatusEnumRef, tuple: RUN_STATUSES },
  { name: 'CommuteMode', ref: CommuteModeEnumRef, tuple: COMMUTE_MODES },
  { name: 'CommutePrecision', ref: CommutePrecisionEnumRef, tuple: COMMUTE_PRECISIONS },
] as const;

describe('domain enum references', () => {
  it.each(ENUM_REFS_BY_NAME)(
    '$name carries exactly the members of its domain tuple',
    ({ ref, tuple }) => {
      expect(Object.keys(ref)).toEqual([...tuple]);
    },
  );

  it.each(ENUM_REFS_BY_NAME)('$name maps every member onto itself', ({ ref }) => {
    expect(Object.entries(ref).every(([key, value]) => key === value)).toBe(true);
  });

  it.each(ENUM_REFS_BY_NAME)(
    '$name is frozen, so no consumer can extend the value list',
    ({ ref }) => {
      expect(Object.isFrozen(ref)).toBe(true);
    },
  );

  it('registers all nine domain vocabularies, each exactly once', () => {
    expect(DOMAIN_ENUM_NAMES).toEqual(ENUM_REFS_BY_NAME.map((entry) => entry.name));
    expect(new Set(DOMAIN_ENUM_NAMES).size).toBe(9);
  });

  it('offers one orphaned-type reference per registered name', () => {
    expect(DOMAIN_ENUM_REFS).toHaveLength(DOMAIN_ENUM_NAMES.length);
    expect(DOMAIN_ENUM_REFS).toEqual(ENUM_REFS_BY_NAME.map((entry) => entry.ref));
  });
});
