/**
 * Property 8 of the job-search-tool design: upsert preserves the first recording and the user's
 * marking.
 *
 * The acceptance criteria split the columns of a Job_Posting into three groups, and 9.3, 10.10 and
 * 11.8 together say that a sighting may only ever move the first of them:
 *
 * - **overwritten** by the running Scrape_Run: title, employer, work location, publication date,
 *   source URL, description text, the time of the last sighting, the Posting_Status (always
 *   "listed" after a write, per 9.8) and the derived content hash;
 * - **established once** by the insert: the time of first recording and the identifier of the
 *   recording Scrape_Run (9.3, 11.8);
 * - **owned by the user or by a later stage**: the Interest_Flag (10.10), the relevance columns and
 *   the commute columns.
 *
 * Why this property runs against a real PostgreSQL container instead of the in-memory delegate the
 * unit tests use: the third group is preserved by *absence*. `applyUpdate` simply does not mention
 * those columns, so the claim under test is "a partial `UPDATE` leaves the unlisted columns alone" —
 * a statement about the engine and the generated SQL, not about the repository's own branching. An
 * in-memory stand-in would merge objects and would therefore confirm the claim by construction. The
 * real unique constraint on `(platform, postingId)` also decides here whether the sequence of
 * upserts produced one record or several.
 *
 * The user's marking is issued with a direct `update` on the Interest_Flag column rather than with
 * `PostingRepository.setInterestFlag`: that method arrives with task 15.4. What the property needs
 * is the *state* a user left behind, and the column write is exactly the state the mutation will
 * produce, so the oracle — "the Interest_Flag equals the last user-issued value" — is unaffected.
 * Each marking is issued *before* the following upsert, so the final state always has at least one
 * upsert applied on top of the last user action; a marking written after the last write would make
 * the assertion pass without the preservation being exercised.
 *
 * The relevance and commute values are planted once, right after the insert, with
 * `relevanceContentHash` pinned to the content hash of that first write. Later upserts change the
 * content and therefore `contentHash`, so a stored assessment hash that still equals the *first*
 * hash is positive evidence that the update touched the content columns and nothing else — which is
 * also what keeps the re-assessment gate of 15.5 truthful.
 *
 * Requirements: 9.3, 10.10, 11.8.
 */

// Feature: job-search-tool, Property 8 - Upsert preserves the first recording and the user's marking

import { computeContentHash, INTEREST_FLAGS, PLATFORMS, RELEVANCE_RANK } from '@job-scraper/domain';
import type { NormalizedJobPosting } from '@job-scraper/scrapers';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { InterestFlag, Platform } from '../../prisma/prisma.types';
import { usePostgres } from '../../testing/postgres-harness';
import { seedScrapeRun } from '../../testing/posting-store.fixture';
import { PostingRepository } from '../posting.repository';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** Start time of the first Scrape_Run of a generated sequence; later ones are offsets from it. */
const BASE_RUN_STARTED_AT = new Date('2026-03-02T08:00:00.000Z');

/**
 * The character pool for generated text.
 *
 * Every entry is one UTF-16 code unit, so a generated length equals the length the `varchar` limits
 * of the Posting_Store are declared in. No control character occurs, because a NUL byte is not
 * storable in a PostgreSQL text column and would fail the write for a reason this property has
 * nothing to say about.
 */
const TEXT_UNIT = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzäöüß ()/-0123456789');

/** Text of the given length range with no leading or trailing whitespace. */
const text = (minLength: number, maxLength: number): fc.Arbitrary<string> =>
  fc
    .string({ unit: TEXT_UNIT, minLength, maxLength })
    .filter((value) => value === value.trim() && value.length >= minLength);

/** A Posting_Id as a Platform hands it out: stable, opaque and free of whitespace. */
const postingIdArbitrary = fc.string({
  unit: fc.constantFrom(...'0123456789abcdef'),
  minLength: 4,
  maxLength: 12,
});

/** Publication dates inside a window the Platform could plausibly show, at millisecond precision. */
const publishedAtArbitrary = fc.date({
  min: new Date('2025-01-01T00:00:00.000Z'),
  max: new Date('2026-03-02T00:00:00.000Z'),
  noInvalidDate: true,
});

/** The six content fields of 9.3 that every upsert overwrites. */
type PostingContent = Omit<NormalizedJobPosting, 'platform' | 'postingId'>;

const contentArbitrary: fc.Arbitrary<PostingContent> = fc.record({
  title: text(1, 80),
  employer: fc.option(text(1, 60), { nil: null }),
  workLocation: fc.option(text(1, 60), { nil: null }),
  publishedAt: fc.option(publishedAtArbitrary, { nil: null }),
  sourceUrl: text(1, 40).map((slug) => `https://example.test/stellenangebote--${slug}`),
  descriptionText: fc.option(text(1, 400), { nil: null }),
});

/**
 * One sighting after the first: the content the Platform shows now, how much later the Scrape_Run
 * started, and the Interest_Flag the user issued before that sighting (`null` for no user action).
 */
interface Sighting {
  readonly content: PostingContent;
  readonly gapMinutes: number;
  readonly userFlag: InterestFlag | null;
}

const sightingArbitrary: fc.Arbitrary<Sighting> = fc.record({
  content: contentArbitrary,
  gapMinutes: fc.integer({ min: 1, max: 20_160 }),
  userFlag: fc.option(fc.constantFrom(...INTEREST_FLAGS), { nil: null }),
});

/**
 * One generated scenario: one unique key, the first write, and 1 to 9 further sightings — so 2 to 10
 * upserts in total, with strictly increasing Scrape_Run start times.
 */
const scenarioArbitrary = fc.record({
  platform: fc.constantFrom(...PLATFORMS),
  postingId: postingIdArbitrary,
  first: contentArbitrary,
  rest: fc.array(sightingArbitrary, { minLength: 1, maxLength: 9 }),
});

/** The relevance and commute state a later stage and the user leave behind, planted after the insert. */
const PLANTED_ASSESSMENT = {
  relevanceVerdict: 'RELEVANT',
  relevanceReason: 'Passt zum gesuchten Profil.',
  relevanceModel: 'claude-sonnet-4-5',
  relevanceAssessedAt: new Date('2026-03-02T08:05:00.000Z'),
  relevanceSetManually: true,
  relevanceRank: RELEVANCE_RANK.RELEVANT,
  bicycleMinutes: 41,
  transitMinutes: 28,
  bestCommuteMinutes: 28,
  bestCommuteMode: 'TRANSIT',
  commutePrecision: 'EXACT',
  commuteLocationInput: 'München',
  commuteCheckedAt: new Date('2026-03-02T08:06:00.000Z'),
} as const;

/**
 * The Interest_Flag the user holds once the first marking has been planted: the last value the user
 * issued, or the planted one when the user issued nothing afterwards.
 *
 * The planted value is deliberately not the column default, so a sequence without any generated
 * marking still asserts a non-default value survived every later upsert.
 */
const PLANTED_INTEREST_FLAG: InterestFlag = 'NOT_INTERESTING';

const minutesAfter = (start: Date, minutes: number): Date =>
  new Date(start.getTime() + minutes * 60_000);

const asNormalized = (
  platform: Platform,
  postingId: string,
  content: PostingContent,
): NormalizedJobPosting => ({ platform, postingId, ...content });

const postgres = usePostgres();

describe("Property 8: Upsert preserves the first recording and the user's marking", () => {
  /**
   * **Validates: Requirements 9.3, 10.10, 11.8**
   *
   * For all sequences of 2 to 10 upserts for the same `(platform, Posting_Id)` with varying content,
   * increasing Scrape_Run start times and interleaved user markings, the stored Job_Posting holds:
   * the time of first recording and the recording Scrape_Run of the *first* write (9.3, 11.8); the
   * content fields of the *last* applied upsert with the time of the last sighting equal to that
   * run's start time (9.3); the Interest_Flag the user issued last (9.3, 10.10); and the relevance
   * and commute values no retrieval ever writes.
   */
  it('keeps the first recording, the marking and the enrichment while the content follows the last sighting', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async ({ platform, postingId, first, rest }) => {
        // Per iteration rather than per test: the harness truncation runs in `beforeEach`, so each
        // generated sequence — including every shrinking attempt — has to start from an empty store.
        await postgres.truncate();

        const repository = new PostingRepository(postgres.prisma);
        const where = { platform_postingId: { platform, postingId } };

        // One Scrape_Run per sighting, with strictly increasing start times. Each run is a real row
        // because the first recording is a foreign key to it (11.1).
        const startTimes: Date[] = [BASE_RUN_STARTED_AT];

        for (const sighting of rest) {
          startTimes.push(minutesAfter(startTimes[startTimes.length - 1]!, sighting.gapMinutes));
        }

        const runIds = startTimes.map((_unused, index) => `run-${index + 1}`);

        for (const [index, startedAt] of startTimes.entries()) {
          await seedScrapeRun(postgres.prisma, {
            id: runIds[index]!,
            startedAt,
            finishedAt: startedAt,
          });
        }

        // The first write: it is the only one that may establish the first recording.
        const inserted = await repository.upsert(
          asNormalized(platform, postingId, first),
          runIds[0]!,
          startTimes[0]!,
        );

        expect(inserted).toEqual({ postingId, created: true, contentChanged: false });

        const afterInsert = await postgres.prisma.jobPosting.findUniqueOrThrow({ where });
        const firstContentHash = afterInsert.contentHash;

        // What the user and the enrichment stages own. `relevanceContentHash` is pinned to the
        // content of the first write, so a later upsert that touched it would be visible.
        await postgres.prisma.jobPosting.update({
          where: { id: afterInsert.id },
          data: {
            interestFlag: PLANTED_INTEREST_FLAG,
            relevanceContentHash: firstContentHash,
            ...PLANTED_ASSESSMENT,
          },
        });

        let expectedFlag: InterestFlag = PLANTED_INTEREST_FLAG;

        for (const [index, sighting] of rest.entries()) {
          // The user acts before the sighting, so the following upsert has to preserve the marking.
          if (sighting.userFlag !== null) {
            await postgres.prisma.jobPosting.update({
              where: { id: afterInsert.id },
              data: { interestFlag: sighting.userFlag },
            });

            expectedFlag = sighting.userFlag;
          }

          const result = await repository.upsert(
            asNormalized(platform, postingId, sighting.content),
            runIds[index + 1]!,
            startTimes[index + 1]!,
          );

          // Every write after the first matches the existing record; 9.3 forbids a second one.
          expect(result).toMatchObject({ postingId, created: false });
        }

        const lastContent = rest[rest.length - 1]!.content;
        const lastStartedAt = startTimes[startTimes.length - 1]!;
        const stored = await postgres.prisma.jobPosting.findUniqueOrThrow({ where });

        expect(await postgres.prisma.jobPosting.count()).toBe(1);
        expect(stored.id).toBe(afterInsert.id);

        // Established once (9.3, 11.8): neither value moved to a later Scrape_Run.
        expect(stored.firstSeenAt).toEqual(startTimes[0]!);
        expect(stored.firstSeenRunId).toBe(runIds[0]!);

        // Overwritten (9.3): the last applied upsert won for everything the Platform shows.
        expect(stored).toMatchObject({
          title: lastContent.title,
          employer: lastContent.employer,
          workLocation: lastContent.workLocation,
          sourceUrl: lastContent.sourceUrl,
          descriptionText: lastContent.descriptionText,
        });
        expect(stored.publishedAt).toEqual(lastContent.publishedAt);
        expect(stored.lastSeenAt).toEqual(lastStartedAt);
        expect(stored.contentHash).toBe(
          computeContentHash(lastContent.title, lastContent.descriptionText),
        );
        // 9.8: a Job_Posting in the result list of the running Scrape_Run is listed.
        expect(stored.postingStatus).toBe('LISTED');

        // Owned by the user (10.10): the last value the user issued, never the retrieval's.
        expect(stored.interestFlag).toBe(expectedFlag);

        // Owned by a later stage: no retrieval writes any of these columns.
        expect(stored).toMatchObject(PLANTED_ASSESSMENT);
        expect(stored.relevanceContentHash).toBe(firstContentHash);
      }),
      PROPERTY_RUNS,
    );
  });
});
