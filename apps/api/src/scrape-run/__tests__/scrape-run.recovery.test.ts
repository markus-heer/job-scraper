/**
 * The stale-run recovery at bootstrap (9.7, 11.7, 12.1).
 *
 * The subject is the requirements gap the design records: a process that goes away while a
 * Scrape_Run is running leaves a row marked "running" that nobody executes. The recovery closes
 * every such row with an end time, the Run_Outcome `CANCELLED_BY_TIME_LIMIT` and
 * `closedByRecovery = true`, writes one German line per recovered run to the Log_Stream, and
 * touches nothing else — no Posting_Status sweep (9.7), no marking "neu" (11.7).
 *
 * The real recovery logic runs; only the `ScrapeRun` delegate and the Log_Stream are stand-ins.
 *
 * Requirements: 9.7, 11.7, 12.1.
 */

import { describe, expect, it } from 'vitest';

import { ScrapeRunCoordinator } from '../scrape-run.coordinator';
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

describe('recovering a Scrape_Run left in status "running"', () => {
  it('closes it with an end time, the time-limit outcome and the recovery flag', async () => {
    const { coordinator, store } = harness();

    const stale = store.seed({
      status: 'RUNNING',
      startedAt: new Date('2026-03-02T08:00:00.000Z'),
    });

    const recovered = await coordinator.recoverStaleRuns();

    expect(recovered).toHaveLength(1);
    expect(recovered.at(0)?.runId).toBe(stale.id);
    expect(recovered.at(0)?.runOutcome).toBe('CANCELLED_BY_TIME_LIMIT');

    const row = store.rowOf(stale.id);

    expect(row?.status).toBe('FINISHED');
    expect(row?.runOutcome).toBe('CANCELLED_BY_TIME_LIMIT');
    expect(row?.closedByRecovery).toBe(true);
    expect(row?.finishedAt).toBeInstanceOf(Date);

    // The start time of the crashed run is history, not something the recovery may rewrite.
    expect(row?.startedAt).toEqual(stale.startedAt);
  });

  it('reports the recovery to the Log_Stream of that run', async () => {
    const { coordinator, store, log } = harness();

    const stale = store.seed({ status: 'RUNNING' });

    await coordinator.recoverStaleRuns();

    const line = log.withCode('run.recoveredStale').at(0);

    expect(line?.runId).toBe(stale.id);
    expect(line?.level).toBe('WARN');
    expect(line?.messageDe).toContain('Suchlauf durch Neustart beendet.');
    expect(line?.messageDe).toContain('bleiben erhalten');
    expect(line?.detail).toEqual({ runId: stale.id });

    // The crashed run already wrote messages, so its counter is adopted before the line is written
    // and dropped again afterwards: nothing more will be logged for a closed run.
    expect(log.initialised).toEqual([stale.id]);
    expect(log.released).toEqual([stale.id]);
  });

  it('closes every stale run, oldest first', async () => {
    const { coordinator, store } = harness();

    const younger = store.seed({
      status: 'RUNNING',
      startedAt: new Date('2026-03-02T09:00:00.000Z'),
    });
    const older = store.seed({
      status: 'RUNNING',
      startedAt: new Date('2026-03-02T07:00:00.000Z'),
    });

    const recovered = await coordinator.recoverStaleRuns();

    expect(recovered.map((run) => run.runId)).toEqual([older.id, younger.id]);
    expect(store.rowOf(older.id)?.closedByRecovery).toBe(true);
    expect(store.rowOf(younger.id)?.closedByRecovery).toBe(true);
  });

  it('leaves an already finished Scrape_Run untouched', async () => {
    const { coordinator, store, log } = harness();

    const finished = store.seed({
      status: 'FINISHED',
      startedAt: new Date('2026-03-02T08:00:00.000Z'),
      finishedAt: new Date('2026-03-02T08:11:00.000Z'),
      runOutcome: 'COMPLETED',
    });

    await expect(coordinator.recoverStaleRuns()).resolves.toEqual([]);

    expect(store.rowOf(finished.id)).toEqual(finished);
    expect(store.writes).toHaveLength(0);
    expect(log.messages).toHaveLength(0);
  });

  it('writes nothing when the Posting_Store holds no Scrape_Run at all', async () => {
    const { coordinator, store, log } = harness();

    await expect(coordinator.recoverStaleRuns()).resolves.toEqual([]);

    expect(store.writes).toHaveLength(0);
    expect(log.messages).toHaveLength(0);
  });

  it('runs the recovery at application bootstrap', async () => {
    const { coordinator, store } = harness();

    const stale = store.seed({ status: 'RUNNING' });

    await coordinator.onApplicationBootstrap();

    expect(store.rowOf(stale.id)?.status).toBe('FINISHED');
    expect(store.rowOf(stale.id)?.closedByRecovery).toBe(true);

    // The recovery closed the crashed run; it did not adopt it as the active one.
    expect(coordinator.currentRunId()).toBeNull();
  });

  it('closes the remaining stale runs when one update is rejected', async () => {
    const { coordinator, store } = harness();

    const first = store.seed({
      status: 'RUNNING',
      startedAt: new Date('2026-03-02T07:00:00.000Z'),
    });
    const second = store.seed({
      status: 'RUNNING',
      startedAt: new Date('2026-03-02T08:00:00.000Z'),
    });

    store.failNextWrite(new Error('Posting_Store refused the update'));

    // A cosmetic row left over from a crash must not keep the API_Service from starting.
    const recovered = await coordinator.recoverStaleRuns();

    expect(recovered.map((run) => run.runId)).toEqual([second.id]);
    expect(store.rowOf(first.id)?.status).toBe('RUNNING');
    expect(store.rowOf(first.id)?.closedByRecovery).toBe(false);
    expect(store.rowOf(second.id)?.status).toBe('FINISHED');
  });

  it('closes the run even when the Log_Stream refuses the recovery line', async () => {
    const { coordinator, store, log } = harness();

    const stale = store.seed({ status: 'RUNNING' });

    log.failNextInitialise(new Error('counter lookup failed'));
    log.failNextEmit(new Error('message write failed'));

    await expect(coordinator.recoverStaleRuns()).resolves.toHaveLength(1);

    expect(store.rowOf(stale.id)?.closedByRecovery).toBe(true);
    expect(log.messages).toHaveLength(0);
  });

  it('keeps the Scrape_Run this process is running', async () => {
    const { coordinator, store, log } = harness();

    const started = await coordinator.start();

    await expect(coordinator.recoverStaleRuns()).resolves.toEqual([]);

    // Closing the active run would take the Scrape_Run out from under its own retrieval.
    expect(coordinator.currentRunId()).toBe(started.runId);
    expect(store.rowOf(started.runId)?.status).toBe('RUNNING');
    expect(store.rowOf(started.runId)?.closedByRecovery).toBe(false);
    expect(coordinator.activeScrapeRun()?.signal.aborted).toBe(false);
    expect(log.withCode('run.recoveredStale')).toHaveLength(0);
    expect(log.released).toEqual([]);
  });

  it('lets a Scrape_Run be started after the recovery', async () => {
    const { coordinator, store } = harness();

    store.seed({ status: 'RUNNING', startedAt: new Date('2026-03-02T08:00:00.000Z') });

    await coordinator.onApplicationBootstrap();

    const started = await coordinator.start();

    expect(started.alreadyRunning).toBe(false);
    expect(store.rowOf(started.runId)?.status).toBe('RUNNING');
  });
});
