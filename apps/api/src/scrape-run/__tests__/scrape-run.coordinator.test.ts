/**
 * The lifecycle of the one Scrape_Run the Job_Tool runs at a time.
 *
 * The subject is what the requirements pin down about `start()` and `cancel()`: exactly one running
 * Scrape_Run with a start time and the status "running" (12.1), no second run while one is running
 * plus the already-running hint (12.5), a cancellation that ends the running retrievals and stores
 * the Run_Outcome "cancelled by user" with an end time (12.7), a rejected cancellation for a run
 * that is not running together with its stored Run_Outcome (12.14), no Scrape_Run at all when the
 * creation fails (12.13), and the two deadlines the run is bounded by (13.6).
 *
 * The real lifecycle logic runs; only the `ScrapeRun` delegate and the Log_Stream are stand-ins.
 * The full suite for the coordinator and the Scraper_Service together, including the stale-run
 * recovery and the retrieval deadline, belongs to task 12.9.
 *
 * Requirements: 12.1, 12.5, 12.7, 12.13, 12.14, 13.6.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RUN_OUTCOME_LABELS_DE } from '../../common/error-mapping';
import {
  CANCELLATION_SETTLE_MS,
  enrichmentGraceDeadlineOf,
  RETRIEVAL_LIMIT_MINUTES,
  retrievalDeadlineOf,
  ScrapeRunCancelledError,
  ScrapeRunCoordinator,
} from '../scrape-run.coordinator';
import { runUnknownMessageDe } from '../scrape-run.messages';
import {
  createLogRecorder,
  createScrapeRunStore,
  type LogRecorderFixture,
  type ScrapeRunStoreFixture,
} from './scrape-run.fixture';

const ENRICHMENT_GRACE_MINUTES = 10;

interface Harness {
  readonly coordinator: ScrapeRunCoordinator;
  readonly store: ScrapeRunStoreFixture;
  readonly log: LogRecorderFixture;
}

const harness = (): Harness => {
  const store = createScrapeRunStore();
  const log = createLogRecorder();

  return {
    coordinator: new ScrapeRunCoordinator(store.store, log.log, {
      enrichmentGraceMinutes: ENRICHMENT_GRACE_MINUTES,
    }),
    store,
    log,
  };
};

/** A deferred, so a test can decide when the retrieval phase settles. */
const deferred = () => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('starting a Scrape_Run', () => {
  it('creates exactly one run with a start time and the status "running" (12.1)', async () => {
    const { coordinator, store, log } = harness();

    const started = await coordinator.start();

    expect(started.alreadyRunning).toBe(false);
    expect(coordinator.currentRunId()).toBe(started.runId);

    const row = store.rowOf(started.runId);

    expect(row?.status).toBe('RUNNING');
    expect(row?.startedAt).toBeInstanceOf(Date);
    expect(row?.finishedAt).toBeNull();
    expect(row?.runOutcome).toBeNull();
    expect(store.writes).toEqual([{ kind: 'create', id: started.runId }]);

    // The Log_View of 12.2 opens on this run, so its first line belongs to the run itself.
    expect(log.initialised).toEqual([started.runId]);
    expect(log.withCode('run.started')).toHaveLength(1);
    expect(log.messages.at(0)?.messageDe).toContain('Suchlauf gestartet');
  });

  it('creates no second run and returns the running identifier plus the hint (12.5)', async () => {
    const { coordinator, store, log } = harness();

    const first = await coordinator.start();
    const second = await coordinator.start();

    expect(second).toEqual({ runId: first.runId, alreadyRunning: true });
    expect(store.rows.size).toBe(1);

    const hint = log.withCode('run.alreadyRunning').at(0);

    expect(hint?.runId).toBe(first.runId);
    expect(hint?.messageDe).toContain('Es läuft bereits ein Suchlauf.');
  });

  it('creates no second run when two starts arrive in the same tick (12.1, 12.5)', async () => {
    const { coordinator, store } = harness();

    const [first, second, third] = await Promise.all([
      coordinator.start(),
      coordinator.start(),
      coordinator.start(),
    ]);

    expect(store.rows.size).toBe(1);
    expect(first.runId).toBe(second.runId);
    expect(first.runId).toBe(third.runId);
    expect([first, second, third].filter((result) => !result.alreadyRunning)).toHaveLength(1);
  });

  it('creates no Scrape_Run when the Posting_Store refuses the insert (12.13)', async () => {
    const { coordinator, store } = harness();
    const failure = new Error('Posting_Store refused the insert');

    store.failNextWrite(failure);

    await expect(coordinator.start()).rejects.toBe(failure);
    expect(store.rows.size).toBe(0);
    expect(coordinator.currentRunId()).toBeNull();

    // The failed start must not take the lock with it: the next attempt has to be able to run.
    const retried = await coordinator.start();

    expect(retried.alreadyRunning).toBe(false);
    expect(store.rows.size).toBe(1);
  });

  it('starts the run even when the Log_Stream refuses its first message', async () => {
    const { coordinator, store, log } = harness();

    log.failNextInitialise(new Error('counter lookup failed'));
    log.failNextEmit(new Error('message write failed'));

    const started = await coordinator.start();

    // The run exists, so reporting "could not be started" would be a lie (12.13 is about the run,
    // not about its log).
    expect(coordinator.currentRunId()).toBe(started.runId);
    expect(store.rowOf(started.runId)?.status).toBe('RUNNING');
    expect(log.messages).toHaveLength(0);
  });

  it('starts a new run once the previous one is closed', async () => {
    const { coordinator, store } = harness();

    const first = await coordinator.start();

    await coordinator.finish(first.runId, 'COMPLETED');

    const second = await coordinator.start();

    expect(second.alreadyRunning).toBe(false);
    expect(second.runId).not.toBe(first.runId);
    expect(store.rows.size).toBe(2);
  });
});

describe('the deadlines of a Scrape_Run', () => {
  it('derives the retrieval deadline as the start time plus 30 minutes (13.6)', async () => {
    const { coordinator, store } = harness();

    const started = await coordinator.start();
    const startedAt = store.rowOf(started.runId)?.startedAt;
    const active = coordinator.activeScrapeRun();

    expect(RETRIEVAL_LIMIT_MINUTES).toBe(30);
    expect(startedAt).toBeInstanceOf(Date);
    expect(active?.startedAt).toEqual(startedAt);
    expect(active?.retrievalDeadline.getTime()).toBe(
      (startedAt?.getTime() ?? 0) + RETRIEVAL_LIMIT_MINUTES * 60_000,
    );
    expect(active?.retrievalDeadline).toEqual(retrievalDeadlineOf(startedAt ?? new Date(0)));
  });

  it('derives the enrichment grace deadline from the actual end of the retrieval', async () => {
    const { coordinator } = harness();

    const started = await coordinator.start();

    expect(coordinator.activeScrapeRun()?.retrievalEndedAt).toBeNull();
    expect(coordinator.activeScrapeRun()?.enrichmentGraceDeadline).toBeNull();

    const retrievalEnd = new Date('2026-03-02T08:07:00.000Z');
    const deadline = coordinator.noteRetrievalEnd(started.runId, retrievalEnd);

    expect(deadline).toEqual(enrichmentGraceDeadlineOf(retrievalEnd, ENRICHMENT_GRACE_MINUTES));
    expect(deadline?.getTime()).toBe(retrievalEnd.getTime() + ENRICHMENT_GRACE_MINUTES * 60_000);
    expect(coordinator.activeScrapeRun()?.enrichmentGraceDeadline).toEqual(deadline);
    expect(coordinator.activeScrapeRun()?.retrievalEndedAt).toEqual(retrievalEnd);

    // A second reporter cannot extend the grace period.
    expect(
      coordinator.noteRetrievalEnd(started.runId, new Date('2026-03-02T08:20:00.000Z')),
    ).toEqual(deadline);
  });

  it('reports no grace deadline for a run that is not the active one', async () => {
    const { coordinator } = harness();

    expect(coordinator.noteRetrievalEnd('run-unknown')).toBeNull();

    const started = await coordinator.start();

    expect(coordinator.noteRetrievalEnd('run-other')).toBeNull();
    expect(coordinator.activeScrapeRun()?.runId).toBe(started.runId);
  });
});

describe('cancelling a running Scrape_Run (12.7)', () => {
  it('aborts the retrieval, stores the Run_Outcome and writes the German line', async () => {
    const { coordinator, store, log } = harness();

    const started = await coordinator.start();
    const signal = coordinator.activeScrapeRun()?.signal;

    const result = await coordinator.cancel(started.runId);

    expect(result).toEqual({
      runId: started.runId,
      cancelled: true,
      runOutcome: 'CANCELLED_BY_USER',
      rejection: null,
    });

    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBeInstanceOf(ScrapeRunCancelledError);
    expect((signal?.reason as ScrapeRunCancelledError).runOutcome).toBe('CANCELLED_BY_USER');

    const row = store.rowOf(started.runId);

    expect(row?.status).toBe('FINISHED');
    expect(row?.runOutcome).toBe('CANCELLED_BY_USER');
    expect(row?.finishedAt).toBeInstanceOf(Date);
    expect(row?.closedByRecovery).toBe(false);

    expect(coordinator.currentRunId()).toBeNull();
    expect(log.withCode('run.cancelledByUser').at(0)?.messageDe).toContain('Suchlauf abgebrochen.');
    expect(log.released).toEqual([started.runId]);
  });

  it('closes the run only after the running retrievals have ended', async () => {
    const { coordinator, store } = harness();

    const started = await coordinator.start();
    const retrieval = deferred();

    coordinator.registerRetrieval(started.runId, retrieval.promise);

    const cancelling = coordinator.cancel(started.runId);

    // The abort is delivered immediately, so no further Platform request is sent; the end time is
    // written once the retrieval acknowledged it.
    await Promise.resolve();
    expect(coordinator.activeScrapeRun()?.signal.aborted).toBe(true);
    expect(store.rowOf(started.runId)?.status).toBe('RUNNING');

    retrieval.resolve();

    await expect(cancelling).resolves.toMatchObject({ cancelled: true });
    expect(store.rowOf(started.runId)?.status).toBe('FINISHED');
  });

  it('closes the run after at most 10 seconds when the retrieval does not acknowledge', async () => {
    vi.useFakeTimers();

    const { coordinator, store } = harness();

    const started = await coordinator.start();

    // A retrieval that never settles: a Platform that ignores the abort must not keep the Job_Tool
    // from starting the next Scrape_Run.
    coordinator.registerRetrieval(started.runId, new Promise<void>(() => {}));

    const cancelling = coordinator.cancel(started.runId);

    await vi.advanceTimersByTimeAsync(CANCELLATION_SETTLE_MS - 1);
    expect(store.rowOf(started.runId)?.status).toBe('RUNNING');

    await vi.advanceTimersByTimeAsync(1);
    await expect(cancelling).resolves.toMatchObject({ cancelled: true });

    expect(CANCELLATION_SETTLE_MS).toBe(10_000);
    expect(store.rowOf(started.runId)?.status).toBe('FINISHED');
    expect(coordinator.currentRunId()).toBeNull();
  });

  it('consumes a rejected retrieval: the abort reason is the expected rejection', async () => {
    const { coordinator, store } = harness();

    const started = await coordinator.start();
    const signal = coordinator.activeScrapeRun()?.signal;
    const retrieval = new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(signal?.reason), 0);
    });

    coordinator.registerRetrieval(started.runId, retrieval);

    await expect(coordinator.cancel(started.runId)).resolves.toMatchObject({ cancelled: true });
    expect(store.rowOf(started.runId)?.runOutcome).toBe('CANCELLED_BY_USER');
  });

  it('closes the run once when a second cancellation arrives while it is closing', async () => {
    const { coordinator, store } = harness();

    const started = await coordinator.start();
    const retrieval = deferred();

    coordinator.registerRetrieval(started.runId, retrieval.promise);

    const first = coordinator.cancel(started.runId);
    const second = coordinator.cancel(started.runId);

    retrieval.resolve();

    // The second press of "Suchlauf abbrechen" joins the close in flight instead of writing an end
    // time twice.
    await expect(first).resolves.toEqual(await second);
    await expect(second).resolves.toMatchObject({ cancelled: true });
    expect(store.writes.filter((write) => write.kind === 'update')).toHaveLength(1);
  });

  it('reports the stored cancellation for a cancellation that arrives after the close (12.14)', async () => {
    const { coordinator, store, log } = harness();

    const started = await coordinator.start();

    await coordinator.cancel(started.runId);

    const again = await coordinator.cancel(started.runId);

    expect(again).toEqual({
      runId: started.runId,
      cancelled: false,
      runOutcome: 'CANCELLED_BY_USER',
      rejection: 'NOT_RUNNING',
    });
    expect(store.writes.filter((write) => write.kind === 'update')).toHaveLength(1);
    expect(log.withCode('run.cancelRejected').at(0)?.messageDe).toContain(
      RUN_OUTCOME_LABELS_DE.CANCELLED_BY_USER,
    );
  });
});

describe('cancelling a Scrape_Run that is not running (12.14)', () => {
  it('rejects the cancellation and returns the stored Run_Outcome', async () => {
    const { coordinator, store, log } = harness();

    const stored = store.seed({
      status: 'FINISHED',
      startedAt: new Date('2026-03-02T08:00:00.000Z'),
      finishedAt: new Date('2026-03-02T08:12:00.000Z'),
      runOutcome: 'COMPLETED',
    });

    const result = await coordinator.cancel(stored.id);

    expect(result).toEqual({
      runId: stored.id,
      cancelled: false,
      runOutcome: 'COMPLETED',
      rejection: 'NOT_RUNNING',
    });

    // Nothing about the stored run changed.
    expect(store.rowOf(stored.id)).toEqual(stored);
    expect(store.writes).toHaveLength(0);

    const rejected = log.withCode('run.cancelRejected').at(0);

    expect(rejected?.messageDe).toContain(RUN_OUTCOME_LABELS_DE.COMPLETED);
    expect(rejected?.detail).toEqual({ runId: stored.id, runOutcome: 'COMPLETED' });
  });

  it('rejects a cancellation for a run the Posting_Store does not know', async () => {
    const { coordinator, log } = harness();

    const result = await coordinator.cancel('run-that-was-never-stored');

    expect(result).toEqual({
      runId: 'run-that-was-never-stored',
      cancelled: false,
      runOutcome: null,
      rejection: 'UNKNOWN_RUN',
    });

    // A Log_Stream message belongs to a stored Scrape_Run; the hint for this case is the mutation's.
    expect(log.messages).toHaveLength(0);
    expect(runUnknownMessageDe()).toContain('nicht gespeichert');
  });

  it('rejects a cancellation for a run that is stored as running but not executed here', async () => {
    const { coordinator, store, log } = harness();

    // What a crash leaves behind, until the stale-run recovery of task 12.2 closes it.
    const stale = store.seed({
      status: 'RUNNING',
      startedAt: new Date('2026-03-02T08:00:00.000Z'),
    });
    const running = await coordinator.start();

    const result = await coordinator.cancel(stale.id);

    expect(result).toEqual({
      runId: stale.id,
      cancelled: false,
      runOutcome: null,
      rejection: 'NOT_RUNNING',
    });

    // No result to report, so no rejection line either: the stale run gets its German line from
    // the recovery of task 12.2, not from a cancellation that could not reach it.
    expect(log.withCode('run.cancelRejected')).toHaveLength(0);

    // The running Scrape_Run is untouched by a cancellation aimed at another identifier.
    expect(coordinator.currentRunId()).toBe(running.runId);
    expect(coordinator.activeScrapeRun()?.signal.aborted).toBe(false);
  });
});

describe('finishing a Scrape_Run', () => {
  it('stores the Run_Outcome with an end time and releases the run', async () => {
    const { coordinator, store, log } = harness();

    const started = await coordinator.start();
    const finished = await coordinator.finish(started.runId, 'COMPLETED');

    expect(finished.status).toBe('CLOSED');
    expect(finished.status === 'CLOSED' ? finished.run.runOutcome : null).toBe('COMPLETED');

    const row = store.rowOf(started.runId);

    expect(row?.status).toBe('FINISHED');
    expect(row?.runOutcome).toBe('COMPLETED');
    expect(row?.finishedAt).toBeInstanceOf(Date);
    expect(coordinator.currentRunId()).toBeNull();
    expect(log.released).toEqual([started.runId]);

    // The cancellation line belongs to a cancellation only.
    expect(log.withCode('run.cancelledByUser')).toHaveLength(0);
  });

  it('stores the retrieval time limit as the Run_Outcome when it ended the run (13.6)', async () => {
    const { coordinator, store } = harness();

    const started = await coordinator.start();

    await coordinator.finish(started.runId, 'CANCELLED_BY_TIME_LIMIT');

    expect(store.rowOf(started.runId)?.runOutcome).toBe('CANCELLED_BY_TIME_LIMIT');
  });

  it('reports a run that is not the active one instead of closing anything', async () => {
    const { coordinator, store } = harness();

    const stored = store.seed({ status: 'FINISHED', runOutcome: 'COMPLETED' });

    await expect(coordinator.finish(stored.id, 'COMPLETED')).resolves.toEqual({
      status: 'NOT_ACTIVE',
    });
    expect(store.writes).toHaveLength(0);
  });

  it('yields to a cancellation that is already closing the run without waiting for it', async () => {
    const { coordinator, store } = harness();

    const started = await coordinator.start();
    const retrieval = deferred();

    coordinator.registerRetrieval(started.runId, retrieval.promise);

    const cancelling = coordinator.cancel(started.runId);

    // The retrieval phase is still settling, which is what the cancellation waits for. Its caller
    // may reach `finish` first, and that call must return rather than wait for itself.
    await expect(coordinator.finish(started.runId, 'COMPLETED')).resolves.toEqual({
      status: 'ALREADY_CLOSING',
    });

    retrieval.resolve();
    await expect(cancelling).resolves.toMatchObject({ cancelled: true });

    // The cancellation owns the Run_Outcome of a run it is closing.
    expect(store.rowOf(started.runId)?.runOutcome).toBe('CANCELLED_BY_USER');
  });

  it('reports a rejected end write and leaves the run closable by the recovery', async () => {
    const { coordinator, store } = harness();

    const started = await coordinator.start();
    const failure = new Error('Posting_Store refused the update');

    store.failNextWrite(failure);

    await expect(coordinator.finish(started.runId, 'COMPLETED')).rejects.toBe(failure);

    // The row stays marked "running" — task 12.2 closes it at the next start — but the process no
    // longer holds a run it could neither finish nor restart.
    expect(store.rowOf(started.runId)?.status).toBe('RUNNING');
    expect(coordinator.currentRunId()).toBeNull();
    await expect(coordinator.start()).resolves.toMatchObject({ alreadyRunning: false });
  });
});
