/**
 * Property 23 of the job-search-tool design: at most one Scrape_Run is ever running.
 *
 * The subject is the single-run guarantee of 12.1 and 12.5, and it is a statement about
 * *interleavings* rather than about a list of cases: whichever order concurrent start requests reach
 * the coordinator in, exactly one Scrape_Run may come out of them. The in-process mutex is what has
 * to hold it — the check "is a run active?" and the insert sit in one critical section, so two
 * mutations arriving in the same tick cannot both observe `null`.
 *
 * The oracle is the store, not an assertion about the coordinator's internals: the stand-in records
 * every write, so a second `create` is a visible fact. `count(ScrapeRun where status = RUNNING)`
 * after settling, the size of the returned identifier set and the number of responses with
 * `alreadyRunning === false` are the three numbers the design names, and all three must be 1.
 *
 * Fully offline and without waiting. The generated micro-delay is a number of microtask yields, so
 * the starts arrive at different points of the event loop without a timer; nothing is cancelled
 * here, so the 10-second cancellation budget is never entered.
 *
 * Requirements: 12.1, 12.5.
 */

// Feature: job-search-tool, Property 23 - At most one Scrape_Run is ever running

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ScrapeRun } from '../../prisma/prisma.types';
import { ScrapeRunCoordinator, type StartScrapeRunResult } from '../scrape-run.coordinator';
import { createLogRecorder, createScrapeRunStore } from './scrape-run.fixture';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

const ENRICHMENT_GRACE_MINUTES = 10;

/**
 * The concurrent start calls of one scenario, each with its micro-delay.
 *
 * The array length is the generated call count of 2 to 20; each element is how many microtask yields
 * that caller waits before it calls `start()`. Zero means "in the same tick as the others", which is
 * the interleaving the mutex exists for; a larger value lets a caller arrive while an earlier start
 * is between its `await` points.
 */
const startPlanArbitrary = fc.array(fc.nat({ max: 4 }), { minLength: 2, maxLength: 20 });

/** Yields to the microtask queue `count` times. */
const microDelay = async (count: number): Promise<void> => {
  for (let yielded = 0; yielded < count; yielded += 1) {
    await Promise.resolve();
  }
};

/** The rows the Posting_Store holds with the status "running". */
const runningRows = (rows: ReadonlyMap<string, ScrapeRun>): readonly ScrapeRun[] =>
  [...rows.values()].filter((row) => row.status === 'RUNNING');

describe('Property 23: At most one Scrape_Run is ever running', () => {
  /**
   * **Validates: Requirements 12.1, 12.5**
   *
   * For all interleavings of 2 to 20 concurrent start requests, at most one Scrape_Run carries the
   * status "running" at any time: after settling exactly one row is "running", the set of returned
   * identifiers has size 1, exactly one response reports `alreadyRunning === false`, and the store
   * received exactly one write. Every other caller receives the identifier of that one run together
   * with the hint that a Scrape_Run is already running, and nothing about the running run is
   * changed.
   *
   * The "at any time" half is observed rather than argued: each caller reads the number of running
   * rows in the moment its own `start()` resolved, and none of those readings may exceed 1.
   */
  it('creates exactly one Scrape_Run and reports the running one to every other caller', async () => {
    await fc.assert(
      fc.asyncProperty(startPlanArbitrary, async (delays) => {
        const store = createScrapeRunStore();
        const log = createLogRecorder();
        const coordinator = new ScrapeRunCoordinator(store.store, log.log, {
          enrichmentGraceMinutes: ENRICHMENT_GRACE_MINUTES,
        });

        /** How many rows were "running" the moment each start resolved. */
        const observedWhileSettling: number[] = [];

        const results: readonly StartScrapeRunResult[] = await Promise.all(
          delays.map(async (delay): Promise<StartScrapeRunResult> => {
            await microDelay(delay);

            const started = await coordinator.start();

            observedWhileSettling.push(runningRows(store.rows).length);

            return started;
          }),
        );

        const running = runningRows(store.rows);

        // The three numbers the design's oracle names.
        expect(running).toHaveLength(1);
        expect(new Set(results.map((result) => result.runId)).size).toBe(1);
        expect(results.filter((result) => !result.alreadyRunning)).toHaveLength(1);

        // No second Scrape_Run record, and the running one was not touched again (12.5).
        expect(store.writes).toEqual([{ kind: 'create', id: running[0]?.id }]);
        expect(store.rows.size).toBe(1);

        const runId = running.at(0)?.id;

        expect(runId).toBeDefined();
        expect(results.every((result) => result.runId === runId)).toBe(true);
        expect(coordinator.currentRunId()).toBe(runId);

        // Never more than one running row at any point of the interleaving.
        expect(observedWhileSettling).toHaveLength(delays.length);
        expect(Math.max(...observedWhileSettling)).toBe(1);

        // The created run is the one 12.1 describes: a start time and the status "running".
        const row = running.at(0);

        expect(row?.status).toBe('RUNNING');
        expect(row?.startedAt).toBeInstanceOf(Date);
        expect(row?.finishedAt).toBeNull();
        expect(row?.runOutcome).toBeNull();

        // The run is live and not aborted: the losing starts changed nothing about it.
        const active = coordinator.activeScrapeRun();

        expect(active?.runId).toBe(runId);
        expect(active?.signal.aborted).toBe(false);

        // One start line for the created run, and the already-running hint for every other caller
        // (12.5), each naming the running run.
        expect(log.withCode('run.started')).toHaveLength(1);
        expect(log.withCode('run.started').at(0)?.runId).toBe(runId);

        const hints = log.withCode('run.alreadyRunning');

        expect(hints).toHaveLength(delays.length - 1);

        for (const hint of hints) {
          expect(hint.runId).toBe(runId);
          expect(hint.messageDe).toContain('Es läuft bereits ein Suchlauf.');
          expect(hint.detail).toEqual({ runningRunId: runId });
        }
      }),
      PROPERTY_RUNS,
    );
  });
});
