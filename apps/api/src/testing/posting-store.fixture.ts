/**
 * Seed data for the integration tests (9.6).
 *
 * Three builders over the Posting_Store, each usable on its own:
 *
 * - `seedScrapeRun` writes one Scrape_Run, the record every Job_Posting needs as its first
 *   recording run (11.1);
 * - `seedJobPosting` writes one Job_Posting into an existing run, including a stored relevance
 *   assessment;
 * - `seedPostingStore` writes the complete baseline a migration replay has to survive: a completed
 *   Scrape_Run, its Platform result with the effective Search_Profile in a typed JSON column, a
 *   Log_Stream message and a Job_Posting with its relevance assessment and its commute result.
 *
 * Every value is fixed rather than generated, so a test can assert on it and a failure names a
 * concrete row. The property tests of tasks 11.4 – 11.6 bring their own fast-check arbitraries and
 * use these builders only where they need a Scrape_Run to attach to; the read-layer tests of task
 * 15.10 vary the overrides per posting to build their filter and sorting data sets.
 *
 * Requirements: 9.6.
 */

import { computeContentHash } from '@job-scraper/domain';

import { type PrismaService } from '../prisma/prisma.service';
import { type JobPosting, type Prisma, type ScrapeRun } from '../prisma/prisma.types';

/** Fixed identifiers, so an assertion can name the row it means. */
export const SEEDED_RUN_ID = '11111111-1111-4111-8111-111111111111';
export const SEEDED_POSTING_ID = '22222222-2222-4222-8222-222222222222';

/** Fixed times in UTC: the run started at 08:00 and ended 12 minutes later. */
export const SEEDED_RUN_STARTED_AT = new Date('2026-03-02T08:00:00.000Z');
export const SEEDED_RUN_FINISHED_AT = new Date('2026-03-02T08:12:00.000Z');

/** The seeded Job_Posting's content, and the hash the stored assessment was based on. */
export const SEEDED_POSTING_TITLE = 'Senior Backend Engineer';
export const SEEDED_POSTING_DESCRIPTION =
  'Entwicklung von Services in TypeScript, PostgreSQL und AWS. Hybrides Arbeiten in München.';
export const SEEDED_CONTENT_HASH = computeContentHash(
  SEEDED_POSTING_TITLE,
  SEEDED_POSTING_DESCRIPTION,
);

/** The effective Search_Profile of the seeded Platform result (3.8). */
export const SEEDED_EFFECTIVE_PROFILE: PrismaJson.EffectiveSearchProfileJson = {
  platform: 'STEPSTONE',
  criteria: [
    { field: 'jobTitle', value: 'Softwareentwickler', provenance: 'DEFAULT' },
    { field: 'searchLocation', value: 'München', provenance: 'DEFAULT' },
    { field: 'searchRadiusKm', value: 30, provenance: 'OVERRIDE' },
  ],
};

/**
 * Writes one Scrape_Run.
 *
 * The default is a run that reached the Run_Outcome "completed", because that is the state the
 * sweep of 9.5 and the "neu" marking of 11.2 are gated on. A test that needs a cancelled or still
 * running run overrides `status` and `runOutcome`.
 */
export const seedScrapeRun = async (
  prisma: PrismaService,
  overrides: Partial<Prisma.ScrapeRunUncheckedCreateInput> = {},
): Promise<ScrapeRun> =>
  prisma.scrapeRun.create({
    data: {
      id: SEEDED_RUN_ID,
      startedAt: SEEDED_RUN_STARTED_AT,
      finishedAt: SEEDED_RUN_FINISHED_AT,
      status: 'FINISHED',
      runOutcome: 'COMPLETED',
      ...overrides,
    },
  });

/**
 * Writes one Job_Posting with a stored relevance assessment into an existing Scrape_Run.
 *
 * `firstSeenRunId` is required and not defaulted: the foreign key to the recording Scrape_Run is
 * the one field a caller cannot be allowed to forget, since Prisma would otherwise fail with a
 * constraint error instead of a readable one.
 */
export const seedJobPosting = async (
  prisma: PrismaService,
  firstSeenRunId: string,
  overrides: Partial<Prisma.JobPostingUncheckedCreateInput> = {},
): Promise<JobPosting> =>
  prisma.jobPosting.create({
    data: {
      id: SEEDED_POSTING_ID,
      platform: 'STEPSTONE',
      postingId: 'stepstone-4711',
      title: SEEDED_POSTING_TITLE,
      employer: 'Beispiel GmbH',
      workLocation: 'München',
      publishedAt: new Date('2026-02-27T00:00:00.000Z'),
      sourceUrl: 'https://www.stepstone.de/stellenangebote--4711',
      descriptionText: SEEDED_POSTING_DESCRIPTION,

      firstSeenAt: SEEDED_RUN_STARTED_AT,
      lastSeenAt: SEEDED_RUN_STARTED_AT,
      firstSeenRunId,
      postingStatus: 'LISTED',
      interestFlag: 'UNMARKED',

      // The relevance assessment 9.6 requires to survive a migration, with the content hash it was
      // based on, so the re-assessment gate of 15.5 has something truthful to compare against.
      relevanceVerdict: 'RELEVANT',
      relevanceReason: 'Passt zum gesuchten Profil: Backend, TypeScript und PostgreSQL in München.',
      relevanceModel: 'claude-sonnet-4-5',
      relevanceAssessedAt: SEEDED_RUN_FINISHED_AT,
      relevanceSetManually: false,
      relevanceRank: 0,
      contentHash: SEEDED_CONTENT_HASH,
      relevanceContentHash: SEEDED_CONTENT_HASH,

      bicycleMinutes: 41,
      transitMinutes: 28,
      bestCommuteMinutes: 28,
      bestCommuteMode: 'TRANSIT',
      commutePrecision: 'EXACT',
      commuteLocationInput: 'München',
      commuteCheckedAt: SEEDED_RUN_FINISHED_AT,

      ...overrides,
    },
  });

/** Everything {@link seedPostingStore} wrote, for assertions that follow the seeding. */
export interface SeededPostingStore {
  readonly run: ScrapeRun;
  readonly posting: JobPosting;
}

/**
 * Writes the baseline data set: one completed Scrape_Run with a Platform result and a Log_Stream
 * message, plus one Job_Posting with a relevance assessment.
 *
 * This is the data the migration replay of 9.6 must leave untouched, and the smallest data set in
 * which every table that carries user-visible history is populated.
 */
export const seedPostingStore = async (prisma: PrismaService): Promise<SeededPostingStore> => {
  const run = await seedScrapeRun(prisma);

  await prisma.scrapeRunPlatformResult.create({
    data: {
      runId: run.id,
      platform: 'STEPSTONE',
      platformStatus: 'COMPLETED',
      pagesFetched: 3,
      newPostings: 1,
      updatedPostings: 0,
      partialResult: false,
      missingMandatoryFields: [],
      effectiveProfile: SEEDED_EFFECTIVE_PROFILE,
    },
  });

  await prisma.logMessage.create({
    data: {
      runId: run.id,
      sequence: 1,
      createdAt: SEEDED_RUN_STARTED_AT,
      platform: 'STEPSTONE',
      level: 'INFO',
      code: 'platform.started',
      messageDe: 'Stepstone: Abruf gestartet.',
      detail: { platform: 'STEPSTONE' },
    },
  });

  const posting = await seedJobPosting(prisma, run.id);

  return { run, posting };
};
