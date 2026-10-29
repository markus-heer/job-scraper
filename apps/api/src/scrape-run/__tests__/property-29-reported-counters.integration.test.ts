/**
 * Property 29 of the job-search-tool design: the counters the Job_Tool reports equal the stored data
 * (11.5, 15.16).
 *
 * **Validates: Requirements 11.5, 15.16**
 *
 * Six numbers, read from two components, and the claim is the same for all of them: what is reported
 * equals an independently computed count over the generated input and over the table contents after
 * the run.
 *
 * - **Three on the posting overview (11.5).** The Job_Posting recorded for the first time in the most
 *   recently completed Scrape_Run, the Job_Posting sighted again in it, and the Job_Posting stored in
 *   total. `ScrapeRunReadService.latestScrapeRunSummary` reports them; the first two are a `_sum`
 *   over that run's `ScrapeRunPlatformResult` rows, the third a tally of the whole `JobPosting`
 *   table.
 * - **Three at the end of a Scrape_Run (15.16).** The assessed Job_Posting, the ones with the
 *   Relevance_Verdict "not relevant" and the ones with "not assessed", which
 *   `RelevanceEnrichmentService.enrichRun` reports and the end-of-run Log_Stream line of task 14.5
 *   carries verbatim.
 *
 * ## Where the counters are evaluated, and why
 *
 * Against real PostgreSQL, through the real components, rather than against in-memory stand-ins.
 * Three of the six numbers are statements about SQL and about the agreement of two components over
 * stored rows:
 *
 * - "Recorded for the first time" is `UpsertResult.created` — an upsert that inserted a record — and
 *   its complement is "sighted again". That distinction is produced by the real
 *   `(platform, postingId)` unique constraint, which is why Properties 7 and 8 live against a
 *   container as well. An in-memory delegate would confirm that the repository agrees with the
 *   fixture's own `findUnique`, not with the constraint the Job_Tool ships.
 * - The two per-run counters travel from that upsert tally through `ScrapeRunPlatformResult` rows
 *   into an aggregate `_sum`, which is answered by the engine and not by the service: `_sum` over
 *   zero rows is `null`, it is scoped by a `where` on one `runId` while other runs' rows sit in the
 *   same table, and it returns a sum over `Int` columns. A stand-in `aggregate` would be this test
 *   re-implementing the thing under test.
 * - The total is a store-wide `count()` that has to stay store-wide: it counts the Job_Posting of
 *   every Scrape_Run and every Platform, including the ones this run never saw.
 *
 * The relevance half is kept in the same file because Property 29 is one claim over all six numbers,
 * and it runs against the same container for the same reason: the counted outcomes reach the stored
 * verdicts through the real `PostingRepository` write and are compared against a count over the
 * stored rows, so "reported" and "stored" cannot agree by sharing one in-memory map.
 *
 * `pnpm test` stays offline: the file is an `*.integration.test.ts` and therefore excluded from the
 * unit configuration, like Properties 7 to 9 and 24.
 *
 * ## What the generators produce
 *
 * For 11.5, a list of Job_Posting per Platform split into new and previously stored — three kinds, so
 * the third kind separates the two run counters from the store-wide total: a Job_Posting the earlier
 * Scrape_Run stored and this one did not see again is counted by neither per-run number and by the
 * total. Every iteration also writes decoy `ScrapeRunPlatformResult` rows with generated counters for
 * an earlier completed Scrape_Run and for a later cancelled one, so an aggregate that forgot its
 * `where` or a selection that took the latest end time regardless of the Run_Outcome (11.7) fails
 * instead of passing by coincidence.
 *
 * For 15.16, a verdict distribution over the candidates of one Scrape_Run plus a generated
 * assessment budget, so the "not assessed" count covers both of its sources: an unusable AI_Provider
 * response (15.12) and a Job_Posting the run budget did not reach (15.7). The failing outcome is
 * always `SCHEMA_VIOLATION`, the one failure code 15.11 does not repeat — a generated `TIMEOUT` would
 * spend the real 1 s and 4 s retry intervals of the retry chain per candidate and turn 100 iterations
 * into a quarter of an hour, while the counter claim is indifferent to which failure code produced a
 * "not assessed".
 *
 * Two Job_Posting of the earlier Scrape_Run are stored with a verdict as decoys there too: they are
 * not candidates of this run, so a counter read store-wide instead of per run would exceed what the
 * stage reports.
 *
 * Each iteration clears the store and recreates its Scrape_Run, because a Job_Posting needs its
 * recording run as a foreign key (11.1).
 *
 * The `null` answer of 11.6 and which Scrape_Run the marking "neu" refers to are not this property's
 * subject: they are Property 27 and the example cases in `./scrape-run-read.service.test.ts`.
 */

// Feature: job-search-tool, Property 29 - Reported counters equal the stored data

import {
  computeContentHash,
  type EffectiveSearchProfile,
  type Platform,
  PLATFORMS,
  RELEVANCE_RANK,
} from '@job-scraper/domain';
import type { NormalizedJobPosting } from '@job-scraper/scrapers';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { EnvConfig } from '../../config/env.schema';
import type { LogMessagePayload } from '../../log-stream/log-stream.service';
import { PostingRepository } from '../../posting/posting.repository';
import type { LogMessage, RelevanceVerdict } from '../../prisma/prisma.types';
import { RelevanceService } from '../../relevance/relevance.service';
import type { RelevanceAssessor, RelevanceOutcome } from '../../relevance/relevance-assessor.port';
import {
  type RelevanceEnrichmentLog,
  RelevanceEnrichmentService,
  type RelevanceProfileSource,
} from '../../relevance/relevance-enrichment.service';
import { usePostgres } from '../../testing/postgres-harness';
import { seedScrapeRun } from '../../testing/posting-store.fixture';
import { ScrapeRunReadService } from '../scrape-run-read.service';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** Job_Posting per iteration; small enough that 100 iterations against a real engine are affordable. */
const MAX_POSTINGS = 12;

/** The Scrape_Run of an iteration: one earlier completed, the reference, one later cancelled. */
const EARLIER_RUN_ID = '44444444-4444-4444-8444-444444444444';
const REFERENCE_RUN_ID = '55555555-5555-4555-8555-555555555555';
const CANCELLED_RUN_ID = '66666666-6666-4666-8666-666666666666';

const EARLIER_STARTED_AT = new Date('2026-03-01T08:00:00.000Z');
const EARLIER_FINISHED_AT = new Date('2026-03-01T08:20:00.000Z');
const REFERENCE_STARTED_AT = new Date('2026-03-02T08:00:00.000Z');
const REFERENCE_FINISHED_AT = new Date('2026-03-02T08:25:00.000Z');
const CANCELLED_STARTED_AT = new Date('2026-03-03T08:00:00.000Z');

/** The cancelled run has the latest end time of the three, and still must not be the reference (11.7). */
const CANCELLED_FINISHED_AT = new Date('2026-03-03T08:05:00.000Z');

/**
 * What a generated Job_Posting is to the two Scrape_Run of an iteration.
 *
 * The three kinds are what separate the two per-run counters of 11.5 from the store-wide total.
 */
type PostingKind =
  /** Not stored before; this Scrape_Run records it for the first time. */
  | 'NEW'
  /** Stored by the earlier Scrape_Run and sighted again in this one. */
  | 'RESIGHTED'
  /** Stored by the earlier Scrape_Run and absent from this one's result list. */
  | 'ONLY_EARLIER';

/** One generated Job_Posting, in the two dimensions the counters of 11.5 read. */
interface PostingSpec {
  readonly platform: Platform;
  readonly kind: PostingKind;
}

/** A generated Job_Posting with the Posting_Id it is stored under; unique across the iteration. */
interface SeededSpec extends PostingSpec {
  readonly postingId: string;
}

/** The counters of the decoy result rows, which no reported number may contain. */
interface DecoyCounters {
  readonly newPostings: number;
  readonly updatedPostings: number;
}

/** The two counters one Platform contributed to the reference Scrape_Run. */
interface PlatformTally {
  newPostings: number;
  updatedPostings: number;
}

/** The three kinds as a value list, so the generator and the pinned example share one source. */
const POSTING_KINDS = [
  'NEW',
  'RESIGHTED',
  'ONLY_EARLIER',
] as const satisfies readonly PostingKind[];

const postingArbitrary = fc.record<PostingSpec>({
  platform: fc.constantFrom(...PLATFORMS),
  kind: fc.constantFrom(...POSTING_KINDS),
});

/** Names each generated Job_Posting by its position, so the unique key of 9.2 holds by itself. */
const withPostingIds = (specs: readonly PostingSpec[]): readonly SeededSpec[] =>
  specs.map((spec, index) => ({ ...spec, postingId: `p${String(index)}` }));

const postingSetArbitrary: fc.Arbitrary<readonly SeededSpec[]> = fc
  .array(postingArbitrary, { maxLength: MAX_POSTINGS })
  .map(withPostingIds);

/** Deliberately large next to a list of at most 12 postings, so a leaked decoy row is obvious. */
const decoyArbitrary = fc.record<DecoyCounters>({
  newPostings: fc.integer({ min: 0, max: 500 }),
  updatedPostings: fc.integer({ min: 0, max: 500 }),
});

/** A generated Job_Posting as the normalization layer would hand it to the repository. */
const normalizedOf = (spec: SeededSpec): NormalizedJobPosting => ({
  platform: spec.platform,
  postingId: spec.postingId,
  title: `Projektmanagerin ${spec.postingId}`,
  employer: 'Beispiel Pharma GmbH',
  workLocation: 'München',
  publishedAt: null,
  sourceUrl: `https://www.${spec.platform.toLowerCase()}.example/--${spec.postingId}`,
  descriptionText: 'Sie steuern Projekte im Bereich Life Science.',
});

/** Was this Job_Posting already stored when the reference Scrape_Run started? */
const storedEarlier = (spec: SeededSpec): boolean => spec.kind !== 'NEW';

/** Did the result list of the reference Scrape_Run contain this Job_Posting? */
const sightedNow = (spec: SeededSpec): boolean => spec.kind !== 'ONLY_EARLIER';

const countOfKind = (specs: readonly SeededSpec[], kind: PostingKind): number =>
  specs.filter((spec) => spec.kind === kind).length;

/** A list that holds every Platform in every kind at once, pinned as a generation example. */
const EXAMPLE_SPECS: readonly PostingSpec[] = PLATFORMS.flatMap((platform) =>
  POSTING_KINDS.map((kind) => ({ platform, kind })),
);

/** The decoy counters of the pinned example; both non-zero, so neither sum can leak unnoticed. */
const EXAMPLE_DECOY: DecoyCounters = { newPostings: 97, updatedPostings: 43 };

const postgres = usePostgres();

/** Writes the three Scrape_Run of an iteration into the empty store. */
const seedRuns = async (): Promise<void> => {
  await seedScrapeRun(postgres.prisma, {
    id: EARLIER_RUN_ID,
    startedAt: EARLIER_STARTED_AT,
    finishedAt: EARLIER_FINISHED_AT,
  });
  await seedScrapeRun(postgres.prisma, {
    id: REFERENCE_RUN_ID,
    startedAt: REFERENCE_STARTED_AT,
    finishedAt: REFERENCE_FINISHED_AT,
  });
  await seedScrapeRun(postgres.prisma, {
    id: CANCELLED_RUN_ID,
    startedAt: CANCELLED_STARTED_AT,
    finishedAt: CANCELLED_FINISHED_AT,
    runOutcome: 'CANCELLED_BY_USER',
  });
};

/**
 * Writes one `ScrapeRunPlatformResult`, exactly as `ScraperService.persistPlatformResult` does.
 *
 * An upsert on `(runId, platform)`, so the row this test writes is the row the production write
 * would produce and the aggregate reads the same shape in both cases.
 */
const writePlatformResult = async (
  runId: string,
  platform: Platform,
  counters: PlatformTally | DecoyCounters,
): Promise<void> => {
  const row = {
    platformStatus: 'COMPLETED' as const,
    pagesFetched: 1,
    newPostings: counters.newPostings,
    updatedPostings: counters.updatedPostings,
    partialResult: false,
    missingMandatoryFields: [] as string[],
  };

  await postgres.prisma.scrapeRunPlatformResult.upsert({
    where: { runId_platform: { runId, platform } },
    create: { runId, platform, ...row },
    update: row,
  });
};

describe('Property 29: Reported counters equal the stored data', () => {
  /**
   * **Validates: Requirements 11.5**
   *
   * For all Scrape_Run contents — any split of any Job_Posting list per Platform into Job_Posting
   * recorded for the first time, Job_Posting sighted again and Job_Posting only an earlier Scrape_Run
   * stored — the posting overview reports the number recorded for the first time in the most recently
   * completed Scrape_Run, the number sighted again and the number stored in total equal to the
   * independently computed counts over that generated input, together with the start time, the end
   * time and the Run_Outcome of that Scrape_Run. The result rows of an earlier completed and of a
   * later cancelled Scrape_Run contribute to none of the three numbers.
   */
  it('reports the first-recorded, re-sighted and total counts of the reference Scrape_Run', async () => {
    await fc.assert(
      fc.asyncProperty(postingSetArbitrary, decoyArbitrary, async (specs, decoy) => {
        await postgres.truncate();
        await seedRuns();

        const repository = new PostingRepository(postgres.prisma);

        // The earlier Scrape_Run recorded everything that is "already stored" when this run starts.
        for (const spec of specs.filter(storedEarlier)) {
          await repository.upsert(normalizedOf(spec), EARLIER_RUN_ID, EARLIER_STARTED_AT);
        }

        // The result list of the reference Scrape_Run, counted per Platform the way the
        // Scraper_Service counts it: an upsert that inserted a record is a Job_Posting recorded for
        // the first time, one that matched an existing record is a Job_Posting sighted again.
        const tallies = new Map<Platform, PlatformTally>(
          PLATFORMS.map((platform) => [platform, { newPostings: 0, updatedPostings: 0 }]),
        );

        for (const spec of specs.filter(sightedNow)) {
          const result = await repository.upsert(
            normalizedOf(spec),
            REFERENCE_RUN_ID,
            REFERENCE_STARTED_AT,
          );
          const tally = tallies.get(spec.platform);

          if (tally === undefined) {
            throw new Error(`No tally for platform ${spec.platform}.`);
          }

          if (result.created) {
            tally.newPostings += 1;
          } else {
            tally.updatedPostings += 1;
          }
        }

        // One result row per Platform for the reference run — a Platform that found nothing reports
        // zeros rather than no row — and the decoy rows of the two other Scrape_Run.
        for (const platform of PLATFORMS) {
          const tally = tallies.get(platform) ?? { newPostings: 0, updatedPostings: 0 };

          await writePlatformResult(REFERENCE_RUN_ID, platform, tally);
          await writePlatformResult(EARLIER_RUN_ID, platform, decoy);
          await writePlatformResult(CANCELLED_RUN_ID, platform, decoy);
        }

        const expectedNew = countOfKind(specs, 'NEW');
        const expectedResighted = countOfKind(specs, 'RESIGHTED');

        // Every generated Posting_Id is distinct, so the stored total is the whole list — including
        // the Job_Posting this Scrape_Run never saw, which is what makes the third number
        // store-wide rather than per run.
        const expectedTotal = specs.length;

        // Asserted before the summary, so a disagreement between the run's own tally and the
        // generated split is reported as that rather than as a wrong aggregate.
        const tallied = [...tallies.values()];

        expect(tallied.reduce((sum, tally) => sum + tally.newPostings, 0)).toBe(expectedNew);
        expect(tallied.reduce((sum, tally) => sum + tally.updatedPostings, 0)).toBe(
          expectedResighted,
        );

        const summary = await new ScrapeRunReadService(postgres.prisma).latestScrapeRunSummary();

        expect(summary).toEqual({
          id: REFERENCE_RUN_ID,
          startedAt: REFERENCE_STARTED_AT,
          finishedAt: REFERENCE_FINISHED_AT,
          runOutcome: 'COMPLETED',
          newPostings: expectedNew,
          resightedPostings: expectedResighted,
          totalPostings: expectedTotal,
        });
      }),
      { ...PROPERTY_RUNS, examples: [[withPostingIds(EXAMPLE_SPECS), EXAMPLE_DECOY]] },
    );
  });
});

/** The model the stubbed AI_Provider reports as the one that answered. */
const MODEL = 'claude-sonnet-4-5-20250929';

/** The German reason the stub answers with; at most 300 characters, as 15.3 requires. */
const REASON_DE = 'Fachgebiet und Seniorität passen zum Suchprofil.';

/** The assessment benchmark of 15.2; one profile for every Platform. */
const PROFILE: EffectiveSearchProfile = {
  platform: 'STEPSTONE',
  criteria: [{ field: 'jobTitle', value: 'Projektmanagerin', provenance: 'DEFAULT' }],
};

const profiles: RelevanceProfileSource = { effectiveProfileOf: () => PROFILE };

/** Accepts every Log_Stream line of the stage; which line is written is task 14.4's subject. */
const log: RelevanceEnrichmentLog = {
  emit: (payload: LogMessagePayload): Promise<LogMessage> =>
    Promise.resolve({
      id: 'log',
      runId: payload.runId,
      sequence: 1,
      createdAt: new Date(),
      platform: payload.platform ?? null,
      level: payload.level,
      code: payload.code,
      messageDe: payload.messageDe,
      detail: payload.detail ?? null,
    }),
};

/**
 * What the AI_Provider answers for one candidate.
 *
 * The three verdicts a response may carry (15.3) plus the one failure 15.12 discards without
 * repeating it. See the module documentation for why no retriable failure code is generated.
 */
type CandidateOutcome = 'RELEVANT' | 'NOT_RELEVANT' | 'UNCERTAIN' | 'SCHEMA_VIOLATION';

const CANDIDATE_OUTCOMES = [
  'RELEVANT',
  'NOT_RELEVANT',
  'UNCERTAIN',
  'SCHEMA_VIOLATION',
] as const satisfies readonly CandidateOutcome[];

const outcomeArbitrary = fc.constantFrom(...CANDIDATE_OUTCOMES);

/** The generated verdict distribution of one Scrape_Run. */
const distributionArbitrary = fc.array(outcomeArbitrary, { maxLength: MAX_POSTINGS });

/** The assessment budget of 15.7; reaches 0 and values above the candidate count. */
const budgetArbitrary = fc.integer({ min: 0, max: MAX_POSTINGS + 2 });

/** A distribution that holds every outcome, pinned as a generation example. */
const EXAMPLE_DISTRIBUTION: readonly CandidateOutcome[] = [
  'RELEVANT',
  'NOT_RELEVANT',
  'UNCERTAIN',
  'SCHEMA_VIOLATION',
  'NOT_RELEVANT',
  'RELEVANT',
];

/** The budget of the pinned example: it binds, so both sources of "not assessed" are present. */
const EXAMPLE_BUDGET = 4;

/** The configuration as the Relevance_Service reads it; only the four relevance values matter. */
const envWith = (relevanceMaxPerRun: number): EnvConfig =>
  ({
    relevanceEnabled: true,
    anthropicApiKey: 'sk-ant-test-key',
    relevanceMaxPerRun,
    relevanceConcurrency: 4,
  }) as unknown as EnvConfig;

/** The title of the candidate at one position; unique, so the stub can answer per candidate. */
const candidateTitle = (index: number): string => `Projektmanagerin Pharma ${String(index)}`;

/** The description text of every candidate; its content is irrelevant to the counters. */
const CANDIDATE_DESCRIPTION = 'Sie steuern Projekte im Bereich Life Science.';

/** The outcome of a candidate as a `RelevanceOutcome` of the port. */
const outcomeOf = (outcome: CandidateOutcome): RelevanceOutcome =>
  outcome === 'SCHEMA_VIOLATION'
    ? { kind: 'FAILED', code: 'SCHEMA_VIOLATION' }
    : { kind: 'ASSESSED', response: { verdict: outcome, reason: REASON_DE }, model: MODEL };

/** The number of stored Job_Posting of one Scrape_Run carrying one of `verdicts`. */
const countVerdicts = async (
  runStartedAt: Date,
  verdicts: readonly RelevanceVerdict[],
): Promise<number> =>
  postgres.prisma.jobPosting.count({
    where: { lastSeenAt: runStartedAt, relevanceVerdict: { in: [...verdicts] } },
  });

describe('Property 29: Reported counters equal the stored data (relevance)', () => {
  /**
   * **Validates: Requirements 15.16**
   *
   * For all verdict distributions over the Job_Posting of a Scrape_Run and for all assessment
   * budgets, the end-of-run counters the Relevance_Service reports — the number of assessed
   * Job_Posting, the number with the Relevance_Verdict "not relevant" and the number with "not
   * assessed" — equal the independently computed counts over the generated distribution and the
   * counts of those verdicts in the Posting_Store after the run. Job_Posting of an earlier
   * Scrape_Run are counted by neither.
   */
  it('reports assessment counters equal to the stored verdicts of that Scrape_Run', async () => {
    await fc.assert(
      fc.asyncProperty(
        distributionArbitrary,
        budgetArbitrary,
        async (distribution, relevanceMaxPerRun) => {
          await postgres.truncate();
          await seedRuns();

          // The candidates of this Scrape_Run: never assessed, no manual verdict, and sighted by
          // this run, which is what the stage selects on (9.3, 15.5, 15.15). Their recording times
          // ascend with the position, so the selection order of 15.7 — oldest first — is the
          // generated order and the budget reaches exactly the first `relevanceMaxPerRun` of them.
          await postgres.prisma.jobPosting.createMany({
            data: distribution.map((_outcome, index) => ({
              platform: 'STEPSTONE' as const,
              postingId: `c${String(index)}`,
              title: candidateTitle(index),
              employer: 'Beispiel Pharma GmbH',
              workLocation: 'München',
              sourceUrl: `https://www.stepstone.example/--c${String(index)}`,
              descriptionText: CANDIDATE_DESCRIPTION,
              firstSeenAt: new Date(REFERENCE_STARTED_AT.getTime() + index * 60_000),
              lastSeenAt: REFERENCE_STARTED_AT,
              firstSeenRunId: REFERENCE_RUN_ID,
              contentHash: computeContentHash(candidateTitle(index), CANDIDATE_DESCRIPTION),
              relevanceRank: RELEVANCE_RANK.NOT_ASSESSED,
            })),
          });

          // Two Job_Posting of the earlier Scrape_Run, already carrying a verdict. They are not
          // candidates of this run, so a counter read store-wide would exceed what is reported.
          await postgres.prisma.jobPosting.createMany({
            data: (['NOT_RELEVANT', 'RELEVANT'] as const).map((verdict, index) => ({
              platform: 'INDEED' as const,
              postingId: `earlier-${String(index)}`,
              title: `Projektleiter ${String(index)}`,
              employer: 'Beispiel Pharma GmbH',
              workLocation: 'München',
              sourceUrl: `https://www.indeed.example/--earlier-${String(index)}`,
              descriptionText: CANDIDATE_DESCRIPTION,
              firstSeenAt: EARLIER_STARTED_AT,
              lastSeenAt: EARLIER_STARTED_AT,
              firstSeenRunId: EARLIER_RUN_ID,
              relevanceVerdict: verdict,
              relevanceReason: REASON_DE,
              relevanceModel: MODEL,
              relevanceAssessedAt: EARLIER_FINISHED_AT,
              relevanceRank: RELEVANCE_RANK[verdict],
              contentHash: computeContentHash(
                `Projektleiter ${String(index)}`,
                CANDIDATE_DESCRIPTION,
              ),
            })),
          });

          const byTitle = new Map(
            distribution.map((outcome, index) => [candidateTitle(index), outcome]),
          );
          const unexpectedTitles: string[] = [];
          const assessor: RelevanceAssessor = {
            model: MODEL,
            assess: (request): Promise<RelevanceOutcome> => {
              const outcome = byTitle.get(request.title);

              if (outcome === undefined) {
                unexpectedTitles.push(request.title);

                return Promise.resolve({ kind: 'FAILED', code: 'SCHEMA_VIOLATION' });
              }

              return Promise.resolve(outcomeOf(outcome));
            },
          };

          const stage = new RelevanceEnrichmentService(
            postgres.prisma,
            new RelevanceService(envWith(relevanceMaxPerRun), assessor),
            new PostingRepository(postgres.prisma),
            log,
            profiles,
          );

          const report = await stage.enrichRun({
            runId: REFERENCE_RUN_ID,
            runStartedAt: REFERENCE_STARTED_AT,
            signal: new AbortController().signal,
            // An hour from the real clock rather than from the seeded run times: the grace window
            // of 15.13 is a wall-clock bound, so a deadline derived from the stored start time
            // would already have passed and every candidate would count as outstanding instead of
            // being assessed.
            graceDeadline: new Date(Date.now() + 60 * 60_000),
          });

          // The stage asked about the candidates of this run and about nothing else, and it
          // considered every one of them — the premise the three comparisons below rest on.
          expect(unexpectedTitles).toEqual([]);
          expect(report.considered).toBe(distribution.length);

          // Over the generated input: a candidate the budget reached and the AI_Provider answered
          // for is an assessed one; every other candidate ends the run as "not assessed" (15.7,
          // 15.12).
          const withinBudget = distribution.slice(0, relevanceMaxPerRun);
          const expectedAssessed = withinBudget.filter(
            (outcome) => outcome !== 'SCHEMA_VIOLATION',
          ).length;
          const expectedNotRelevant = withinBudget.filter(
            (outcome) => outcome === 'NOT_RELEVANT',
          ).length;

          expect(report.assessed).toBe(expectedAssessed);
          expect(report.notRelevant).toBe(expectedNotRelevant);
          expect(report.notAssessed).toBe(distribution.length - expectedAssessed);

          // Over the table contents after the run: the same three numbers, counted in the
          // Posting_Store. `NOT_ASSESSED` is the Job_Tool's own record and never an answer of the
          // AI_Provider, so the stored verdicts split the candidates exactly as the report does.
          await expect(
            countVerdicts(REFERENCE_STARTED_AT, ['RELEVANT', 'NOT_RELEVANT', 'UNCERTAIN']),
          ).resolves.toBe(report.assessed);
          await expect(countVerdicts(REFERENCE_STARTED_AT, ['NOT_RELEVANT'])).resolves.toBe(
            report.notRelevant,
          );
          await expect(countVerdicts(REFERENCE_STARTED_AT, ['NOT_ASSESSED'])).resolves.toBe(
            report.notAssessed,
          );
        },
      ),
      { ...PROPERTY_RUNS, examples: [[EXAMPLE_DISTRIBUTION, EXAMPLE_BUDGET]] },
    );
  });
});
