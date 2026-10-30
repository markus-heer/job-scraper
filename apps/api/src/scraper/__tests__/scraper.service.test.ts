/**
 * Unit tests for the retrieval phase of a Scrape_Run (task 12.3).
 *
 * The subject is the orchestration, so every test is phrased as a statement about what the
 * Scraper_Service does with what a Platform reports — not about what a Platform reports, which is
 * the adapters' own fixture suites, and not about what an upsert writes, which is the posting
 * suite. The Posting_Store writes nevertheless go through the real `PostingRepository` and the real
 * per-Platform configuration resolution, because the caller's half of 9.5, 9.7 and 9.9 is only
 * meaningful against the real gate and the real field groups.
 *
 * Three requirements have a natural home here and nowhere else:
 *
 * - **9.9** — a rejected single upsert reaches the Log_Stream with platform name and Posting_Id, is
 *   counted, and the run continues with the remaining Job_Posting. The repository half ("the record
 *   stays in its pre-write state") is `posting.repository.write-failure.test.ts`.
 * - **13.1 and 7.3** — one Platform's failure never ends the Scrape_Run.
 * - **13.6** — the retrieval deadline sends no further Platform request and marks every unfinished
 *   Platform and the Scrape_Run "cancelled by time limit".
 *
 * The concurrency *bound* of 13.9 is Property 12 in `packages/scrapers` and is not re-asserted
 * here; what is asserted is that this service runs the Platform concurrently at all and hands every
 * adapter the semaphore, which is the part that lives in this file.
 */

import { type Platform, PLATFORMS, type PlatformStatus } from '@job-scraper/domain';
import {
  type AdapterRegistry,
  type AdapterResult,
  buildAdapterResult,
  type RawJobPosting,
} from '@job-scraper/scrapers';
import { beforeEach, describe, expect, it } from 'vitest';

import { ROBOTS_IGNORED_LOG_CODE } from '../../common/error-mapping';
import type { RobotsPolicy } from '../../config/env.schema';
import type { PlatformConfigurationInputs } from '../../platform-config/platform-config.resolve';
import { PlatformConfigurationService } from '../../platform-config/platform-config.service';
import {
  createPostingStore,
  type PostingStoreFixture,
  type SeedPosting,
} from '../../posting/__tests__/job-posting-delegate.fixture';
import { PostingRepository } from '../../posting/posting.repository';
import { retrievalDeadlineOf } from '../../scrape-run/scrape-run.coordinator';
import { type PlatformRunResult, ScraperService } from '../scraper.service';
import {
  configurationInputs,
  createLogRecorder,
  createPlatformResultStore,
  createRetrievalRuntime,
  FakeAdapter,
  type LogRecorderFixture,
  permissiveRobots,
  type PlatformResultStoreFixture,
  type RetrievalRuntimeFixture,
} from './scraper.fixture';

const RUN_ID = 'run-1';
/** The stored start time of the Scrape_Run, which is the only time source of every write (9.3). */
const RUN_STARTED_AT = new Date('2026-03-02T08:00:00.000Z');

/**
 * The retrieval deadline of 13.6, derived from the *real* clock rather than from
 * {@link RUN_STARTED_AT}.
 *
 * The window that watches the deadline compares it against `Date.now()`, as it must: a deadline
 * measured from a fixed past timestamp would have expired before the test began, which is the one
 * case the deadline test below asks for on purpose.
 */
const openDeadline = (): Date => retrievalDeadlineOf(new Date());

/** A raw posting as a Platform_Adapter hands it over, with every field set. */
const raw = (overrides: Partial<RawJobPosting> = {}): RawJobPosting => ({
  postingId: 'abc-1',
  title: 'Projektmanagerin Pharma',
  employer: 'Beispiel Pharma GmbH',
  workLocation: 'München',
  publishedAtText: '2026-02-27',
  sourceUrl: 'https://www.stepstone.test/jobs/abc-1',
  descriptionText: 'Sie steuern Projekte im Bereich Life Science.',
  ...overrides,
});

/** An adapter that reports `platformStatus` with the postings it read. */
const reporting = <P extends Platform>(
  platform: P,
  postings: readonly RawJobPosting[],
  platformStatus: PlatformStatus = 'COMPLETED',
  pagesFetched = 1,
): FakeAdapter<P> =>
  new FakeAdapter(platform, () =>
    Promise.resolve(buildAdapterResult({ platform, postings, platformStatus, pagesFetched })),
  );

/** An adapter that throws, as 13.1 describes: the unexpected, not an observed Platform_Status. */
const throwing = <P extends Platform>(platform: P, error: unknown): FakeAdapter<P> =>
  new FakeAdapter(platform, () => Promise.reject(error));

/** A rejection shaped like the one the generated client raises for an unreachable Posting_Store. */
const storeUnreachable = (): Error & { code: string } =>
  Object.assign(new Error("Can't reach database server at `localhost:5432`"), { code: 'P1001' });

interface Harness {
  readonly service: ScraperService;
  readonly postings: PostingStoreFixture;
  readonly log: LogRecorderFixture;
  readonly runtime: RetrievalRuntimeFixture;
  readonly results: PlatformResultStoreFixture;
}

const createHarness = (options: {
  readonly registry: AdapterRegistry;
  readonly configuration?: Partial<PlatformConfigurationInputs>;
  readonly seed?: readonly SeedPosting[];
  /** The Robots_Policy of 14.10. Defaults to `respect`, the conservative value. */
  readonly robotsPolicy?: RobotsPolicy;
}): Harness => {
  const postings = createPostingStore(options.seed ?? []);
  const log = createLogRecorder();
  const runtime = createRetrievalRuntime();
  const results = createPlatformResultStore();
  const service = new ScraperService(
    new PlatformConfigurationService(configurationInputs(options.configuration)),
    new PostingRepository(postings.store),
    results.store,
    log.log,
    { userAgentContact: 'kontakt@example.com', robotsPolicy: options.robotsPolicy ?? 'respect' },
    options.registry,
    runtime.runtime,
  );

  return { service, postings, log, runtime, results };
};

/** Runs the retrieval phase with the deadline of 13.6 and an abort signal of the caller's choice. */
const execute = async (
  harness: Harness,
  options: { readonly signal?: AbortSignal; readonly retrievalDeadline?: Date } = {},
) =>
  harness.service.execute({
    runId: RUN_ID,
    runStartedAt: RUN_STARTED_AT,
    retrievalDeadline: options.retrievalDeadline ?? openDeadline(),
    signal: options.signal ?? new AbortController().signal,
  });

/** The result of one Platform, which is always present: one per Platform of `PLATFORMS`. */
const resultOf = (
  platforms: readonly PlatformRunResult[],
  platform: Platform,
): PlatformRunResult => {
  const result = platforms.find((entry) => entry.platform === platform);

  if (result === undefined) {
    throw new Error(`No result for platform ${platform}`);
  }

  return result;
};

describe('ScraperService', () => {
  describe('per-Platform results', () => {
    it('reports exactly one Platform_Status per Platform and counts new and updated postings', async () => {
      const harness = createHarness({
        registry: {
          STEPSTONE: reporting('STEPSTONE', [raw(), raw({ postingId: 'abc-2' })], 'COMPLETED', 2),
          JOBVECTOR: reporting('JOBVECTOR', [raw({ postingId: 'jv-1' })]),
        },
      });

      const first = await execute(harness);

      expect(first.runOutcome).toBe('COMPLETED');
      expect(first.platforms.map((entry) => entry.platform)).toEqual([...PLATFORMS]);
      expect(resultOf(first.platforms, 'STEPSTONE')).toMatchObject({
        platformStatus: 'COMPLETED',
        pagesFetched: 2,
        newPostings: 2,
        updatedPostings: 0,
        partialResult: false,
        failedWrites: 0,
      });
      expect(resultOf(first.platforms, 'JOBVECTOR').newPostings).toBe(1);

      // A Platform that is activated and completely configured but has no Platform_Adapter yet is
      // reported rather than omitted, with the one permitted status for "was not queried".
      expect(resultOf(first.platforms, 'INDEED').platformStatus).toBe('NOT_YET_RUN');
      expect(harness.log.withCode('platform.noAdapter')).toHaveLength(2);

      const second = await execute(harness);

      // The second run sights the same postings again: 9.3's update half, counted as "updated".
      expect(resultOf(second.platforms, 'STEPSTONE')).toMatchObject({
        newPostings: 0,
        updatedPostings: 2,
      });
    });

    it('writes the effective Search_Profile of every activated Platform and persists it', async () => {
      const harness = createHarness({
        registry: { STEPSTONE: reporting('STEPSTONE', []) },
      });

      const execution = await execute(harness);
      const profileLines = harness.log.withCode('platform.effectiveProfile');

      // 3.8: one line per activated Platform, carrying the value of every Criterion_Field.
      expect(profileLines).toHaveLength(PLATFORMS.length);
      expect(profileLines[0]?.messageDe).toContain('jobTitle="Projektmanagerin"');

      const stored = harness.results.rowOf(RUN_ID, 'STEPSTONE');

      expect(stored).toMatchObject({ platformStatus: 'COMPLETED', pagesFetched: 1 });
      expect(stored?.effectiveProfile).toEqual(
        resultOf(execution.platforms, 'STEPSTONE').effectiveProfile,
      );
    });

    it('skips a deactivated Platform with DISABLED and never opens a page for it', async () => {
      const adapter = reporting('STEPSTONE', [raw()]);
      const harness = createHarness({
        registry: { STEPSTONE: adapter },
        configuration: {
          activation: { STEPSTONE: false, JOBVECTOR: false, INDEED: false, GLASSDOOR: false },
        },
      });

      const execution = await execute(harness);

      expect(resultOf(execution.platforms, 'STEPSTONE').platformStatus).toBe('DISABLED');
      expect(adapter.contexts).toHaveLength(0);
      expect(harness.runtime.robotsRequests).toHaveLength(0);
      expect(harness.log.withCode('platform.disabled')).toHaveLength(PLATFORMS.length);
    });

    it('skips an incompletely configured Platform and names the missing fields', async () => {
      const harness = createHarness({
        registry: { STEPSTONE: reporting('STEPSTONE', [raw()]) },
        // Without a search location, Stepstone's mandatory Criterion_Field do not resolve (4.9).
        configuration: { defaults: { jobTitle: 'Projektmanagerin' } },
      });

      const execution = await execute(harness);
      const stepstone = resultOf(execution.platforms, 'STEPSTONE');

      expect(stepstone.platformStatus).toBe('INCOMPLETE_CONFIGURATION');
      expect(stepstone.missingMandatoryFields).toEqual(['searchLocation']);
      expect(harness.results.rowOf(RUN_ID, 'STEPSTONE')).toMatchObject({
        platformStatus: 'INCOMPLETE_CONFIGURATION',
        missingMandatoryFields: ['searchLocation'],
      });
      expect(harness.log.withCode('platform.incompleteConfiguration')[0]?.messageDe).toContain(
        'Suchort (searchLocation)',
      );
    });
  });

  describe('failure containment', () => {
    it('ends a throwing Platform with FAILED and runs the remaining Platform to the end', async () => {
      const jobvector = reporting('JOBVECTOR', [raw({ postingId: 'jv-1' })]);
      const harness = createHarness({
        registry: {
          STEPSTONE: throwing('STEPSTONE', new Error('selector gone')),
          JOBVECTOR: jobvector,
        },
      });

      const execution = await execute(harness);

      // 13.1: the error is reported, the Platform_Status is "failed", the Scrape_Run completes.
      expect(execution.runOutcome).toBe('COMPLETED');
      expect(resultOf(execution.platforms, 'STEPSTONE').platformStatus).toBe('FAILED');
      expect(harness.log.withCode('page.failed')).toHaveLength(1);
      expect(resultOf(execution.platforms, 'JOBVECTOR').platformStatus).toBe('COMPLETED');
      expect(jobvector.contexts).toHaveLength(1);
      expect(harness.postings.rowOf('JOBVECTOR', 'jv-1')).toBeDefined();
    });

    it('keeps the Partial_Result of a sign-in wall and makes no second attempt', async () => {
      const stepstone = reporting(
        'STEPSTONE',
        [raw(), raw({ postingId: 'abc-2' })],
        'SIGN_IN_REQUIRED',
      );
      const harness = createHarness({ registry: { STEPSTONE: stepstone } });

      const execution = await execute(harness);
      const result = resultOf(execution.platforms, 'STEPSTONE');

      // 7.7: the postings read before the wall are stored; 7.3: the run completes regularly.
      expect(result).toMatchObject({
        platformStatus: 'SIGN_IN_REQUIRED',
        partialResult: true,
        newPostings: 2,
      });
      expect(execution.runOutcome).toBe('COMPLETED');

      // 7.8: at most 0 repetitions, and the Platform's request queue is closed with its context.
      expect(stepstone.contexts).toHaveLength(1);
      expect(harness.runtime.pageSources).toHaveLength(1);
      expect(harness.runtime.pageSources[0]?.closed).toBe(true);
    });

    it('does not retrieve a Platform whose robots.txt forbids the intended paths', async () => {
      const stepstone = reporting('STEPSTONE', [raw()]);
      const harness = createHarness({ registry: { STEPSTONE: stepstone } });

      harness.runtime.setRobots(
        'STEPSTONE',
        permissiveRobots({ disallowedPaths: ['/jobs'], status: 'EVALUATED' }),
      );

      const execution = await execute(harness);

      // 14.2: no page request, no Job_Posting, and the remaining Platform keep being executed.
      expect(resultOf(execution.platforms, 'STEPSTONE').platformStatus).toBe(
        'EXCLUDED_BY_ROBOTS_TXT',
      );
      expect(stepstone.contexts).toHaveLength(0);
      expect(harness.runtime.pageSources).toHaveLength(0);
      expect(harness.postings.rows.size).toBe(0);
      expect(harness.log.withCode('robots.disallowed')).toHaveLength(1);
    });

    it('retrieves a Platform its robots.txt forbids when the policy is ignore (14.11, 14.12)', async () => {
      const stepstone = reporting('STEPSTONE', [raw()]);
      const harness = createHarness({
        registry: { STEPSTONE: stepstone },
        robotsPolicy: 'ignore',
      });

      harness.runtime.setRobots(
        'STEPSTONE',
        permissiveRobots({ disallowedPaths: ['/jobs'], status: 'EVALUATED' }),
      );

      const execution = await execute(harness);

      // 14.11: the prohibition does not gate, so the Platform is retrieved and its Job_Posting are
      // stored. `EXCLUDED_BY_ROBOTS_TXT` is not reported for this reason any more.
      expect(resultOf(execution.platforms, 'STEPSTONE').platformStatus).toBe('COMPLETED');
      expect(stepstone.contexts).toHaveLength(1);
      expect(harness.postings.rows.size).toBe(1);
      expect(harness.log.withCode('robots.disallowed')).toHaveLength(0);

      // 14.12: and the user reads that it happened. One warning per Platform, naming the path, so
      // the decision is visible in the Log_View rather than buried in a configuration file.
      const warnings = harness.log.withCode(ROBOTS_IGNORED_LOG_CODE);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.level).toBe('WARN');
      expect(warnings[0]?.messageDe).toContain('/jobs');
      expect(warnings[0]?.messageDe).toContain('ROBOTS_POLICY');
    });

    it('retrieves a Platform whose robots.txt was unevaluable when the policy is ignore', async () => {
      const stepstone = reporting('STEPSTONE', [raw()]);
      const harness = createHarness({
        registry: { STEPSTONE: stepstone },
        robotsPolicy: 'ignore',
      });

      harness.runtime.setRobots('STEPSTONE', permissiveRobots({ status: 'UNAVAILABLE' }));

      const execution = await execute(harness);

      expect(resultOf(execution.platforms, 'STEPSTONE').platformStatus).toBe('COMPLETED');
      expect(harness.log.withCode('robots.unavailable')).toHaveLength(0);
      expect(harness.log.withCode(ROBOTS_IGNORED_LOG_CODE)).toHaveLength(1);
    });

    it('reports a rejected single upsert and continues with the remaining Job_Posting', async () => {
      const harness = createHarness({
        registry: {
          STEPSTONE: reporting('STEPSTONE', [
            raw(),
            raw({ postingId: 'abc-2' }),
            raw({ postingId: 'abc-3' }),
          ]),
        },
      });

      harness.postings.failNextWrite(storeUnreachable());

      const execution = await execute(harness);
      const reported = harness.log.withCode('posting.writeFailed');

      // 9.9: platform name and Posting_Id in the Log_Stream, at ERROR.
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatchObject({ level: 'ERROR', platform: 'STEPSTONE' });
      expect(reported[0]?.messageDe).toContain('abc-1');
      expect(reported[0]?.detail).toMatchObject({ postingId: 'abc-1' });

      // Counted for the run summary, and the two following postings are stored.
      expect(resultOf(execution.platforms, 'STEPSTONE')).toMatchObject({
        failedWrites: 1,
        newPostings: 2,
      });
      expect(harness.postings.rowOf('STEPSTONE', 'abc-1')).toBeUndefined();
      expect(harness.postings.rowOf('STEPSTONE', 'abc-2')).toBeDefined();
      expect(harness.postings.rowOf('STEPSTONE', 'abc-3')).toBeDefined();
      expect(resultOf(execution.platforms, 'STEPSTONE').platformStatus).toBe('COMPLETED');
    });

    it('discards a Job_Posting without a mandatory field and keeps the rest', async () => {
      const harness = createHarness({
        registry: {
          STEPSTONE: reporting('STEPSTONE', [raw({ title: '   ' }), raw({ postingId: 'abc-2' })]),
        },
      });

      const execution = await execute(harness);

      // 6.5: the unusable posting is discarded and reported, the retrieval continues.
      expect(resultOf(execution.platforms, 'STEPSTONE')).toMatchObject({
        discardedPostings: 1,
        newPostings: 1,
      });
      expect(harness.log.withCode('posting.discarded')).toHaveLength(1);
    });
  });

  describe('the gated sweep', () => {
    const seeded: readonly SeedPosting[] = [
      {
        platform: 'STEPSTONE',
        postingId: 'gone-1',
        title: 'Projektleiterin',
        sourceUrl: 'https://www.stepstone.test/jobs/gone-1',
        firstSeenRunId: 'run-0',
        postingStatus: 'LISTED',
      },
    ];

    it('marks a stored Job_Posting absent from a completed retrieval as no longer listed', async () => {
      const harness = createHarness({
        registry: { STEPSTONE: reporting('STEPSTONE', [raw()]) },
        seed: seeded,
      });

      const execution = await execute(harness);

      // 9.5: both halves of the gate are open — the run completed and so did the Platform.
      expect(resultOf(execution.platforms, 'STEPSTONE').sweptPostings).toBe(1);
      expect(harness.postings.rowOf('STEPSTONE', 'gone-1')?.postingStatus).toBe('NO_LONGER_LISTED');
      expect(harness.log.withCode('platform.postingsSwept')).toHaveLength(1);
    });

    it('leaves every Posting_Status untouched when the Platform did not complete', async () => {
      const harness = createHarness({
        registry: { STEPSTONE: reporting('STEPSTONE', [raw()], 'FETCH_RATE_LIMITED') },
        seed: seeded,
      });

      const execution = await execute(harness);

      // 9.7: a truncated result list is not evidence that the missing postings are gone.
      expect(resultOf(execution.platforms, 'STEPSTONE').sweptPostings).toBe(0);
      expect(harness.postings.rowOf('STEPSTONE', 'gone-1')?.postingStatus).toBe('LISTED');
    });

    it('protects a Job_Posting whose write was rejected from the sweep', async () => {
      const harness = createHarness({
        registry: { STEPSTONE: reporting('STEPSTONE', [raw({ postingId: 'gone-1' })]) },
        seed: seeded,
      });

      harness.postings.failNextWrite(storeUnreachable());

      const execution = await execute(harness);

      // The Platform listed the posting, so it is not absent from the result list of 9.5 — a failed
      // write must not hide a stored Job_Posting from the user's default view.
      expect(resultOf(execution.platforms, 'STEPSTONE').failedWrites).toBe(1);
      expect(resultOf(execution.platforms, 'STEPSTONE').sweptPostings).toBe(0);
      expect(harness.postings.rowOf('STEPSTONE', 'gone-1')?.postingStatus).toBe('LISTED');
    });
  });

  describe('deadlines and cancellation', () => {
    it('sends no Platform request once the retrieval deadline has passed', async () => {
      const stepstone = reporting('STEPSTONE', [raw()]);
      const harness = createHarness({ registry: { STEPSTONE: stepstone } });

      const execution = await execute(harness, { retrievalDeadline: new Date(Date.now() - 1) });

      // 13.6: no further Platform request, the Run_Outcome and every unfinished Platform_Status are
      // "cancelled by time limit", and the limit is reported once.
      expect(execution.runOutcome).toBe('CANCELLED_BY_TIME_LIMIT');
      expect(resultOf(execution.platforms, 'STEPSTONE').platformStatus).toBe(
        'CANCELLED_BY_TIME_LIMIT',
      );
      expect(stepstone.contexts).toHaveLength(0);
      expect(harness.log.withCode('run.timeLimitReached')).toHaveLength(1);
    });

    it('keeps what a finished Platform reported when the user cancels mid-run', async () => {
      const controller = new AbortController();
      const stepstone = new FakeAdapter<'STEPSTONE'>('STEPSTONE', () => {
        controller.abort(
          Object.assign(new Error('Suchlauf abgebrochen.'), {
            name: 'ScrapeRunCancelledError',
            runOutcome: 'CANCELLED_BY_USER',
          }),
        );

        return Promise.resolve(
          buildAdapterResult({
            platform: 'STEPSTONE',
            postings: [raw()],
            platformStatus: 'COMPLETED',
            pagesFetched: 1,
          }),
        );
      });
      const jobvector = new FakeAdapter<'JOBVECTOR'>('JOBVECTOR', async (context) => {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => {
            resolve();
          });
        });

        throw context.signal.reason;
      });
      const harness = createHarness({
        registry: { STEPSTONE: stepstone, JOBVECTOR: jobvector },
        seed: [
          {
            platform: 'STEPSTONE',
            postingId: 'gone-1',
            title: 'Projektleiterin',
            sourceUrl: 'https://www.stepstone.test/jobs/gone-1',
            firstSeenRunId: 'run-0',
          },
        ],
      });

      const execution = await execute(harness, { signal: controller.signal });

      expect(execution.runOutcome).toBe('CANCELLED_BY_USER');

      // The Platform that got through keeps the status it reported; the unfinished one is not
      // blamed for the cancellation and carries the only permitted "was not queried" value.
      expect(resultOf(execution.platforms, 'STEPSTONE').platformStatus).toBe('COMPLETED');
      expect(resultOf(execution.platforms, 'JOBVECTOR').platformStatus).toBe('NOT_YET_RUN');

      // 9.7: the Run_Outcome is not "completed", so no Posting_Status is swept — not even for the
      // Platform that completed.
      expect(resultOf(execution.platforms, 'STEPSTONE').sweptPostings).toBe(0);
      expect(harness.postings.rowOf('STEPSTONE', 'gone-1')?.postingStatus).toBe('LISTED');

      // The postings read before the cancellation are retained (12.7).
      expect(harness.postings.rowOf('STEPSTONE', 'abc-1')).toBeDefined();
    });
  });

  describe('concurrency and etiquette', () => {
    let running: number;
    let peak: number;

    beforeEach(() => {
      running = 0;
      peak = 0;
    });

    const counting = <P extends Platform>(platform: P): FakeAdapter<P> =>
      new FakeAdapter(platform, async () => {
        running += 1;
        peak = Math.max(peak, running);

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });

        running -= 1;

        return buildAdapterResult({
          platform,
          postings: [],
          platformStatus: 'COMPLETED',
          pagesFetched: 1,
        }) satisfies AdapterResult;
      });

    it('runs the activated Platform concurrently, one page source and one robots.txt each', async () => {
      const harness = createHarness({
        registry: {
          STEPSTONE: counting('STEPSTONE'),
          JOBVECTOR: counting('JOBVECTOR'),
          INDEED: counting('INDEED'),
          GLASSDOOR: counting('GLASSDOOR'),
        },
      });

      const execution = await execute(harness);

      expect(execution.platforms.every((entry) => entry.platformStatus === 'COMPLETED')).toBe(true);
      expect(peak).toBe(PLATFORMS.length);

      // 14.1: exactly one robots.txt evaluation per Platform, before its first page request.
      expect(harness.runtime.robotsRequests.map((request) => request.platform).sort()).toEqual(
        [...PLATFORMS].sort(),
      );
      expect(harness.runtime.pageSources).toHaveLength(PLATFORMS.length);
    });

    it('hands the stated crawl-delay of the robots.txt to that Platform (14.4)', async () => {
      const harness = createHarness({ registry: { STEPSTONE: reporting('STEPSTONE', []) } });

      harness.runtime.setRobots('STEPSTONE', permissiveRobots({ crawlDelaySeconds: 5 }));

      await execute(harness);

      expect(harness.runtime.pageSources[0]).toMatchObject({
        platform: 'STEPSTONE',
        crawlDelaySeconds: 5,
      });

      // 14.5: the retrieval phase is opened with the Job_Tool user agent, which names the tool,
      // states private use and carries the configured contact detail.
      expect(harness.runtime.userAgent()).toBe(
        'JobTool/0.1 (private use; contact: kontakt@example.com)',
      );
    });
  });
});
