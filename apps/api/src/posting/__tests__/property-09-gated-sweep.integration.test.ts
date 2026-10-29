/**
 * Property 9 of the job-search-tool design: the "no longer listed" sweep is the gated set
 * difference and round-trips.
 *
 * Four claims of one statement, which is why they are asserted in one property rather than in four:
 *
 * - with both the Run_Outcome and the Platform_Status at "completed", exactly the stored
 *   Job_Posting of that Platform that are absent from the result list receive the Posting_Status
 *   "no longer listed" (9.5);
 * - with any other combination, no Posting_Status changes at all (9.7);
 * - in both cases every other field of every record survives (9.5);
 * - a swept Job_Posting that reappears in a later result list is listed again, with its time of
 *   first recording unchanged (9.8).
 *
 * This runs against a real PostgreSQL container, not against the in-memory delegate that
 * `posting.repository.sweep.test.ts` drives. The sweep is a single `updateMany` whose `where`
 * expresses the set difference as SQL (`postingId NOT IN (…)` plus the Platform and the current
 * Posting_Status), so what has to be checked here is that the engine computes the same difference
 * the oracle computes in TypeScript. An in-memory stand-in would re-assert the stand-in's own
 * filter logic instead.
 *
 * The oracle is an independent reimplementation: `stored \ seen` as a `Set` operation over the
 * generated input, restricted to the swept Platform and to records that were listed, and empty
 * whenever the gate is closed. Retention is asserted as a whole-row comparison against the rows
 * read back before the sweep, with the expected Posting_Status substituted — so a statement that
 * cleared the Interest_Flag, the relevance assessment or the commute result fails here, and a
 * column a later task adds is covered without this file being touched.
 *
 * Three deliberate extensions of the generator the design sketches:
 *
 * - `null` is drawn alongside the three Run_Outcome values. A Scrape_Run that is still running
 *   carries no Run_Outcome, and that is one of the cases 9.7 covers, so leaving it out would leave
 *   the most likely caller mistake ungenerated.
 * - the Platform of each stored posting is drawn as well, and the swept Platform is drawn
 *   independently. "Exactly the stored postings of that Platform" is a claim about the records of
 *   the *other* Platform too, and the same Posting_Id can exist under several Platform (9.2).
 * - the initial Posting_Status is drawn rather than fixed to "listed". The design's `stored \ seen`
 *   is the special case where everything starts listed; generating a store that already contains
 *   "no longer listed" records is what makes the returned count ("records this sweep changed")
 *   and the "changes no Posting_Status otherwise" half observable.
 *
 * Requirements: 9.5, 9.7, 9.8.
 */
// Feature: job-search-tool, Property 9 - The "no longer listed" sweep is the gated set difference and round-trips

import {
  computeContentHash,
  INTEREST_FLAGS,
  type InterestFlag,
  type Platform,
  PLATFORM_STATUSES,
  PLATFORMS,
  POSTING_STATUSES,
  type PostingStatus,
  RELEVANCE_RANK,
  RELEVANCE_VERDICTS,
  type RelevanceVerdict,
  RUN_OUTCOMES,
} from '@job-scraper/domain';
import type { NormalizedJobPosting } from '@job-scraper/scrapers';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JobPosting } from '../../prisma/prisma.types';
import { usePostgres } from '../../testing/postgres-harness';
import {
  SEEDED_RUN_ID,
  SEEDED_RUN_STARTED_AT,
  seedScrapeRun,
} from '../../testing/posting-store.fixture';
import { PostingRepository } from '../posting.repository';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** The later Scrape_Run, still running, whose result list performs the round trip of 9.8. */
const SECOND_RUN_ID = '33333333-3333-4333-8333-333333333333';
const SECOND_RUN_STARTED_AT = new Date('2026-03-09T08:00:00.000Z');

/**
 * The shared pool the stored set and the result list are both drawn from.
 *
 * A small pool is the point: it forces overlap between "stored" and "seen" in most iterations,
 * which is where the set difference is actually interesting, and it keeps both the pure difference
 * and the pure intersection reachable. Posting_Id that are in the pool but not stored occur as
 * well, which is the result-list entry a sweep must simply ignore.
 */
const POSTING_ID_POOL: readonly string[] = [
  'abc-123',
  'def-456',
  'ghi-789',
  'jkl-012',
  'mno-345',
  'pqr-678',
];

/** The unique key of 9.2, as a string, so a failing expectation names the record it means. */
const keyOf = (posting: { platform: Platform; postingId: string }): string =>
  `${posting.platform}/${posting.postingId}`;

/**
 * The content of one Job_Posting, derived from its unique key.
 *
 * Deterministic rather than generated, because the sweep never reads or writes a content field.
 * Deriving it from the key is what lets the round trip re-apply the *same* content through the
 * upsert, so the assertion after the round trip can compare whole rows again and the only expected
 * differences are the Posting_Status and the time of the last sighting (9.3).
 */
const contentOf = (
  platform: Platform,
  postingId: string,
): Omit<NormalizedJobPosting, 'platform' | 'postingId'> => ({
  title: `Projektmanagerin ${postingId}`,
  employer: 'Beispiel Pharma GmbH',
  workLocation: 'München',
  publishedAt: new Date('2026-02-27T00:00:00.000Z'),
  sourceUrl: `https://www.${platform.toLowerCase()}.example/stellenangebote--${postingId}`,
  descriptionText: 'Sie steuern Projekte im Bereich Life Science.',
});

/** One generated record of the Posting_Store before the sweep. */
interface StoredPosting {
  readonly platform: Platform;
  readonly postingId: string;
  readonly postingStatus: PostingStatus;
  /** Owned by the user (10.10) and therefore one of the fields the sweep has to retain. */
  readonly interestFlag: InterestFlag;
  /** Owned by the Relevance_Service (15.1) and likewise none of the sweep's business. */
  readonly relevanceVerdict: RelevanceVerdict;
}

/**
 * The generated store: at most twelve records, unique per `(platform, Posting_Id)`.
 *
 * The uniqueness selector is the unique key of 9.2, which is also the constraint the Posting_Store
 * enforces — a generated duplicate would fail the seeding instead of the property.
 */
const storedPostingsArbitrary = fc.uniqueArray(
  fc.record<StoredPosting>({
    platform: fc.constantFrom(...PLATFORMS),
    postingId: fc.constantFrom(...POSTING_ID_POOL),
    postingStatus: fc.constantFrom(...POSTING_STATUSES),
    interestFlag: fc.constantFrom(...INTEREST_FLAGS),
    relevanceVerdict: fc.constantFrom(...RELEVANCE_VERDICTS),
  }),
  { selector: keyOf, maxLength: 12 },
);

const postgres = usePostgres();

/** Every stored row, in a stable order, keyed by the unique key of 9.2. */
const readStore = async (): Promise<Map<string, JobPosting>> => {
  const rows = await postgres.prisma.jobPosting.findMany({
    orderBy: [{ platform: 'asc' }, { postingId: 'asc' }],
  });

  return new Map(rows.map((row) => [keyOf(row), row]));
};

describe('Property 9: the "no longer listed" sweep is the gated set difference and round-trips', () => {
  /**
   * **Validates: Requirements 9.5, 9.7, 9.8**
   *
   * For all stored posting sets, for all result lists and for all combinations of Run_Outcome —
   * including the absent one of a still running Scrape_Run — and Platform_Status, the sweep sets the
   * Posting_Status to "no longer listed" for exactly the stored Job_Posting of the swept Platform
   * that are absent from the result list when both values are "completed", changes no
   * Posting_Status otherwise, retains every other field in all cases, and lists a swept Job_Posting
   * again with an unchanged time of first recording when a later result list contains it.
   */
  it('marks exactly the absent postings when the gate is open, nothing otherwise, and lists them again on reappearance', async () => {
    const repository = new PostingRepository(postgres.prisma);

    await fc.assert(
      fc.asyncProperty(
        storedPostingsArbitrary,
        fc.constantFrom(...PLATFORMS),
        fc.subarray([...POSTING_ID_POOL]),
        fc.option(fc.constantFrom(...RUN_OUTCOMES), { nil: null }),
        fc.constantFrom(...PLATFORM_STATUSES),
        fc.subarray([...POSTING_ID_POOL]),
        async (stored, platform, seenPostingIds, runOutcome, platformStatus, reappearing) => {
          // Each iteration is its own Posting_Store: the harness truncates per test, not per
          // generated input.
          await postgres.truncate();
          await seedScrapeRun(postgres.prisma);

          if (stored.length > 0) {
            await postgres.prisma.jobPosting.createMany({
              data: stored.map((posting) => {
                const content = contentOf(posting.platform, posting.postingId);

                return {
                  platform: posting.platform,
                  postingId: posting.postingId,
                  ...content,
                  firstSeenAt: SEEDED_RUN_STARTED_AT,
                  lastSeenAt: SEEDED_RUN_STARTED_AT,
                  firstSeenRunId: SEEDED_RUN_ID,
                  postingStatus: posting.postingStatus,
                  interestFlag: posting.interestFlag,
                  relevanceVerdict: posting.relevanceVerdict,
                  relevanceRank: RELEVANCE_RANK[posting.relevanceVerdict],
                  contentHash: computeContentHash(content.title, content.descriptionText),
                  // A stored commute result, so its retention is asserted rather than assumed.
                  bestCommuteMinutes: 22,
                  bestCommuteMode: 'BICYCLE' as const,
                  commutePrecision: 'EXACT' as const,
                  commuteLocationInput: content.workLocation,
                };
              }),
            });
          }

          const before = await readStore();

          // The oracle. The gate has exactly the two terms of 9.5; everything else — a cancelled
          // run, a run still in flight, a blocked or truncated Platform, the Partial_Result of 7.7
          // — closes it.
          const gateOpen = runOutcome === 'COMPLETED' && platformStatus === 'COMPLETED';
          const seen = new Set(seenPostingIds);
          const expectedSwept = new Set(
            gateOpen
              ? stored
                  .filter(
                    (posting) =>
                      posting.platform === platform &&
                      posting.postingStatus === 'LISTED' &&
                      !seen.has(posting.postingId),
                  )
                  .map(keyOf)
              : [],
          );

          const swept = await repository.markAbsentAsNoLongerListed({
            platform,
            seenPostingIds,
            runOutcome,
            platformStatus,
          });

          // The returned count means "records this sweep changed", so it is the size of the
          // difference and not the size of the stored set.
          expect(swept).toBe(expectedSwept.size);

          const afterSweep = await readStore();

          // No record appeared or disappeared: the sweep is an update, never an insert or a delete.
          expect([...afterSweep.keys()]).toEqual([...before.keys()]);

          for (const [key, row] of before) {
            expect(afterSweep.get(key)).toEqual({
              ...row,
              postingStatus: expectedSwept.has(key) ? 'NO_LONGER_LISTED' : row.postingStatus,
            });
          }

          // The round trip of 9.8: a later Scrape_Run finds some of the Posting_Id again. Entries
          // that were never stored are created by this run, which is the ordinary insert path.
          await seedScrapeRun(postgres.prisma, {
            id: SECOND_RUN_ID,
            startedAt: SECOND_RUN_STARTED_AT,
            finishedAt: null,
            status: 'RUNNING',
            runOutcome: null,
          });

          for (const postingId of reappearing) {
            await repository.upsert(
              { platform, postingId, ...contentOf(platform, postingId) },
              SECOND_RUN_ID,
              SECOND_RUN_STARTED_AT,
            );
          }

          const relisted = new Set(reappearing.map((postingId) => keyOf({ platform, postingId })));
          const afterRoundTrip = await readStore();

          for (const [key, row] of before) {
            const sweptRow = {
              ...row,
              postingStatus: expectedSwept.has(key) ? 'NO_LONGER_LISTED' : row.postingStatus,
            };

            expect(afterRoundTrip.get(key)).toEqual(
              relisted.has(key)
                ? {
                    // Listed again whatever it was before, and the content fields rewritten with
                    // the values of the running Scrape_Run — identical here, by construction.
                    ...sweptRow,
                    postingStatus: 'LISTED',
                    // 9.3: the time of the last sighting is the start time of that Scrape_Run,
                    // while `firstSeenAt` and `firstSeenRunId` stay as the comparison shows.
                    lastSeenAt: SECOND_RUN_STARTED_AT,
                  }
                : sweptRow,
            );
          }

          // The Posting_Id of the later result list that were not stored before: recorded now, by
          // the later run, and listed.
          for (const key of relisted) {
            if (before.has(key)) {
              continue;
            }

            expect(afterRoundTrip.get(key)).toMatchObject({
              postingStatus: 'LISTED',
              firstSeenAt: SECOND_RUN_STARTED_AT,
              firstSeenRunId: SECOND_RUN_ID,
            });
          }

          expect(afterRoundTrip.size).toBe(
            before.size + [...relisted].filter((key) => !before.has(key)).length,
          );
        },
      ),
      PROPERTY_RUNS,
    );
  });
});
