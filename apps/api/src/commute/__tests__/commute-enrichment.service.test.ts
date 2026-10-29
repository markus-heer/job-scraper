/**
 * What the commute enrichment stage of a Scrape_Run counts, contains and gives up on (8.2, 8.8,
 * 8.13).
 *
 * `commute-persistence.test.ts` (task 13.5) drives this stage with the real `CommuteService` and
 * asserts what one determination leaves behind: the stored columns and the German Log_Stream lines.
 * What is left for task 13.9 is the stage's own control flow, which a real determination cannot
 * produce on demand:
 *
 * - **The report.** `considered`, `determined`, `reused`, `unknown` and `outstanding` over a batch
 *   that contains one of each, and the deterministic order the Job_Posting are worked through in.
 * - **The window.** A Scrape_Run cancelled mid-batch and a grace window that closes mid-batch: the
 *   remaining Job_Posting are reported as outstanding, their columns stay untouched, and the reason
 *   the stage's own abort carries is the one the caller can tell apart.
 * - **Containment.** A rejected Posting_Store read, a rejected candidate query, a Job_Posting that
 *   is gone and a Log_Stream that refuses a line: each is contained so the remaining Job_Posting
 *   still get their determination, and none of them produces a German line that would not be true.
 *
 * The determination is therefore a stub here — the stage narrows its dependency to
 * `Pick<CommuteService, 'enrich'>` for exactly this reason — while the write goes through the real
 * `PostingRepository` over the in-memory Posting_Store of `./commute-store.fixture.ts`, so the
 * counted outcomes and the stored rows cannot drift apart.
 *
 * Requirements: 8.2, 8.5, 8.8, 8.12, 8.13.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LogMessagePayload } from '../../log-stream/log-stream.service';
import { PostingRepository } from '../../posting/posting.repository';
import type { LogMessage } from '../../prisma/prisma.types';
import type { CommuteResult, CommuteUnresolvedReason } from '../commute.service';
import {
  type CommuteDeterminer,
  type CommuteEnrichmentLog,
  CommuteEnrichmentService,
  type CommuteEnrichmentStore,
  EnrichmentWindowClosedError,
} from '../commute-enrichment.service';
import { type CommuteStoreFixture, createCommuteStore } from './commute-store.fixture';

/** The Scrape_Run the stage runs in; its start time is the `lastSeenAt` of its candidates (9.3). */
const RUN_ID = 'run-1';
const RUN_STARTED_AT = new Date('2026-03-02T08:00:00.000Z');

/** When the stubbed determinations were made. */
const CHECKED_AT = new Date('2026-03-02T08:05:00.000Z');

/** A work location the determinations below are about. */
const WORK_LOCATION = 'München (hybrid)';

/** A determination that produced a Best_Commute_Time. */
const determinedResult = (): CommuteResult => ({
  bicycleMinutes: 41,
  transitMinutes: 28,
  bestCommuteMinutes: 28,
  bestCommuteMode: 'TRANSIT',
  precision: 'EXACT',
  locationInput: WORK_LOCATION,
  checkedAt: CHECKED_AT,
  reason: null,
  reused: false,
});

/** A determination that reported the stored result unchanged (8.9). */
const reusedResult = (): CommuteResult => ({ ...determinedResult(), reused: true });

/** A determination that produced no Best_Commute_Time. */
const unresolvedResult = (reason: CommuteUnresolvedReason): CommuteResult => ({
  bicycleMinutes: null,
  transitMinutes: null,
  bestCommuteMinutes: null,
  bestCommuteMode: null,
  precision: 'UNKNOWN',
  locationInput: WORK_LOCATION,
  checkedAt: CHECKED_AT,
  reason,
  reused: false,
});

/** The determination as a test states it, with the Job_Posting it was asked about recorded. */
interface DeterminerStub {
  readonly determiner: CommuteDeterminer;
  /** Every `enrich` call in the order the stage made them. */
  readonly calls: readonly string[];
}

const stubDeterminer = (
  answer: (postingId: string, signal: AbortSignal) => CommuteResult | Promise<CommuteResult>,
): DeterminerStub => {
  const calls: string[] = [];

  return {
    determiner: {
      enrich: async (postingId: string, signal: AbortSignal): Promise<CommuteResult> => {
        calls.push(postingId);

        return answer(postingId, signal);
      },
    },
    calls,
  };
};

/** Records every Log_Stream message of the stage, and optionally refuses them all. */
interface LogRecorder {
  readonly log: CommuteEnrichmentLog;
  readonly messages: readonly LogMessagePayload[];
  codes(): readonly string[];
}

const createLogRecorder = (rejectWith?: unknown): LogRecorder => {
  const messages: LogMessagePayload[] = [];

  const log: CommuteEnrichmentLog = {
    emit: (payload: LogMessagePayload): Promise<LogMessage> => {
      messages.push(payload);

      if (rejectWith !== undefined) {
        return Promise.reject(rejectWith);
      }

      return Promise.resolve({
        id: `log-${String(messages.length)}`,
        runId: payload.runId,
        sequence: messages.length,
        createdAt: new Date(),
        platform: payload.platform ?? null,
        level: payload.level,
        code: payload.code,
        messageDe: payload.messageDe,
        detail: payload.detail ?? null,
      });
    },
  };

  return { log, messages, codes: () => messages.map((message) => message.code) };
};

interface Harness {
  readonly fixture: CommuteStoreFixture;
  readonly stage: CommuteEnrichmentService;
  readonly log: LogRecorder;
}

/** The stage with a stubbed determination and the real write path. */
const harness = (determiner: CommuteDeterminer, log = createLogRecorder()): Harness => {
  const fixture = createCommuteStore();
  const stage = new CommuteEnrichmentService(
    fixture.store,
    determiner,
    new PostingRepository(fixture.store),
    log.log,
  );

  return { fixture, stage, log };
};

/** A Job_Posting as the retrieval phase of this Scrape_Run left it. */
const seedPosting = (
  fixture: CommuteStoreFixture,
  id: string,
  overrides: { readonly platform?: 'GLASSDOOR' | 'STEPSTONE'; readonly postingId?: string } = {},
): void => {
  fixture.seedPosting({
    id,
    title: 'Projektmanagerin',
    workLocation: WORK_LOCATION,
    lastSeenAt: RUN_STARTED_AT,
    ...overrides,
  });
};

/** Runs the stage over the Job_Posting of the Scrape_Run. */
const enrich = async (
  stage: CommuteEnrichmentService,
  overrides: { readonly signal?: AbortSignal; readonly graceDeadline?: Date | null } = {},
) =>
  stage.enrichRun({
    runId: RUN_ID,
    runStartedAt: RUN_STARTED_AT,
    signal: overrides.signal ?? new AbortController().signal,
    graceDeadline: overrides.graceDeadline ?? null,
  });

describe('CommuteEnrichmentService.enrichRun, the report of one stage', () => {
  it('counts a batch of one determined, one reused and one unresolved Job_Posting', async () => {
    const answers: Record<string, CommuteResult> = {
      p1: determinedResult(),
      p2: reusedResult(),
      p3: unresolvedResult('ROUTING_FAILED'),
    };
    const determiner = stubDeterminer((postingId) => answers[postingId] ?? determinedResult());
    const { fixture, stage, log } = harness(determiner.determiner);

    for (const id of ['p1', 'p2', 'p3']) {
      seedPosting(fixture, id);
    }

    const report = await enrich(stage);

    expect(report).toStrictEqual({
      considered: 3,
      determined: 1,
      reused: 1,
      unknown: 1,
      outstanding: 0,
    });
    // The reused determination writes nothing; the other two write exactly one row each.
    expect(fixture.writes.map((write) => write.key)).toStrictEqual(['p1', 'p3']);
    expect(fixture.postingOf('p2')?.commuteCheckedAt).toBeNull();
    expect(log.codes()).toStrictEqual(['commute.providerFailed', 'commute.providerFailed']);
    expect(log.messages.every((message) => message.detail?.postingId === 'p3')).toBe(true);
  });

  it('works through the Job_Posting Platform first and Posting_Id second', async () => {
    const determiner = stubDeterminer(() => determinedResult());
    const { fixture, stage } = harness(determiner.determiner);

    seedPosting(fixture, 'later-platform', { platform: 'STEPSTONE', postingId: 'a-1' });
    seedPosting(fixture, 'second', { platform: 'GLASSDOOR', postingId: 'b-2' });
    seedPosting(fixture, 'first', { platform: 'GLASSDOOR', postingId: 'a-9' });

    await enrich(stage);

    // Deterministic, so two stages over the same stored state spend their queries in the same
    // order — which is what makes the bounds of 8.7 and 8.9 reproducible.
    expect(determiner.calls).toStrictEqual(['first', 'second', 'later-platform']);
  });
});

describe('CommuteEnrichmentService.enrichRun, the end of the window', () => {
  it('reports the Job_Posting it did not reach after the Scrape_Run was cancelled', async () => {
    const cancellation = new Error('Der Suchlauf wurde abgebrochen.');
    const controller = new AbortController();
    let reasonSeen: unknown = null;

    const determiner = stubDeterminer((postingId, signal) => {
      if (postingId === 'p1') {
        controller.abort(cancellation);
        reasonSeen = signal.reason;
      }

      return determinedResult();
    });
    const { fixture, stage, log } = harness(determiner.determiner);

    seedPosting(fixture, 'p1');
    seedPosting(fixture, 'p2');

    const report = await enrich(stage, { signal: controller.signal });

    expect(report).toStrictEqual({
      considered: 2,
      determined: 1,
      reused: 0,
      unknown: 0,
      outstanding: 1,
    });
    // The determination in flight learns of the cancellation through its own signal, carrying the
    // reason the Scrape_Run gave.
    expect(reasonSeen).toBe(cancellation);
    expect(determiner.calls).toStrictEqual(['p1']);
    expect(fixture.postingOf('p2')?.commuteCheckedAt).toBeNull();
    expect(log.codes()).toStrictEqual([]);
  });

  it('ends a determination in flight once the grace window closes', async () => {
    const determiner = stubDeterminer(
      (_postingId, signal) =>
        new Promise<CommuteResult>((resolve) => {
          if (signal.aborted) {
            resolve(unresolvedResult('CANCELLED'));

            return;
          }

          signal.addEventListener(
            'abort',
            () => {
              resolve(unresolvedResult('CANCELLED'));
            },
            { once: true },
          );
        }),
    );
    const { fixture, stage, log } = harness(determiner.determiner);

    seedPosting(fixture, 'p1');
    seedPosting(fixture, 'p2');

    // 50 milliseconds, so the window closes while the first determination is still waiting. The
    // determination resolves on the abort rather than after a sleep, so the test does not race.
    //
    // The deadline was one millisecond before and that was below the scheduler noise: `enrichRun`
    // reads the candidates from the store and takes its own clock reading afterwards, so any pause
    // longer than that millisecond between the two readings opened the window already aborted —
    // no determination was started, and the report said `outstanding: 2` instead of `1`. 50 ms is
    // above that noise and still far below any timeout in this suite.
    const report = await enrich(stage, { graceDeadline: new Date(Date.now() + 50) });

    expect(report).toStrictEqual({
      considered: 2,
      determined: 0,
      reused: 0,
      unknown: 0,
      outstanding: 1,
    });
    expect(determiner.calls).toStrictEqual(['p1']);
    // A cancelled determination writes nothing and says nothing: the closed window is a statement
    // about the Scrape_Run, which reports it once for both enrichment stages.
    expect(fixture.writes).toStrictEqual([]);
    expect(log.codes()).toStrictEqual([]);
  });

  it('tells the closed grace window apart from a cancelled Scrape_Run', async () => {
    let reasonSeen: unknown = null;
    const determiner = stubDeterminer(
      (_postingId, signal) =>
        new Promise<CommuteResult>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              reasonSeen = signal.reason;
              resolve(unresolvedResult('CANCELLED'));
            },
            { once: true },
          );
        }),
    );
    const { fixture, stage } = harness(determiner.determiner);

    seedPosting(fixture, 'p1');

    await enrich(stage, { graceDeadline: new Date(Date.now() + 1) });

    expect(reasonSeen).toBeInstanceOf(EnrichmentWindowClosedError);
  });
});

describe('CommuteEnrichmentService.enrichRun, the grace timer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves no timer behind after a stage that finished inside its window', async () => {
    vi.useFakeTimers();

    const determiner = stubDeterminer(() => determinedResult());
    const { fixture, stage } = harness(determiner.determiner);

    seedPosting(fixture, 'p1');

    const report = await enrich(stage, {
      graceDeadline: new Date(Date.now() + 10 * 60 * 1_000),
    });

    expect(report.determined).toBe(1);
    // An uncleared deadline would keep the process alive for the rest of the grace period after a
    // Scrape_Run that finished in seconds.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('CommuteEnrichmentService.enrichRun, what it contains', () => {
  it('keeps going after a rejected Posting_Store read of one Job_Posting (9.9)', async () => {
    const determiner = stubDeterminer((postingId) => {
      if (postingId === 'p1') {
        return Promise.reject(new Error('connection closed'));
      }

      return determinedResult();
    });
    const { fixture, stage, log } = harness(determiner.determiner);

    seedPosting(fixture, 'p1');
    seedPosting(fixture, 'p2');

    const report = await enrich(stage);

    expect(report).toStrictEqual({
      considered: 2,
      determined: 1,
      reused: 0,
      unknown: 0,
      outstanding: 0,
    });
    expect(fixture.postingOf('p1')?.commuteCheckedAt).toBeNull();
    expect(fixture.postingOf('p2')?.bestCommuteMinutes).toBe(28);
    // Nothing was determined for p1, so neither German line would be a true statement about it.
    expect(log.codes()).toStrictEqual([]);
  });

  it('skips a Job_Posting that is gone without writing or saying anything', async () => {
    const determiner = stubDeterminer(() => unresolvedResult('POSTING_NOT_FOUND'));
    const { fixture, stage, log } = harness(determiner.determiner);

    seedPosting(fixture, 'p1');

    const report = await enrich(stage);

    expect(report).toStrictEqual({
      considered: 1,
      determined: 0,
      reused: 0,
      unknown: 0,
      outstanding: 0,
    });
    expect(fixture.writes).toStrictEqual([]);
    expect(log.codes()).toStrictEqual([]);
  });

  it('reports an empty stage when the candidate query is rejected', async () => {
    const determiner = stubDeterminer(() => determinedResult());
    const store = {
      jobPosting: { findMany: () => Promise.reject(new Error('connection closed')) },
    } as unknown as CommuteEnrichmentStore;
    const log = createLogRecorder();
    const stage = new CommuteEnrichmentService(
      store,
      determiner.determiner,
      new PostingRepository(createCommuteStore().store),
      log.log,
    );

    const report = await enrich(stage);

    expect(report).toStrictEqual({
      considered: 0,
      determined: 0,
      reused: 0,
      unknown: 0,
      outstanding: 0,
    });
    expect(determiner.calls).toStrictEqual([]);
  });

  it('keeps the stored Commute_Time when the Log_Stream refuses its explanation', async () => {
    const determiner = stubDeterminer(() => unresolvedResult('ROUTING_FAILED'));
    const log = createLogRecorder(new Error('log stream unavailable'));
    const { fixture, stage } = harness(determiner.determiner, log);

    seedPosting(fixture, 'p1');

    const report = await enrich(stage);

    expect(report.unknown).toBe(1);
    expect(fixture.postingOf('p1')?.commuteCheckedAt).toStrictEqual(CHECKED_AT);
    expect(fixture.postingOf('p1')?.commuteLocationInput).toBe(WORK_LOCATION);
    // A refused line must not cost the second mode its line, nor the remaining Job_Posting their
    // determination.
    expect(log.codes()).toStrictEqual(['commute.providerFailed', 'commute.providerFailed']);
  });
});
