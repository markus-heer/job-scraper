/**
 * The two run mutations and the end of a Scrape_Run.
 *
 * The subject is what task 12.4 answers for: `startScrapeRun` returning the identifier of exactly
 * one created Scrape_Run (12.1), the running identifier plus a German hint instead of a second run
 * (12.5), no Scrape_Run at all and the named cause when the creation fails (12.13),
 * `cancelScrapeRun` ending a running run (12.7) or rejecting the cancellation with the stored
 * Run_Outcome and a German reason (12.14), and the end-of-run summary with the Run_Outcome, the
 * runtime, one Platform_Status per requested Platform with its new and updated counts and the
 * incompleteness hint (7.4, 12.10) together with one persisted `ScrapeRunPlatformResult` per
 * requested Platform.
 *
 * The real lifecycle logic runs: the subject is wired to a real `ScrapeRunCoordinator` over the
 * stand-in `ScrapeRun` store and Log_Stream of this directory. Replaced are the two things that are
 * genuine I/O: the retrieval phase, as a fake that settles when the test says so — the
 * Scraper_Service has its own suite, and launching a browser here would test that one — and the
 * `ScrapeRunPlatformResult` delegate, so the persisted rows can be read back.
 *
 * `events` is what makes the one ordering rule of this task observable: the summary and the result
 * rows have to be written *before* the Scrape_Run is closed, because closing it releases the run's
 * Log_Stream state and, for a cancellation, has already stored the Run_Outcome.
 *
 * Requirements: 7.4, 12.1, 12.5, 12.7, 12.10, 12.13, 12.14.
 */

import type { Platform } from '@job-scraper/domain';
import { describe, expect, it, vi } from 'vitest';

import { PLATFORM_STATUS_LABELS_DE, RESULT_INCOMPLETE_HINT_DE } from '../../common/error-mapping';
import { PLATFORM_LABELS_DE } from '../../platform-config/platform-config.messages';
import type { ScrapeRunPlatformResult } from '../../prisma/prisma.types';
import type {
  PlatformResultStore,
  PlatformRunResult,
  ScraperExecuteInput,
  ScrapeRunExecution,
} from '../../scraper/scraper.service';
import { ScrapeRunCoordinator, type ScrapeRunStore } from '../scrape-run.coordinator';
import { runtimeLabelDe } from '../scrape-run.messages';
import {
  type CommuteEnrichmentPhase,
  type RelevanceEnrichmentPhase,
  type RetrievalPhase,
  RUN_SUMMARY_LOG_CODE,
  ScrapeRunService,
} from '../scrape-run.service';
import {
  createLogRecorder,
  createScrapeRunStore,
  type LogRecorderFixture,
  type ScrapeRunStoreFixture,
} from './scrape-run.fixture';

const ENRICHMENT_GRACE_MINUTES = 10;

/** The retrieval phase, settled by the test rather than by a browser. */
interface FakeRetrieval {
  readonly phase: RetrievalPhase;
  /** Every `execute` call, so the run's deadline and abort signal can be asserted. */
  readonly inputs: readonly ScraperExecuteInput[];
  /** Ends the retrieval phase with this result. */
  settle(execution: ScrapeRunExecution): void;
  /** Ends the retrieval phase with a rejection: it could not be carried out at all. */
  fail(error: unknown): void;
}

const createRetrieval = (): FakeRetrieval => {
  const inputs: ScraperExecuteInput[] = [];
  let resolveExecution: (execution: ScrapeRunExecution) => void = () => {};
  let rejectExecution: (error: unknown) => void = () => {};

  return {
    phase: {
      execute: (input: ScraperExecuteInput): Promise<ScrapeRunExecution> => {
        inputs.push(input);

        return new Promise<ScrapeRunExecution>((resolve, reject) => {
          resolveExecution = resolve;
          rejectExecution = reject;
        });
      },
    },
    inputs,
    settle: (execution) => {
      resolveExecution(execution);
    },
    fail: (error) => {
      rejectExecution(error);
    },
  };
};

/** A stand-in `ScrapeRunPlatformResult` store with its rows and its recorded writes. */
interface ResultStoreFixture {
  readonly store: PlatformResultStore;
  readonly rows: Map<string, ScrapeRunPlatformResult>;
  rowOf(runId: string, platform: Platform): ScrapeRunPlatformResult | undefined;
}

/** The compound unique input of `@@unique([runId, platform])`. */
interface ResultKeyWhere {
  readonly runId_platform: { readonly runId: string; readonly platform: Platform };
}

const createResultStore = (events: string[]): ResultStoreFixture => {
  const rows = new Map<string, ScrapeRunPlatformResult>();
  const keyOf = (runId: string, platform: Platform): string => `${runId}:${platform}`;

  const store: PlatformResultStore = {
    scrapeRunPlatformResult: {
      upsert: ({
        where,
        create,
        update,
      }: {
        where: ResultKeyWhere;
        create: Partial<ScrapeRunPlatformResult>;
        update: Partial<ScrapeRunPlatformResult>;
      }) => {
        const { runId, platform } = where.runId_platform;
        const key = keyOf(runId, platform);
        const existing = rows.get(key);

        events.push(`result:${platform}`);

        const row = {
          id: existing?.id ?? `result-${String(rows.size + 1)}`,
          runId,
          platform,
          pagesFetched: 0,
          newPostings: 0,
          updatedPostings: 0,
          partialResult: false,
          missingMandatoryFields: [],
          effectiveProfile: null,
          ...(existing ?? {}),
          ...(existing === undefined ? create : update),
        } as ScrapeRunPlatformResult;

        rows.set(key, row);

        return Promise.resolve(row);
      },
      // The delegate carries far more methods than the service calls; only `upsert` is modelled.
    } as unknown as PlatformResultStore['scrapeRunPlatformResult'],
  };

  return { store, rows, rowOf: (runId, platform) => rows.get(keyOf(runId, platform)) };
};

/**
 * A stand-in commute enrichment stage that only records that it ran (8.1).
 *
 * Its own behaviour is `src/commute/__tests__/commute-persistence.test.ts`; what this suite is
 * about is that it runs between the per-Platform rows and the summary — which `events` makes
 * observable.
 */
const enrichment = (events: string[], outstanding = 0): CommuteEnrichmentPhase => ({
  enrichRun: () => {
    events.push('commute:enriched');

    return Promise.resolve({
      considered: 0,
      determined: 0,
      reused: 0,
      unknown: 0,
      outstanding,
    });
  },
});

/**
 * A stand-in relevance enrichment stage that only records that it ran (15.13).
 *
 * Its own behaviour is `src/relevance/__tests__/relevance-enrichment.service.test.ts`; what this
 * suite is about is that it runs between the commute stage and the summary.
 */
const relevanceEnrichment = (events: string[], outstanding = 0): RelevanceEnrichmentPhase => ({
  enrichRun: () => {
    events.push('relevance:enriched');

    return Promise.resolve({
      considered: 0,
      requested: 0,
      assessed: 0,
      notRelevant: 0,
      notAssessed: 0,
      skippedByBudget: 0,
      outstanding,
      deliveryFailures: 0,
    });
  },
});

/** Records every close of a Scrape_Run row in `events`, so the write order becomes assertable. */
const traced = (store: ScrapeRunStore, events: string[]): ScrapeRunStore => {
  const update = store.scrapeRun.update as unknown as (args: unknown) => Promise<unknown>;

  return {
    scrapeRun: {
      ...store.scrapeRun,
      update: (args: unknown) => {
        events.push('run:closed');

        return update(args);
      },
    } as unknown as ScrapeRunStore['scrapeRun'],
  };
};

interface Harness {
  readonly service: ScrapeRunService;
  readonly coordinator: ScrapeRunCoordinator;
  readonly runs: ScrapeRunStoreFixture;
  readonly log: LogRecorderFixture;
  readonly results: ResultStoreFixture;
  readonly retrieval: FakeRetrieval;
  /** The writes of the end of a run, in the order they happened. */
  readonly events: readonly string[];
}

/** What the two enrichment stages report as left over, for the `run.enrichmentDeadline` line. */
interface OutstandingEnrichment {
  readonly commute?: number;
  readonly relevance?: number;
}

const harness = (outstanding: OutstandingEnrichment = {}): Harness => {
  const events: string[] = [];
  const runs = createScrapeRunStore();
  const recorder = createLogRecorder();
  const results = createResultStore(events);
  const retrieval = createRetrieval();

  const log: LogRecorderFixture['log'] = {
    emit: (payload) => {
      events.push(`log:${payload.code}`);

      return recorder.log.emit(payload);
    },
    initialiseCounter: (runId) => recorder.log.initialiseCounter(runId),
    releaseRun: (runId) => {
      recorder.log.releaseRun(runId);
    },
  };

  const coordinator = new ScrapeRunCoordinator(traced(runs.store, events), log, {
    enrichmentGraceMinutes: ENRICHMENT_GRACE_MINUTES,
  });

  return {
    service: new ScrapeRunService(
      coordinator,
      retrieval.phase,
      log,
      results.store,
      enrichment(events, outstanding.commute),
      relevanceEnrichment(events, outstanding.relevance),
    ),
    coordinator,
    runs,
    log: recorder,
    results,
    retrieval,
    events,
  };
};

/** One Platform's result, defaulted to a Platform that completed without finding anything. */
const platformResult = (
  platform: Platform,
  overrides: Partial<PlatformRunResult> = {},
): PlatformRunResult => ({
  platform,
  platformStatus: 'COMPLETED',
  pagesFetched: 1,
  newPostings: 0,
  updatedPostings: 0,
  partialResult: false,
  missingMandatoryFields: [],
  discardedPostings: 0,
  failedWrites: 0,
  sweptPostings: 0,
  effectiveProfile: null,
  ...overrides,
});

const execution = (overrides: Partial<ScrapeRunExecution> = {}): ScrapeRunExecution => ({
  runOutcome: 'COMPLETED',
  platforms: [],
  retrievalEndedAt: new Date(),
  ...overrides,
});

/** Waits for the background task of a Scrape_Run to have written its summary. */
const awaitSummary = async (log: LogRecorderFixture): Promise<void> => {
  await vi.waitFor(() => {
    expect(log.withCode(RUN_SUMMARY_LOG_CODE)).toHaveLength(1);
  });
};

describe('startScrapeRun', () => {
  it('creates exactly one Scrape_Run and answers with its identifier (12.1)', async () => {
    const { service, coordinator, runs } = harness();

    const payload = await service.start();

    expect(payload.alreadyRunning).toBe(false);
    expect(payload.hintDe).toBeNull();
    expect(payload.runId).toBe(coordinator.currentRunId());
    expect(runs.rows.size).toBe(1);
  });

  it('hands the run identifier, its start time, its deadline and its signal to the retrieval', async () => {
    const { service, coordinator, retrieval } = harness();

    const payload = await service.start();
    const active = coordinator.activeScrapeRun();

    expect(retrieval.inputs).toHaveLength(1);
    expect(retrieval.inputs.at(0)?.runId).toBe(payload.runId);
    expect(retrieval.inputs.at(0)?.runStartedAt).toEqual(active?.startedAt);
    expect(retrieval.inputs.at(0)?.retrievalDeadline).toEqual(active?.retrievalDeadline);
    expect(retrieval.inputs.at(0)?.signal.aborted).toBe(false);
  });

  it('creates no second run and answers with the running identifier plus the hint (12.5)', async () => {
    const { service, runs, retrieval } = harness();

    const first = await service.start();
    const second = await service.start();

    expect(second.runId).toBe(first.runId);
    expect(second.alreadyRunning).toBe(true);
    expect(second.hintDe).toContain('Es läuft bereits ein Suchlauf.');
    expect(runs.rows.size).toBe(1);

    // The running retrieval is untouched: no second retrieval phase was started.
    expect(retrieval.inputs).toHaveLength(1);
  });

  it('creates no Scrape_Run and names the cause when the creation fails (12.13)', async () => {
    const { service, runs, retrieval } = harness();

    runs.failNextWrite(Object.assign(new Error('connection refused'), { code: 'P1001' }));

    const payload = await service.start();

    expect(payload.runId).toBeNull();
    expect(payload.alreadyRunning).toBe(false);
    expect(payload.hintDe).toContain('Der Suchlauf konnte nicht gestartet werden');
    // The cause is named, but no technical string reaches the user.
    expect(payload.hintDe).toContain('Die Datenbank war nicht erreichbar.');
    expect(payload.hintDe).not.toContain('connection refused');
    expect(runs.rows.size).toBe(0);
    expect(retrieval.inputs).toHaveLength(0);
  });
});

describe('cancelScrapeRun', () => {
  it('cancels the running Scrape_Run and reports no rejection (12.7)', async () => {
    const { service, runs, retrieval, log } = harness();

    const started = await service.start();
    const runId = started.runId ?? '';
    const cancelling = service.cancel(runId);

    // The abort reaches the retrieval phase, which then settles with the cancelled outcome.
    await vi.waitFor(() => {
      expect(retrieval.inputs.at(0)?.signal.aborted).toBe(true);
    });
    retrieval.settle(execution({ runOutcome: 'CANCELLED_BY_USER' }));

    const payload = await cancelling;

    expect(payload).toEqual({
      runId,
      runOutcome: 'CANCELLED_BY_USER',
      rejectedReasonDe: null,
    });
    expect(runs.rowOf(runId)?.status).toBe('FINISHED');
    expect(runs.rowOf(runId)?.runOutcome).toBe('CANCELLED_BY_USER');
    expect(runs.rowOf(runId)?.finishedAt).toBeInstanceOf(Date);

    // 12.10 also holds for a cancelled run: the summary follows the cancellation line.
    await awaitSummary(log);
    expect(log.withCode(RUN_SUMMARY_LOG_CODE).at(0)?.messageDe).toContain('Suchlauf abgebrochen.');
  });

  it('rejects the cancellation and returns the stored Run_Outcome (12.14)', async () => {
    const { service, runs } = harness();

    const finished = runs.seed({
      status: 'FINISHED',
      runOutcome: 'COMPLETED',
      finishedAt: new Date(),
    });

    const payload = await service.cancel(finished.id);

    expect(payload.runOutcome).toBe('COMPLETED');
    expect(payload.rejectedReasonDe).toContain('Dieser Suchlauf läuft nicht mehr');
    expect(payload.rejectedReasonDe).toContain('abgeschlossen');
  });

  it('reports an identifier the Posting_Store does not know (12.14)', async () => {
    const { service } = harness();

    const payload = await service.cancel('run-that-never-existed');

    expect(payload.runId).toBe('run-that-never-existed');
    expect(payload.runOutcome).toBeNull();
    expect(payload.rejectedReasonDe).toContain('Dieser Suchlauf ist nicht gespeichert.');
  });

  it('reports a run left in status "running" by a crashed process (12.14)', async () => {
    const { service, runs } = harness();

    const stale = runs.seed({ status: 'RUNNING' });

    const payload = await service.cancel(stale.id);

    expect(payload.runOutcome).toBeNull();
    expect(payload.rejectedReasonDe).toContain('Suchlauf durch Neustart beendet.');
  });
});

describe('the end of a Scrape_Run', () => {
  it('writes the summary with the Run_Outcome, the runtime and the per-Platform counts (12.10)', async () => {
    const { service, log, retrieval } = harness();

    await service.start();
    retrieval.settle(
      execution({
        platforms: [
          platformResult('STEPSTONE', { newPostings: 12, updatedPostings: 3 }),
          platformResult('INDEED', { newPostings: 0, updatedPostings: 0 }),
        ],
      }),
    );

    await awaitSummary(log);

    const summary = log.withCode(RUN_SUMMARY_LOG_CODE).at(0);

    expect(summary?.level).toBe('INFO');
    expect(summary?.messageDe).toContain('Suchlauf abgeschlossen.');
    expect(summary?.messageDe).toContain('Laufzeit: 0 Min. 0 Sek.');
    expect(summary?.messageDe).toContain(
      `${PLATFORM_LABELS_DE.STEPSTONE}: ${PLATFORM_STATUS_LABELS_DE.COMPLETED}, 15 Treffer übernommen.`,
    );
    expect(summary?.messageDe).toContain('Davon 12 neu und 3 aktualisiert.');
    // A Platform that found nothing keeps its status line and drops the empty new/updated clause.
    expect(summary?.messageDe).toContain(
      `${PLATFORM_LABELS_DE.INDEED}: ${PLATFORM_STATUS_LABELS_DE.COMPLETED}, 0 Treffer übernommen.`,
    );
    expect(summary?.messageDe).not.toContain('Davon 0 neu');
    // Every Platform completed, so 7.4's hint is absent.
    expect(summary?.messageDe).not.toContain(RESULT_INCOMPLETE_HINT_DE);
  });

  it('names the incomplete result list and the rejected writes (7.4, 9.9)', async () => {
    const { service, log, retrieval } = harness();

    await service.start();
    retrieval.settle(
      execution({
        platforms: [
          platformResult('STEPSTONE', { newPostings: 4, failedWrites: 2 }),
          platformResult('INDEED', { platformStatus: 'SIGN_IN_REQUIRED', partialResult: true }),
        ],
      }),
    );

    await awaitSummary(log);

    const summary = log.withCode(RUN_SUMMARY_LOG_CODE).at(0);

    expect(summary?.messageDe).toContain(
      `${PLATFORM_LABELS_DE.INDEED}: ${PLATFORM_STATUS_LABELS_DE.SIGN_IN_REQUIRED}`,
    );
    expect(summary?.messageDe).toContain(RESULT_INCOMPLETE_HINT_DE);
    expect(summary?.messageDe).toContain('2 Treffer konnten nicht gespeichert werden.');
  });

  it('persists one result row per requested Platform without duplicating the retrieval row (7.4)', async () => {
    const { service, log, results, retrieval } = harness();

    const started = await service.start();
    const runId = started.runId ?? '';

    // The Scraper_Service has already written the row of 3.8 for one Platform in this run.
    await results.store.scrapeRunPlatformResult.upsert({
      where: { runId_platform: { runId, platform: 'STEPSTONE' } },
      create: { runId, platform: 'STEPSTONE', platformStatus: 'NOT_YET_RUN' },
      update: { platformStatus: 'NOT_YET_RUN' },
    });

    retrieval.settle(
      execution({
        platforms: [
          platformResult('STEPSTONE', { newPostings: 7, updatedPostings: 1, pagesFetched: 3 }),
          platformResult('INDEED', { platformStatus: 'DISABLED', pagesFetched: 0 }),
        ],
      }),
    );

    await awaitSummary(log);

    expect(results.rows.size).toBe(2);
    expect(results.rowOf(runId, 'STEPSTONE')).toMatchObject({
      platformStatus: 'COMPLETED',
      pagesFetched: 3,
      newPostings: 7,
      updatedPostings: 1,
    });
    expect(results.rowOf(runId, 'INDEED')?.platformStatus).toBe('DISABLED');
  });

  it('writes the result rows and the summary before the run is closed (12.10)', async () => {
    const { service, log, retrieval, events } = harness();

    await service.start();
    retrieval.settle(execution({ platforms: [platformResult('STEPSTONE')] }));

    await awaitSummary(log);
    await vi.waitFor(() => {
      expect(events).toContain('run:closed');
    });

    expect(events.indexOf('result:STEPSTONE')).toBeLessThan(
      events.indexOf(`log:${RUN_SUMMARY_LOG_CODE}`),
    );
    expect(events.indexOf(`log:${RUN_SUMMARY_LOG_CODE}`)).toBeLessThan(
      events.lastIndexOf('run:closed'),
    );
  });

  it('runs both enrichment stages after the retrieval and before the summary (8.1, 15.13)', async () => {
    const { service, log, retrieval, events } = harness();

    await service.start();
    retrieval.settle(execution({ platforms: [platformResult('STEPSTONE')] }));

    await awaitSummary(log);

    expect(events).toContain('commute:enriched');
    expect(events).toContain('relevance:enriched');
    expect(events.indexOf('commute:enriched')).toBeLessThan(events.indexOf('relevance:enriched'));
    expect(events.indexOf('relevance:enriched')).toBeLessThan(
      events.indexOf(`log:${RUN_SUMMARY_LOG_CODE}`),
    );
  });

  it('reports what both enrichment stages did not get to, in one line', async () => {
    const { service, log, retrieval, events } = harness({ commute: 3, relevance: 7 });

    await service.start();
    retrieval.settle(execution({ platforms: [platformResult('STEPSTONE')] }));

    await awaitSummary(log);

    const line = log.messages.find((message) => message.code === 'run.enrichmentDeadline');

    // One line for both stages, because neither of them knows the other's count, and before the
    // summary, which 12.10 makes the last message of a run.
    expect(line?.detail).toStrictEqual({ commuteOutstanding: 3, relevanceOutstanding: 7 });
    expect(line?.messageDe).toContain('3 ohne Erreichbarkeit');
    expect(line?.messageDe).toContain('7 ohne Bewertung');
    expect(events.indexOf('log:run.enrichmentDeadline')).toBeLessThan(
      events.indexOf(`log:${RUN_SUMMARY_LOG_CODE}`),
    );
  });

  it('writes no enrichment deadline line when both stages finished their work', async () => {
    const { service, log, retrieval } = harness();

    await service.start();
    retrieval.settle(execution({ platforms: [platformResult('STEPSTONE')] }));

    await awaitSummary(log);

    // The German sentence promises a repetition in the next Scrape_Run, which would not happen.
    expect(log.messages.map((message) => message.code)).not.toContain('run.enrichmentDeadline');
  });

  it('closes the run with its Run_Outcome and an end time (12.10)', async () => {
    const { service, runs, log, retrieval, coordinator } = harness();

    const started = await service.start();
    const runId = started.runId ?? '';

    retrieval.settle(
      execution({
        runOutcome: 'CANCELLED_BY_TIME_LIMIT',
        platforms: [platformResult('STEPSTONE', { platformStatus: 'CANCELLED_BY_TIME_LIMIT' })],
      }),
    );

    await awaitSummary(log);
    await vi.waitFor(() => {
      expect(coordinator.currentRunId()).toBeNull();
    });

    expect(runs.rowOf(runId)?.status).toBe('FINISHED');
    expect(runs.rowOf(runId)?.runOutcome).toBe('CANCELLED_BY_TIME_LIMIT');
    expect(runs.rowOf(runId)?.finishedAt).toBeInstanceOf(Date);
  });

  it('closes a run whose retrieval phase could not be carried out at all', async () => {
    const { service, runs, log, retrieval, coordinator } = harness();

    const started = await service.start();
    const runId = started.runId ?? '';

    retrieval.fail(new Error('no browser could be launched'));

    await vi.waitFor(() => {
      expect(coordinator.currentRunId()).toBeNull();
    });

    // No summary: there is no per-Platform result to report, and the run must not stay open.
    expect(log.withCode(RUN_SUMMARY_LOG_CODE)).toHaveLength(0);
    expect(runs.rowOf(runId)?.status).toBe('FINISHED');
    expect(runs.rowOf(runId)?.runOutcome).toBe('CANCELLED_BY_TIME_LIMIT');
  });
});

describe('runtimeLabelDe', () => {
  it('reports minutes and seconds, both of them always (12.10)', () => {
    expect(runtimeLabelDe(0)).toBe('0 Min. 0 Sek.');
    expect(runtimeLabelDe(7_400)).toBe('0 Min. 7 Sek.');
    expect(runtimeLabelDe(247_000)).toBe('4 Min. 7 Sek.');
    expect(runtimeLabelDe(30 * 60 * 1000)).toBe('30 Min. 0 Sek.');
  });

  it('reports a runtime that cannot be measured as zero', () => {
    expect(runtimeLabelDe(-1)).toBe('0 Min. 0 Sek.');
    expect(runtimeLabelDe(Number.NaN)).toBe('0 Min. 0 Sek.');
  });
});
