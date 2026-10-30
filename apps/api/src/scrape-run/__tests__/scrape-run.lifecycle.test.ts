/**
 * The Scrape_Run lifecycle with the coordinator and the Scraper_Service wired together (task 12.9).
 *
 * The two components are tested in isolation elsewhere — `scrape-run.coordinator.test.ts` for the
 * lifecycle decisions, `scrape-run.recovery.test.ts` for the stale-run recovery and
 * `scraper/__tests__/scraper.service.test.ts` for the retrieval phase — and nothing those suites
 * already state is repeated here. What this file adds is the handover between them, which no
 * component test can reach: the run identifier, the start time, the retrieval deadline and the
 * abort signal the coordinator hands to `execute`, and the Run_Outcome, the retrieval end and the
 * Log_Stream lines that come back. That is the sequence the run mutations of task 12.4 will drive,
 * so a break in it would otherwise only surface in the Web_App.
 *
 * Six statements live here and nowhere else:
 *
 * - **12.5** — a second start while a retrieval is actually running returns the running identifier
 *   with the already-running hint and creates no second Scrape_Run; the component tests start no
 *   retrieval at all, so they cannot say that about a run that is busy.
 * - **13.1** — a throwing Platform_Adapter ends its own Platform with "failed" and the Scrape_Run
 *   is still stored as "completed".
 * - **13.6** — the retrieval deadline derived by the coordinator is the one the service stops at,
 *   and the Run_Outcome it reports is the one that reaches the `ScrapeRun` row.
 * - **12.7** — a cancellation aborts the signal the adapters are retrieving with, waits for that
 *   retrieval and closes the run; the caller of the retrieval phase then finds the run closed.
 * - **12.14** — cancelling the run this process just completed is rejected with its stored
 *   Run_Outcome.
 * - **9.9** — a rejected single upsert reaches the Log_Stream as `ERROR` `posting.writeFailed` with
 *   platform name and Posting_Id, the remaining Job_Posting of the run are stored, and the
 *   Scrape_Run still ends "completed". The repository half is `posting.repository.write-failure`,
 *   the per-Platform counter half is the Scraper_Service suite; what is new here is that a failed
 *   write does not change the Run_Outcome the coordinator stores.
 *
 * The enrichment grace deadline is covered as far as it exists: the coordinator derives it from the
 * *actual* end of the retrieval the service reports, and a run whose grace period has passed is
 * closable and does not keep the next Scrape_Run from starting (12.1). The German line for
 * outstanding enrichment work (`run.enrichmentDeadline`) belongs to the enrichment stages, which
 * are tasks 13 and 15; no component writes it yet, so nothing here asserts it.
 *
 * Only the two stores, the Log_Stream, the browser runtime and the Platform_Adapter are stand-ins.
 * The coordinator, the Scraper_Service, the per-Platform configuration resolution, the
 * `PostingRepository` and the central error mapping are the real ones.
 *
 * Requirements: 9.9, 12.1, 12.5, 12.7, 12.14, 13.1, 13.6.
 */

import { type Platform, PLATFORMS } from '@job-scraper/domain';
import {
  type AdapterRegistry,
  buildAdapterResult,
  type RawJobPosting,
} from '@job-scraper/scrapers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mapFailure, RUN_OUTCOME_LABELS_DE } from '../../common/error-mapping';
import type { PlatformConfigurationInputs } from '../../platform-config/platform-config.resolve';
import { PlatformConfigurationService } from '../../platform-config/platform-config.service';
import {
  createPostingStore,
  type PostingStoreFixture,
  type SeedPosting,
} from '../../posting/__tests__/job-posting-delegate.fixture';
import { PostingRepository } from '../../posting/posting.repository';
import {
  configurationInputs,
  createPlatformResultStore,
  createRetrievalRuntime,
  FakeAdapter,
  type PlatformResultStoreFixture,
  type RetrievalRuntimeFixture,
} from '../../scraper/__tests__/scraper.fixture';
import { ScraperService, type ScrapeRunExecution } from '../../scraper/scraper.service';
import {
  enrichmentGraceDeadlineOf,
  RETRIEVAL_LIMIT_MINUTES,
  ScrapeRunCoordinator,
} from '../scrape-run.coordinator';
import {
  createLogRecorder,
  createScrapeRunStore,
  type LogRecorderFixture,
  type ScrapeRunStoreFixture,
} from './scrape-run.fixture';

const ENRICHMENT_GRACE_MINUTES = 10;

const MINUTE_MS = 60_000;

/** A raw posting as a Platform_Adapter hands it over, with every mandatory field set. */
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

/** A deferred, so a test decides when an adapter returns. */
const deferred = () => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

/** An adapter that completes with the postings it read. */
const completing = <P extends Platform>(
  platform: P,
  postings: readonly RawJobPosting[] = [],
): FakeAdapter<P> =>
  new FakeAdapter(platform, () =>
    Promise.resolve(
      buildAdapterResult({ platform, postings, platformStatus: 'COMPLETED', pagesFetched: 1 }),
    ),
  );

/** An adapter that completes only once `release` settles, reporting when it was entered. */
const blocking = <P extends Platform>(
  platform: P,
  options: { readonly release: Promise<void>; readonly entered: () => void },
): FakeAdapter<P> =>
  new FakeAdapter(platform, async () => {
    options.entered();

    await options.release;

    return buildAdapterResult({
      platform,
      postings: [],
      platformStatus: 'COMPLETED',
      pagesFetched: 1,
    });
  });

/** An adapter that waits for the abort of the Scrape_Run and rejects with its reason (12.7). */
const abortAwaiting = <P extends Platform>(
  platform: P,
  options: { readonly entered: () => void },
): FakeAdapter<P> =>
  new FakeAdapter(platform, async (context) => {
    options.entered();

    await new Promise<void>((resolve) => {
      context.signal.addEventListener('abort', () => {
        resolve();
      });
    });

    throw context.signal.reason;
  });

/** A rejection shaped like the one the generated client raises for an unreachable Posting_Store. */
const storeUnreachable = (): Error & { code: string } =>
  Object.assign(new Error("Can't reach database server at `localhost:5432`"), { code: 'P1001' });

interface Harness {
  readonly coordinator: ScrapeRunCoordinator;
  readonly service: ScraperService;
  readonly runs: ScrapeRunStoreFixture;
  readonly postings: PostingStoreFixture;
  readonly log: LogRecorderFixture;
  readonly runtime: RetrievalRuntimeFixture;
  readonly results: PlatformResultStoreFixture;
}

/**
 * The coordinator and the Scraper_Service over one Log_Stream and one `ScrapeRun` store.
 *
 * One recorder for both, because the order of the lifecycle lines relative to the retrieval lines
 * is part of what this file is about: the start line of the run comes before the first Platform
 * line, and the cancellation line after the last one.
 */
const createHarness = (options: {
  readonly registry: AdapterRegistry;
  readonly configuration?: Partial<PlatformConfigurationInputs>;
  readonly seed?: readonly SeedPosting[];
}): Harness => {
  const runs = createScrapeRunStore();
  const postings = createPostingStore(options.seed ?? []);
  const log = createLogRecorder();
  const runtime = createRetrievalRuntime();
  const results = createPlatformResultStore();

  return {
    coordinator: new ScrapeRunCoordinator(runs.store, log.log, {
      enrichmentGraceMinutes: ENRICHMENT_GRACE_MINUTES,
    }),
    service: new ScraperService(
      new PlatformConfigurationService(configurationInputs(options.configuration)),
      new PostingRepository(postings.store),
      results.store,
      log.log,
      { userAgentContact: 'kontakt@example.com', robotsPolicy: 'respect' },
      options.registry,
      runtime.runtime,
    ),
    runs,
    postings,
    log,
    runtime,
    results,
  };
};

/**
 * Starts the retrieval phase of the running Scrape_Run, exactly as task 12.4's mutation will.
 *
 * Everything `execute` is given comes from the coordinator's snapshot, and the settlement of the
 * phase is registered with it, so a cancellation waits for this promise (12.7).
 */
const startRetrieval = (harness: Harness): Promise<ScrapeRunExecution> => {
  const active = harness.coordinator.activeScrapeRun();

  if (active === null) {
    throw new Error('No Scrape_Run is running.');
  }

  const retrieval = harness.service.execute({
    runId: active.runId,
    runStartedAt: active.startedAt,
    retrievalDeadline: active.retrievalDeadline,
    signal: active.signal,
  });

  harness.coordinator.registerRetrieval(active.runId, retrieval);

  return retrieval;
};

/** One whole Scrape_Run: start, retrieve, report the end of the retrieval, close. */
const runScrapeRun = async (
  harness: Harness,
): Promise<{ readonly runId: string; readonly execution: ScrapeRunExecution }> => {
  const started = await harness.coordinator.start();
  const execution = await startRetrieval(harness);

  harness.coordinator.noteRetrievalEnd(started.runId, execution.retrievalEndedAt);

  await harness.coordinator.finish(started.runId, execution.runOutcome);

  return { runId: started.runId, execution };
};

/** The Platform_Status of one Platform in an execution; always present, one per Platform. */
const statusOf = (execution: ScrapeRunExecution, platform: Platform): string => {
  const result = execution.platforms.find((entry) => entry.platform === platform);

  if (result === undefined) {
    throw new Error(`No result for platform ${platform}`);
  }

  return result.platformStatus;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('a Scrape_Run in which every Platform completes', () => {
  it('stores the Run_Outcome of the retrieval phase and one result row per Platform', async () => {
    const harness = createHarness({
      registry: {
        STEPSTONE: completing('STEPSTONE', [raw()]),
        JOBVECTOR: completing('JOBVECTOR', [raw({ postingId: 'jv-1' })]),
        INDEED: completing('INDEED', [raw({ postingId: 'in-1' })]),
        GLASSDOOR: completing('GLASSDOOR', [raw({ postingId: 'gd-1' })]),
      },
    });

    const { runId, execution } = await runScrapeRun(harness);

    expect(execution.runOutcome).toBe('COMPLETED');
    expect(execution.platforms.map((entry) => entry.platformStatus)).toEqual(
      PLATFORMS.map(() => 'COMPLETED'),
    );

    // The Run_Outcome the retrieval phase reached is the one in the row — the service returns it,
    // the coordinator stores it, and nothing in between recomputes it.
    const row = harness.runs.rowOf(runId);

    expect(row?.status).toBe('FINISHED');
    expect(row?.runOutcome).toBe('COMPLETED');
    expect(row?.finishedAt).toBeInstanceOf(Date);
    expect(row?.closedByRecovery).toBe(false);
    expect(harness.runs.writes).toEqual([
      { kind: 'create', id: runId },
      { kind: 'update', id: runId },
    ]);

    // One `ScrapeRunPlatformResult` per requested Platform, under the run the coordinator created.
    expect(
      PLATFORMS.map((platform) => harness.results.rowOf(runId, platform)?.platformStatus),
    ).toEqual(PLATFORMS.map(() => 'COMPLETED'));

    // Every message of the run belongs to that run, the start line is the first of them, and the
    // per-Platform counters arrive before the run is released.
    expect(harness.log.messages.every((message) => message.runId === runId)).toBe(true);
    expect(harness.log.messages.at(0)?.code).toBe('run.started');
    expect(harness.log.withCode('platform.counters')).toHaveLength(PLATFORMS.length);
    expect(harness.log.initialised).toEqual([runId]);
    expect(harness.log.released).toEqual([runId]);

    expect(harness.coordinator.currentRunId()).toBeNull();
    expect(harness.postings.rowOf('STEPSTONE', 'abc-1')).toBeDefined();
    expect(harness.postings.rowOf('GLASSDOOR', 'gd-1')).toBeDefined();
  });

  it('rejects a cancellation of the run it has just completed and names its Run_Outcome (12.14)', async () => {
    const harness = createHarness({ registry: { STEPSTONE: completing('STEPSTONE', [raw()]) } });

    const { runId } = await runScrapeRun(harness);
    const writesBefore = harness.runs.writes.length;

    const result = await harness.coordinator.cancel(runId);

    expect(result).toEqual({
      runId,
      cancelled: false,
      runOutcome: 'COMPLETED',
      rejection: 'NOT_RUNNING',
    });

    // Nothing is written for a cancellation that cannot take effect, and the user is told what the
    // run ended with instead.
    expect(harness.runs.writes).toHaveLength(writesBefore);
    expect(harness.runs.rowOf(runId)?.runOutcome).toBe('COMPLETED');
    expect(harness.log.withCode('run.cancelRejected').at(0)?.messageDe).toContain(
      RUN_OUTCOME_LABELS_DE.COMPLETED,
    );
  });

  it('closes the Scrape_Run a crashed process left behind before the next one runs', async () => {
    const harness = createHarness({ registry: { STEPSTONE: completing('STEPSTONE', [raw()]) } });
    const stale = harness.runs.seed({
      status: 'RUNNING',
      startedAt: new Date('2026-03-01T08:00:00.000Z'),
    });

    const recovered = await harness.coordinator.recoverStaleRuns();

    expect(recovered.map((run) => run.runId)).toEqual([stale.id]);

    const { runId, execution } = await runScrapeRun(harness);

    // The crashed run is closed as a recovery, the new one on its own merits, and the two rows do
    // not interfere.
    expect(harness.runs.rowOf(stale.id)).toMatchObject({
      status: 'FINISHED',
      runOutcome: 'CANCELLED_BY_TIME_LIMIT',
      closedByRecovery: true,
    });
    expect(execution.runOutcome).toBe('COMPLETED');
    expect(harness.runs.rowOf(runId)).toMatchObject({
      status: 'FINISHED',
      runOutcome: 'COMPLETED',
      closedByRecovery: false,
    });
  });
});

describe('a second start while a retrieval is running (12.5)', () => {
  it('returns the running identifier with the hint and creates no second Scrape_Run', async () => {
    const release = deferred();
    const entered = deferred();
    const harness = createHarness({
      registry: {
        STEPSTONE: blocking('STEPSTONE', {
          release: release.promise,
          entered: entered.resolve,
        }),
      },
    });

    const started = await harness.coordinator.start();
    const retrieval = startRetrieval(harness);

    await entered.promise;

    const second = await harness.coordinator.start();

    expect(second).toEqual({ runId: started.runId, alreadyRunning: true });
    expect(harness.runs.rows.size).toBe(1);
    expect(harness.log.withCode('run.alreadyRunning').at(0)).toMatchObject({
      runId: started.runId,
      messageDe: mapFailure({ kind: 'run.alreadyRunning', runningRunId: started.runId })
        .userMessageDe,
    });

    // The running retrieval is untouched by the refused start: the same abort signal, the same
    // deadline, and it still completes.
    expect(harness.coordinator.activeScrapeRun()?.signal.aborted).toBe(false);

    release.resolve();

    const execution = await retrieval;

    harness.coordinator.noteRetrievalEnd(started.runId, execution.retrievalEndedAt);
    await harness.coordinator.finish(started.runId, execution.runOutcome);

    // Only once the run is closed does a start create a second Scrape_Run.
    const third = await harness.coordinator.start();

    expect(third.alreadyRunning).toBe(false);
    expect(third.runId).not.toBe(started.runId);
    expect(harness.runs.rows.size).toBe(2);
  });
});

describe('a Platform_Adapter that throws (13.1)', () => {
  it('ends that Platform with "failed" and stores the Scrape_Run as completed', async () => {
    const jobvector = completing('JOBVECTOR', [raw({ postingId: 'jv-1' })]);
    const harness = createHarness({
      registry: {
        STEPSTONE: new FakeAdapter('STEPSTONE', () => Promise.reject(new Error('selector gone'))),
        JOBVECTOR: jobvector,
      },
    });

    const { runId, execution } = await runScrapeRun(harness);

    expect(statusOf(execution, 'STEPSTONE')).toBe('FAILED');
    expect(statusOf(execution, 'JOBVECTOR')).toBe('COMPLETED');

    // One Platform's failure is not the run's: the row says "completed", and the Job_Posting of the
    // Platform that got through are stored.
    expect(harness.runs.rowOf(runId)?.runOutcome).toBe('COMPLETED');
    expect(harness.postings.rowOf('JOBVECTOR', 'jv-1')).toBeDefined();
    expect(harness.results.rowOf(runId, 'STEPSTONE')?.platformStatus).toBe('FAILED');
    expect(jobvector.contexts).toHaveLength(1);
  });
});

describe('the retrieval deadline of the running Scrape_Run (13.6)', () => {
  it('stops the retrieval at the deadline the coordinator derived and stores its Run_Outcome', async () => {
    vi.useFakeTimers({ now: new Date('2026-03-02T08:00:00.000Z') });

    const stepstone = completing('STEPSTONE', [raw()]);
    const harness = createHarness({ registry: { STEPSTONE: stepstone } });

    const started = await harness.coordinator.start();
    const active = harness.coordinator.activeScrapeRun();

    expect(active?.retrievalDeadline.getTime()).toBe(
      (active?.startedAt.getTime() ?? 0) + RETRIEVAL_LIMIT_MINUTES * MINUTE_MS,
    );

    // The deadline passes before the retrieval phase opens, which is the one case that needs no
    // waiting: 30 minutes of the Scrape_Run are over.
    vi.advanceTimersByTime(RETRIEVAL_LIMIT_MINUTES * MINUTE_MS + 1);

    const execution = await startRetrieval(harness);

    harness.coordinator.noteRetrievalEnd(started.runId, execution.retrievalEndedAt);
    await harness.coordinator.finish(started.runId, execution.runOutcome);

    expect(execution.runOutcome).toBe('CANCELLED_BY_TIME_LIMIT');
    expect(statusOf(execution, 'STEPSTONE')).toBe('CANCELLED_BY_TIME_LIMIT');
    expect(stepstone.contexts).toHaveLength(0);
    expect(harness.runtime.pageSources).toHaveLength(0);

    expect(harness.runs.rowOf(started.runId)).toMatchObject({
      status: 'FINISHED',
      runOutcome: 'CANCELLED_BY_TIME_LIMIT',
    });
    expect(harness.log.withCode('run.timeLimitReached').at(0)).toMatchObject({
      level: 'WARN',
      messageDe: mapFailure({
        kind: 'run.timeLimitReached',
        limitMinutes: RETRIEVAL_LIMIT_MINUTES,
      }).userMessageDe,
    });

    // The next Scrape_Run can start: a run ended by the time limit holds nothing back (12.1).
    await expect(harness.coordinator.start()).resolves.toMatchObject({ alreadyRunning: false });
  });
});

describe('a cancellation while the Platform are being retrieved (12.7)', () => {
  it('aborts the retrieval, waits for it and closes the run with "cancelled by user"', async () => {
    const entered = deferred();
    const harness = createHarness({
      registry: { STEPSTONE: abortAwaiting('STEPSTONE', { entered: entered.resolve }) },
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

    const started = await harness.coordinator.start();
    const retrieval = startRetrieval(harness);

    await entered.promise;

    const cancelled = await harness.coordinator.cancel(started.runId);
    const execution = await retrieval;

    expect(cancelled).toEqual({
      runId: started.runId,
      cancelled: true,
      runOutcome: 'CANCELLED_BY_USER',
      rejection: null,
    });

    // The abort reached the adapter, and the cause survived the way down: the retrieval phase
    // reports the user's cancellation, not a failure of the Platform.
    expect(execution.runOutcome).toBe('CANCELLED_BY_USER');
    expect(statusOf(execution, 'STEPSTONE')).toBe('NOT_YET_RUN');
    expect(harness.runs.rowOf(started.runId)).toMatchObject({
      status: 'FINISHED',
      runOutcome: 'CANCELLED_BY_USER',
    });
    expect(harness.log.withCode('run.cancelledByUser').at(0)?.messageDe).toBe(
      mapFailure({ kind: 'run.cancelledByUser' }).userMessageDe,
    );

    // 9.7: the Run_Outcome is not "completed", so no stored Job_Posting is swept.
    expect(harness.postings.rowOf('STEPSTONE', 'gone-1')?.postingStatus).toBe('LISTED');

    // The caller of the retrieval phase finds the run closed and writes no second end time.
    await expect(harness.coordinator.finish(started.runId, execution.runOutcome)).resolves.toEqual({
      status: 'NOT_ACTIVE',
    });
    expect(harness.runs.writes.filter((write) => write.kind === 'update')).toHaveLength(1);
  });
});

describe('the enrichment grace deadline', () => {
  it('measures the grace period from the end of the retrieval the service reported', async () => {
    vi.useFakeTimers({ now: new Date('2026-03-02T08:00:00.000Z') });

    const harness = createHarness({ registry: { STEPSTONE: completing('STEPSTONE', [raw()]) } });

    const started = await harness.coordinator.start();
    const active = harness.coordinator.activeScrapeRun();
    const execution = await startRetrieval(harness);

    const deadline = harness.coordinator.noteRetrievalEnd(
      started.runId,
      execution.retrievalEndedAt,
    );

    expect(deadline).toEqual(
      enrichmentGraceDeadlineOf(execution.retrievalEndedAt, ENRICHMENT_GRACE_MINUTES),
    );
    expect(harness.coordinator.activeScrapeRun()?.enrichmentGraceDeadline).toEqual(deadline);

    // Measured from the actual end of the retrieval, not from the retrieval deadline: a phase that
    // finished early does not buy the enrichment stages the rest of the 30 minutes.
    expect(deadline?.getTime()).toBeLessThan(
      enrichmentGraceDeadlineOf(
        active?.retrievalDeadline ?? new Date(0),
        ENRICHMENT_GRACE_MINUTES,
      ).getTime(),
    );
  });

  it('closes a run whose grace period has passed and lets the next one start (12.1)', async () => {
    vi.useFakeTimers({ now: new Date('2026-03-02T08:00:00.000Z') });

    const harness = createHarness({ registry: { STEPSTONE: completing('STEPSTONE', [raw()]) } });

    const started = await harness.coordinator.start();
    const execution = await startRetrieval(harness);
    const deadline = harness.coordinator.noteRetrievalEnd(
      started.runId,
      execution.retrievalEndedAt,
    );

    // The enrichment stages of tasks 13 and 15 stop at this instant; what is asserted here is the
    // coordinator's half — the bound is reachable and the run is closable once it has passed, so a
    // hanging Routing_Provider or AI_Provider cannot keep a Scrape_Run in "running" forever.
    vi.advanceTimersByTime(ENRICHMENT_GRACE_MINUTES * MINUTE_MS + 1);

    expect(deadline?.getTime()).toBeLessThan(Date.now());

    await expect(
      harness.coordinator.finish(started.runId, execution.runOutcome),
    ).resolves.toMatchObject({ status: 'CLOSED' });
    expect(harness.runs.rowOf(started.runId)?.runOutcome).toBe('COMPLETED');
    await expect(harness.coordinator.start()).resolves.toMatchObject({ alreadyRunning: false });
  });
});

describe('a rejected single upsert during a running Scrape_Run (9.9)', () => {
  it('reports platform name and Posting_Id, keeps going and still ends the run completed', async () => {
    const harness = createHarness({
      registry: {
        STEPSTONE: completing('STEPSTONE', [
          raw(),
          raw({ postingId: 'abc-2' }),
          raw({ postingId: 'abc-3' }),
        ]),
        // Without postings of its own, so the one rejected write is the first one of Stepstone
        // whatever order the two Platform run in (13.9).
        JOBVECTOR: completing('JOBVECTOR'),
      },
    });
    const failure = storeUnreachable();

    harness.postings.failNextWrite(failure);

    const { runId, execution } = await runScrapeRun(harness);
    const reported = harness.log.withCode('posting.writeFailed');
    const expected = mapFailure({
      kind: 'posting.writeFailed',
      platform: 'STEPSTONE',
      postingId: 'abc-1',
      cause: failure,
    });

    // The German sentence, its level and its code come from the central mapping, and the line is
    // attached to the Scrape_Run the coordinator created.
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      runId,
      level: expected.logLevel,
      platform: 'STEPSTONE',
      messageDe: expected.userMessageDe,
      detail: { postingId: 'abc-1' },
    });
    expect(expected.logLevel).toBe('ERROR');

    // The run continues with the remaining Job_Posting, and the other Platform is unaffected.
    expect(harness.postings.rowOf('STEPSTONE', 'abc-1')).toBeUndefined();
    expect(harness.postings.rowOf('STEPSTONE', 'abc-2')).toBeDefined();
    expect(harness.postings.rowOf('STEPSTONE', 'abc-3')).toBeDefined();
    expect(statusOf(execution, 'JOBVECTOR')).toBe('COMPLETED');

    // A rejected write is not a failed Scrape_Run: the Platform_Status and the Run_Outcome both
    // say the retrieval got through.
    expect(statusOf(execution, 'STEPSTONE')).toBe('COMPLETED');
    expect(harness.runs.rowOf(runId)?.runOutcome).toBe('COMPLETED');
    expect(harness.coordinator.currentRunId()).toBeNull();
  });
});
