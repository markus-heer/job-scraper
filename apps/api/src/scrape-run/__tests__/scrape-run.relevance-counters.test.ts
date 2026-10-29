/**
 * The end-of-run assessment counters and the reached assessment budget (15.7, 15.16).
 *
 * The subject is what task 14.5 answers for: when a Scrape_Run ends, the Log_Stream carries the
 * number of assessed Job_Posting, the number with the Relevance_Verdict "not relevant" and the
 * number with "not assessed" (15.16), preceded by the German message about the reached run budget
 * where the budget bound (15.7) — and both before the end-of-run summary, which 12.10 makes the
 * last message of a run.
 *
 * The real lifecycle runs: a real `ScrapeRunCoordinator` over the stand-in `ScrapeRun` store and
 * Log_Stream of this directory. The two enrichment stages are stand-ins that report numbers instead
 * of assessing anything — their own behaviour is
 * `src/relevance/__tests__/relevance-enrichment.service.test.ts` — because what is under test here
 * is which lines those numbers turn into, and in which order.
 *
 * Requirements: 12.10, 15.7, 15.16.
 */

import { describe, expect, it, vi } from 'vitest';

import type { LogMessagePayload } from '../../log-stream/log-stream.service';
import type { LogMessage } from '../../prisma/prisma.types';
import { RELEVANCE_COUNTERS_LOG_CODE } from '../../relevance/relevance.messages';
import type { RelevanceEnrichmentReport } from '../../relevance/relevance-enrichment.service';
import type { PlatformResultStore, ScrapeRunExecution } from '../../scraper/scraper.service';
import { ScrapeRunCoordinator, type ScrapeRunLog } from '../scrape-run.coordinator';
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
} from './scrape-run.fixture';

const ENRICHMENT_GRACE_MINUTES = 10;

const BUDGET_REACHED_LOG_CODE = 'relevance.budgetReached';

/** A retrieval phase that is over before it starts: no Platform, no result row, no finding. */
const retrieval: RetrievalPhase = {
  execute: (): Promise<ScrapeRunExecution> =>
    Promise.resolve({ runOutcome: 'COMPLETED', platforms: [], retrievalEndedAt: new Date() }),
};

/** A commute stage that determined nothing and left nothing outstanding (8.1). */
const commute: CommuteEnrichmentPhase = {
  enrichRun: () =>
    Promise.resolve({ considered: 0, determined: 0, reused: 0, unknown: 0, outstanding: 0 }),
};

/** A Platform result store the empty retrieval never writes to. */
const resultStore = {
  scrapeRunPlatformResult: {
    upsert: () => Promise.reject(new Error('this suite requests no Platform')),
  } as unknown as PlatformResultStore['scrapeRunPlatformResult'],
} satisfies PlatformResultStore;

/** A relevance stage report whose counters satisfy the batch invariant of the real stage. */
const report = (overrides: Partial<RelevanceEnrichmentReport> = {}): RelevanceEnrichmentReport => ({
  considered: 0,
  requested: 0,
  assessed: 0,
  notRelevant: 0,
  notAssessed: 0,
  skippedByBudget: 0,
  outstanding: 0,
  deliveryFailures: 0,
  ...overrides,
});

/** A relevance stage that reports `result`, or could not be carried out at all where it is `null`. */
const relevance = (result: RelevanceEnrichmentReport | null): RelevanceEnrichmentPhase => ({
  enrichRun: () =>
    result === null
      ? Promise.reject(new Error('the AI_Provider could not be reached'))
      : Promise.resolve(result),
});

interface Harness {
  readonly service: ScrapeRunService;
  readonly log: LogRecorderFixture;
  /** The codes of the emitted messages, in order. */
  codes(): readonly string[];
  /** The payload of one code, or `undefined` where none was emitted. */
  lineOf(code: string): LogMessagePayload | undefined;
}

/** The subject over the stand-ins, with a relevance stage that reports `result`. */
const harness = (
  result: RelevanceEnrichmentReport | null,
  options: { readonly rejectCode?: string } = {},
): Harness => {
  const runs = createScrapeRunStore();
  const recorder = createLogRecorder();

  const log: ScrapeRunLog = {
    emit: (payload: LogMessagePayload): Promise<LogMessage> =>
      payload.code === options.rejectCode
        ? Promise.reject(new Error('the Log_Stream refused this line'))
        : recorder.log.emit(payload),
    initialiseCounter: (runId: string) => recorder.log.initialiseCounter(runId),
    releaseRun: (runId: string) => {
      recorder.log.releaseRun(runId);
    },
  };

  const coordinator = new ScrapeRunCoordinator(runs.store, log, {
    enrichmentGraceMinutes: ENRICHMENT_GRACE_MINUTES,
  });

  return {
    service: new ScrapeRunService(
      coordinator,
      retrieval,
      log,
      resultStore,
      commute,
      relevance(result),
    ),
    log: recorder,
    codes: () => recorder.messages.map((message) => message.code),
    lineOf: (code) => recorder.withCode(code).at(0),
  };
};

/** Runs one Scrape_Run to its end: the summary is the last message of a run (12.10). */
const runToEnd = async (subject: Harness): Promise<void> => {
  await subject.service.start();
  await vi.waitFor(() => {
    expect(subject.log.withCode(RUN_SUMMARY_LOG_CODE)).toHaveLength(1);
  });
};

describe('the end-of-run assessment counters', () => {
  it('writes the assessed, "not relevant" and "not assessed" counts (15.16)', async () => {
    const subject = harness(
      report({ considered: 20, requested: 17, assessed: 17, notRelevant: 11, notAssessed: 3 }),
    );

    await runToEnd(subject);

    const line = subject.lineOf(RELEVANCE_COUNTERS_LOG_CODE);

    expect(line?.level).toBe('INFO');
    expect(line?.messageDe).toBe(
      'KI-Bewertung: 17 Treffer bewertet, davon 11 nicht relevant. 3 Treffer nicht bewertet.',
    );
    expect(line?.detail).toStrictEqual({
      considered: 20,
      requested: 17,
      assessed: 17,
      notRelevant: 11,
      notAssessed: 3,
    });
  });

  it('writes the counters before the summary (12.10)', async () => {
    const subject = harness(report({ considered: 2, requested: 2, assessed: 2 }));

    await runToEnd(subject);

    const codes = subject.codes();

    expect(codes.indexOf(RELEVANCE_COUNTERS_LOG_CODE)).toBeGreaterThanOrEqual(0);
    expect(codes.indexOf(RELEVANCE_COUNTERS_LOG_CODE)).toBeLessThan(
      codes.indexOf(RUN_SUMMARY_LOG_CODE),
    );
  });

  it('writes the counters of a run that had nothing to assess', async () => {
    const subject = harness(report());

    await runToEnd(subject);

    // A tally that leaves out its zeros cannot be told apart from one that was never taken.
    expect(subject.lineOf(RELEVANCE_COUNTERS_LOG_CODE)?.messageDe).toBe(
      'KI-Bewertung: 0 Treffer bewertet, davon 0 nicht relevant. 0 Treffer nicht bewertet.',
    );
  });

  it('writes no counters for a stage that could not be carried out', async () => {
    const subject = harness(null);

    await runToEnd(subject);

    // Nothing was counted, so there is no tally to report — and the run still ends normally.
    expect(subject.codes()).not.toContain(RELEVANCE_COUNTERS_LOG_CODE);
  });

  it('closes the Scrape_Run when the Log_Stream refuses the counters', async () => {
    const subject = harness(report({ considered: 1, requested: 1, assessed: 1 }), {
      rejectCode: RELEVANCE_COUNTERS_LOG_CODE,
    });

    // `runToEnd` waits for the summary: a refused counters line must not take the run down with
    // it, because the Scrape_Run has happened and its Job_Posting are stored.
    await runToEnd(subject);

    expect(subject.codes()).not.toContain(RELEVANCE_COUNTERS_LOG_CODE);
  });
});

describe('the reached assessment budget', () => {
  it('reports the Job_Posting the run budget did not reach (15.7)', async () => {
    const subject = harness(
      report({
        considered: 210,
        requested: 200,
        assessed: 200,
        notRelevant: 120,
        notAssessed: 10,
        skippedByBudget: 10,
      }),
    );

    await runToEnd(subject);

    const line = subject.lineOf(BUDGET_REACHED_LOG_CODE);

    expect(line?.level).toBe('INFO');
    expect(line?.messageDe).toContain(
      'Bewertungslimit erreicht: 10 Treffer wurden nicht bewertet.',
    );
    expect(line?.detail).toStrictEqual({ count: 10 });

    // Before the counters, because it names the cause of a part of the "not assessed" count.
    const codes = subject.codes();

    expect(codes.indexOf(BUDGET_REACHED_LOG_CODE)).toBeLessThan(
      codes.indexOf(RELEVANCE_COUNTERS_LOG_CODE),
    );
  });

  it('reports no budget message for a run that stayed inside its budget (15.7)', async () => {
    const subject = harness(report({ considered: 5, requested: 5, assessed: 5 }));

    await runToEnd(subject);

    expect(subject.codes()).not.toContain(BUDGET_REACHED_LOG_CODE);
  });
});
