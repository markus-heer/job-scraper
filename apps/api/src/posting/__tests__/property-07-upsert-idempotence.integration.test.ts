/**
 * Property 7 of the job-search-tool design: upsert into the Posting_Store is idempotent (9.2, 9.4).
 *
 * The acceptance criterion is a statement about *all* result lists of a Platform with at most 250
 * Job_Posting: applying the same list twice with the same Scrape_Run start time has to produce the
 * same data state as applying it once, measured by the number of stored Job_Posting and by every
 * stored field value of 9.1. The second half comes from 9.2: Posting_Id values that differ only in
 * leading or trailing whitespace are the same key, so they collapse onto one record.
 *
 * Why this property runs against real PostgreSQL instead of the in-memory delegate the unit tests
 * use: idempotence here is a claim about the `@@unique([platform, postingId])` constraint of the
 * Posting_Store. An in-memory stand-in enforces whatever its own `findUnique` implements, so it can
 * only confirm that the repository agrees with the fixture. The container enforces the constraint
 * the Job_Tool actually ships, which is also what makes "the number of stored Job_Posting equals
 * the number of distinct `(platform, trim(postingId))` pairs" worth asserting at all.
 *
 * The oracle is a full table snapshot, not a row count: a second application that silently reset a
 * time of first recording, moved a last sighting to the wall clock or rewrote a content hash would
 * keep the count and still break 9.4. Both snapshots are read in `(platform, postingId)` order and
 * compared field by field, including the record identifiers — so a second application that deleted
 * and re-inserted a record instead of updating it fails here too.
 *
 * Generated lists mix the four Platform rather than staying on one. That is strictly more than the
 * criterion asks for and is the case the oracle is phrased in: the same Posting_Id on two Platform
 * is two Job_Posting, so a key comparison that ignored the platform name would be caught.
 *
 * The list length is the one place where the generator and the criterion's bound differ in
 * practice. fast-check's default sizing keeps arrays at around ten entries, which is what makes 100
 * iterations against a real engine affordable; the explicit 250-entry list of 9.4 is pinned as a
 * generation example, so the bound itself is exercised in every run rather than hoped for.
 *
 * Each iteration clears the store through the harness and recreates its Scrape_Run, because a
 * Job_Posting needs the recording run as a foreign key (11.1) and because the property is about one
 * run's result list, not about state another iteration left behind.
 */

// Feature: job-search-tool, Property 7 - Upsert into the Posting_Store is idempotent

import { type Platform, PLATFORMS } from '@job-scraper/domain';
import type { NormalizedJobPosting } from '@job-scraper/scrapers';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { JobPosting } from '../../prisma/prisma.types';
import { usePostgres } from '../../testing/postgres-harness';
import { seedScrapeRun } from '../../testing/posting-store.fixture';
import { PostingRepository } from '../posting.repository';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** The upper bound 9.4 names for a Platform's result list. */
const MAX_RESULT_LIST = 250;

/**
 * Posting_Id characters, deliberately few.
 *
 * With one or two characters the generator draws from twelve possible identifiers, so a list of
 * about ten entries repeats keys in almost every iteration — and repetition inside a single
 * application is what makes the first pass interesting at all: the later occurrence has to update
 * the record the earlier one created instead of adding a second.
 */
const POSTING_ID_UNITS = ['a', 'b', 'c'] as const;

/** The whitespace 9.2 asks to be ignored when the key is compared. */
const PADDING_UNITS = [' ', '\t', '\n'] as const;

/**
 * Content characters: ASCII, German umlauts and one astral symbol.
 *
 * Curated rather than arbitrary unicode on purpose. PostgreSQL rejects a `NUL` byte in a `text`
 * value and a lone surrogate is not encodable as UTF-8, so a generator over the full code point
 * range would fail writes for reasons that have nothing to do with idempotence. What this property
 * needs from the content is that it varies between the entries of a list, not that it explores the
 * encoding — the length limits and the discarding rules are Property 5's subject.
 */
const CONTENT_UNITS = ['a', 'e', 'i', 'o', 'u', 'ä', 'ö', 'ü', 'ß', 'Z', '7', ' ', '-', '€', '😀'];

/** Lengths well below the `varchar` limits of the Posting_Store; see {@link CONTENT_UNITS}. */
const TITLE_UNITS = 40;
const SHORT_TEXT_UNITS = 20;
const DESCRIPTION_UNITS = 120;

const textArbitrary = (maxLength: number, minLength = 0): fc.Arbitrary<string> =>
  fc.string({ unit: fc.constantFrom(...CONTENT_UNITS), minLength, maxLength });

const optionalTextArbitrary = (maxLength: number): fc.Arbitrary<string | null> =>
  fc.option(textArbitrary(maxLength, 1), { nil: null });

/** A publication date in the past of the generated run start times, or none (6.9). */
const publishedAtArbitrary = fc.option(
  fc.date({
    min: new Date('2025-01-01T00:00:00.000Z'),
    max: new Date('2026-01-01T00:00:00.000Z'),
    noInvalidDate: true,
  }),
  { nil: null },
);

/** Scrape_Run start times; the only time source of a write, hence generated rather than fixed. */
const runStartedAtArbitrary = fc.date({
  min: new Date('2026-01-02T00:00:00.000Z'),
  max: new Date('2026-12-31T23:59:59.999Z'),
  noInvalidDate: true,
});

/**
 * One entry of a generated result list, as the normalization layer would hand it to the repository.
 *
 * The Posting_Id carries its padding here, so what the property feeds in is a raw key and what the
 * store must hold is the trimmed one.
 */
const postingArbitrary = fc.record<NormalizedJobPosting>({
  platform: fc.constantFrom(...PLATFORMS),
  postingId: fc
    .tuple(
      fc.string({ unit: fc.constantFrom(...PADDING_UNITS), maxLength: 2 }),
      fc.string({ unit: fc.constantFrom(...POSTING_ID_UNITS), minLength: 1, maxLength: 2 }),
      fc.string({ unit: fc.constantFrom(...PADDING_UNITS), maxLength: 2 }),
    )
    .map(([before, id, after]) => `${before}${id}${after}`),
  title: textArbitrary(TITLE_UNITS, 1),
  employer: optionalTextArbitrary(SHORT_TEXT_UNITS),
  workLocation: optionalTextArbitrary(SHORT_TEXT_UNITS),
  publishedAt: publishedAtArbitrary,
  sourceUrl: fc.webUrl(),
  descriptionText: optionalTextArbitrary(DESCRIPTION_UNITS),
});

const resultListArbitrary = fc.array(postingArbitrary, { maxLength: MAX_RESULT_LIST });

/**
 * Cycles through the four Platform for the fixed example list.
 *
 * The fallback is unreachable — the index is taken modulo the list length — and only satisfies the
 * index signature of the strict configuration.
 */
const platformAt = (index: number): Platform => PLATFORMS[index % PLATFORMS.length] ?? 'STEPSTONE';

/**
 * The 250-entry list of 9.4, as a generation example.
 *
 * Built so that the bound is reached with repeated keys in it: the Posting_Id cycles through 25
 * identifiers, so the list holds ten occurrences of each and the store must end up with 25 records
 * per Platform's share of them. Every third entry is padded, and the content differs per index, so
 * the later occurrence of a key always overwrites different values than the earlier one wrote.
 */
const exampleResultList = (): NormalizedJobPosting[] =>
  Array.from({ length: MAX_RESULT_LIST }, (_unused, index) => {
    const id = `id-${index % 25}`;

    return {
      platform: platformAt(index),
      postingId: index % 3 === 0 ? `  ${id}\n` : id,
      title: `Projektmanagerin Pharma ${index}`,
      employer: index % 4 === 0 ? null : `Beispiel Pharma ${index} GmbH`,
      workLocation: index % 5 === 0 ? null : 'München',
      publishedAt: index % 2 === 0 ? null : new Date(Date.UTC(2025, 11, 1 + (index % 28))),
      sourceUrl: `https://www.stepstone.de/stellenangebote--${index}`,
      descriptionText: index % 7 === 0 ? null : `Aufgabe Nummer ${index} im Bereich Life Science.`,
    };
  });

const postgres = usePostgres();

/** The stored state, in a deterministic order; `(platform, postingId)` is unique, so it is total. */
const snapshot = async (): Promise<JobPosting[]> =>
  postgres.prisma.jobPosting.findMany({
    orderBy: [{ platform: 'asc' }, { postingId: 'asc' }],
  });

/** The key as 9.2 defines it, for the record-count oracle. */
const uniqueKeysOf = (list: readonly NormalizedJobPosting[]): Set<string> =>
  new Set(list.map((entry) => `${entry.platform}|${entry.postingId.trim()}`));

describe('Property 7: Upsert into the Posting_Store is idempotent', () => {
  /**
   * **Validates: Requirements 9.2, 9.4**
   *
   * For all result lists of at most 250 Job_Posting and for all Scrape_Run start times, applying the
   * list twice with the same start time leaves the same data state as applying it once — identical
   * record count and identical value in every stored field — and the records are exactly the
   * distinct `(platform, trim(postingId))` pairs of the list, so Posting_Id that differ only in
   * surrounding whitespace share one record.
   */
  it('leaves the same stored state after a second application of the same result list', async () => {
    await fc.assert(
      fc.asyncProperty(resultListArbitrary, runStartedAtArbitrary, async (list, runStartedAt) => {
        // Each iteration starts from an empty store with its own Scrape_Run to attach to.
        await postgres.truncate();

        const run = await seedScrapeRun(postgres.prisma, { startedAt: runStartedAt });
        const repository = new PostingRepository(postgres.prisma);

        const apply = async (): Promise<{ created: number }> => {
          let created = 0;

          for (const entry of list) {
            const result = await repository.upsert(entry, run.id, runStartedAt);

            // 9.2: what the store holds as the key is the trimmed Posting_Id.
            expect(result.postingId).toBe(entry.postingId.trim());

            if (result.created) {
              created += 1;
            }
          }

          return { created };
        };

        const expectedRecords = uniqueKeysOf(list);

        const firstPass = await apply();
        const afterFirstPass = await snapshot();

        // The first application inserts exactly one record per distinct key, whatever the list
        // repeated.
        expect(firstPass.created).toBe(expectedRecords.size);
        expect(afterFirstPass).toHaveLength(expectedRecords.size);
        expect(uniqueKeysOf(afterFirstPass)).toEqual(expectedRecords);

        const secondPass = await apply();
        const afterSecondPass = await snapshot();

        // 9.4: the data state is the one the single application produced. Compared as whole rows,
        // so every field of 9.1 is part of the assertion — including the record identifiers, which
        // a delete-and-reinsert would change.
        expect(afterSecondPass).toEqual(afterFirstPass);

        // Nothing was created the second time round: every entry matched an existing record (9.3).
        expect(secondPass.created).toBe(0);

        for (const row of afterFirstPass) {
          expect(row.postingId).toBe(row.postingId.trim());
          expect(row.postingId.length).toBeGreaterThan(0);

          // Both times come from the Scrape_Run start time and from no clock, which is what makes
          // the two snapshots comparable in the first place (9.1, 9.3).
          expect(row.firstSeenAt).toEqual(runStartedAt);
          expect(row.lastSeenAt).toEqual(runStartedAt);
          expect(row.firstSeenRunId).toBe(run.id);
          expect(row.postingStatus).toBe('LISTED');
        }
      }),
      { ...PROPERTY_RUNS, examples: [[exampleResultList(), new Date('2026-03-02T08:00:00.000Z')]] },
    );
  });
});
