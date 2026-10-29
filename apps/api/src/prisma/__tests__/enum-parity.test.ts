/**
 * Enum parity between `@job-scraper/domain` and `prisma/schema.prisma`.
 *
 * The project rule "enums and domain types live in a shared package" and the Prisma rule
 * "`schema.prisma` is the single source of truth for the database" both have to hold, so the closed
 * value lists exist twice: once as a `const` tuple in `packages/domain/src/enums.ts` and once as a
 * Prisma enum. This test is what keeps the two copies from drifting, in both directions:
 *
 * - at compile time through mutual `satisfies`: every domain tuple is assignable to an array of the
 *   matching Prisma enum type, and every Prisma enum's member list is assignable to an array of the
 *   matching domain union. Mutual assignability of the two member lists is set equality of the two
 *   unions, so a value added on one side only fails `pnpm check-types` before any test runs;
 * - at runtime through set comparison of the actual member lists, which also catches a Prisma
 *   client that was not regenerated after a schema change.
 *
 * Both Prisma enums and domain tuples are imported through `../prisma.types` and the package root
 * respectively — never from `@prisma/client` directly (that is the one re-export rule of this
 * directory).
 *
 * Requirements: 7.4 (exactly one Platform_Status per Platform), 9.1 (Posting_Status takes exactly
 * one of two values), 11.1 (exactly one Run_Outcome per Scrape_Run), 15.14 (every Job_Posting
 * carries exactly one Relevance_Verdict from the permitted value list). Each of those criteria
 * depends on the stored value list being identical to the declared one.
 */

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
  RELEVANCE_VERDICTS,
  type RelevanceVerdict,
  RUN_OUTCOMES,
  RUN_STATUSES,
  type RunOutcome,
  type RunStatus,
} from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import { $Enums } from '../prisma.types';

/**
 * One entry per closed value list that exists on both sides.
 *
 * The two `satisfies` clauses per entry are the compile-time half of the parity check and are
 * written inline so that a new pair cannot be added without them:
 *
 * - `domainValues` asserts domain ⊆ Prisma — a tuple member the Prisma enum does not have is a
 *   type error;
 * - `prismaValues` asserts Prisma ⊆ domain — an enum member the tuple does not have is a type
 *   error.
 */
const ENUM_PARITY = [
  {
    name: 'Platform',
    domainValues: PLATFORMS satisfies readonly $Enums.Platform[],
    prismaValues: Object.values($Enums.Platform) satisfies readonly Platform[],
  },
  {
    name: 'PlatformStatus',
    domainValues: PLATFORM_STATUSES satisfies readonly $Enums.PlatformStatus[],
    prismaValues: Object.values($Enums.PlatformStatus) satisfies readonly PlatformStatus[],
  },
  {
    name: 'PostingStatus',
    domainValues: POSTING_STATUSES satisfies readonly $Enums.PostingStatus[],
    prismaValues: Object.values($Enums.PostingStatus) satisfies readonly PostingStatus[],
  },
  {
    name: 'InterestFlag',
    domainValues: INTEREST_FLAGS satisfies readonly $Enums.InterestFlag[],
    prismaValues: Object.values($Enums.InterestFlag) satisfies readonly InterestFlag[],
  },
  {
    name: 'RelevanceVerdict',
    domainValues: RELEVANCE_VERDICTS satisfies readonly $Enums.RelevanceVerdict[],
    prismaValues: Object.values($Enums.RelevanceVerdict) satisfies readonly RelevanceVerdict[],
  },
  {
    name: 'RunOutcome',
    domainValues: RUN_OUTCOMES satisfies readonly $Enums.RunOutcome[],
    prismaValues: Object.values($Enums.RunOutcome) satisfies readonly RunOutcome[],
  },
  {
    name: 'RunStatus',
    domainValues: RUN_STATUSES satisfies readonly $Enums.RunStatus[],
    prismaValues: Object.values($Enums.RunStatus) satisfies readonly RunStatus[],
  },
  {
    name: 'CommuteMode',
    domainValues: COMMUTE_MODES satisfies readonly $Enums.CommuteMode[],
    prismaValues: Object.values($Enums.CommuteMode) satisfies readonly CommuteMode[],
  },
  {
    name: 'CommutePrecision',
    domainValues: COMMUTE_PRECISIONS satisfies readonly $Enums.CommutePrecision[],
    prismaValues: Object.values($Enums.CommutePrecision) satisfies readonly CommutePrecision[],
  },
] as const;

/**
 * Prisma enums that exist on purpose without a `packages/domain` counterpart.
 *
 * Neither is part of the glossary vocabulary, and neither crosses the API boundary as a closed
 * value list the Web_App has to understand:
 *
 * - `LogLevel` classifies a Log_Stream row (12.3). The level is produced and consumed inside
 *   `apps/api`; the Web_App renders whatever the GraphQL layer declares for it.
 * - `NormalizationSource` records whether a work location was resolved by the rule-based path or by
 *   the AI_Provider (8.6). It is provenance of a cache row, not a domain concept.
 *
 * Declaring them here rather than leaving them out silently is what lets the completeness test
 * below fail when a *new* Prisma enum appears: the author then has to decide whether it mirrors a
 * domain tuple (add it to `ENUM_PARITY`) or is database-only (add it here, with a reason).
 */
const DATABASE_ONLY_PRISMA_ENUMS = ['LogLevel', 'NormalizationSource'] as const;

/** Sorted, duplicate-free member list — the comparable form of a value list. */
const toSortedSet = (values: readonly string[]): string[] => [...new Set(values)].sort();

describe('enum parity between @job-scraper/domain and schema.prisma', () => {
  it.each(ENUM_PARITY)(
    '$name holds the same set of values on both sides',
    ({ domainValues, prismaValues }) => {
      expect(toSortedSet(domainValues)).toEqual(toSortedSet(prismaValues));
    },
  );

  it.each(ENUM_PARITY)(
    '$name declares each value exactly once in the domain tuple',
    ({ domainValues }) => {
      expect(new Set(domainValues).size).toBe(domainValues.length);
    },
  );

  it('covers every closed value list that @job-scraper/domain declares', () => {
    // Nine pairs: the nine `const` tuples of packages/domain/src/enums.ts. RELEVANCE_RANK is not a
    // value list but a derived sort order over RELEVANCE_VERDICTS, and the Posting_Store stores it
    // as an Int column rather than an enum, so it has no Prisma counterpart to compare against.
    expect(ENUM_PARITY.map((pair) => pair.name)).toEqual([
      'Platform',
      'PlatformStatus',
      'PostingStatus',
      'InterestFlag',
      'RelevanceVerdict',
      'RunOutcome',
      'RunStatus',
      'CommuteMode',
      'CommutePrecision',
    ]);
  });
});

describe('completeness of the parity check', () => {
  it('accounts for every Prisma enum as either mirrored or deliberately database-only', () => {
    const accountedFor = [...ENUM_PARITY.map((pair) => pair.name), ...DATABASE_ONLY_PRISMA_ENUMS];

    expect(toSortedSet(Object.keys($Enums))).toEqual(toSortedSet(accountedFor));
  });

  it('keeps the database-only enums readable without a domain tuple', () => {
    expect(Object.values($Enums.LogLevel)).toEqual(['INFO', 'WARN', 'ERROR']);
    expect(Object.values($Enums.NormalizationSource)).toEqual(['RULE_BASED', 'AI_PROVIDER']);
  });
});

describe('cardinality of the value lists the acceptance criteria pin down', () => {
  it('offers exactly the 14 Platform_Status values a Scrape_Run summary may report (7.4)', () => {
    expect(toSortedSet(Object.values($Enums.PlatformStatus))).toHaveLength(14);
  });

  it('offers exactly the two Posting_Status values (9.1)', () => {
    expect(toSortedSet(Object.values($Enums.PostingStatus))).toEqual([
      'LISTED',
      'NO_LONGER_LISTED',
    ]);
  });

  it('offers exactly the three Run_Outcome values (11.1)', () => {
    expect(toSortedSet(Object.values($Enums.RunOutcome))).toEqual([
      'CANCELLED_BY_TIME_LIMIT',
      'CANCELLED_BY_USER',
      'COMPLETED',
    ]);
  });

  it('offers exactly the four Relevance_Verdict values a response parser may yield (15.14)', () => {
    expect(toSortedSet(Object.values($Enums.RelevanceVerdict))).toEqual([
      'NOT_ASSESSED',
      'NOT_RELEVANT',
      'RELEVANT',
      'UNCERTAIN',
    ]);
  });
});
