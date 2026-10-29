/**
 * The four behaviours task 14.3 puts into the Relevance_Service: the retry chain, the run budget,
 * the concurrency bound and the deactivated case (15.7 to 15.11).
 *
 * The AI_Provider is a stub throughout, so the suite is offline, free and deterministic; the real
 * request is the business of `./anthropic-relevance.assessor.test.ts` and of the opt-in live smoke
 * test next to it. What is asserted here is what no provider can be asked to produce on demand:
 *
 * - **The attempt count.** Two failures then an answer, three failures then `NOT_ASSESSED` with the
 *   German note of the error table, a schema violation that is not repeated, and the increasing
 *   intervals between two attempts (15.11, 15.12).
 * - **The budget.** More candidates than `RELEVANCE_MAX_PER_RUN` permits: which ones are assessed is
 *   decided by position before anything is sent, and the rest are reported as `NOT_ASSESSED` (15.7).
 * - **The concurrency.** Never more simultaneous requests than `RELEVANCE_CONCURRENCY` (15.8).
 * - **The deactivated service.** No request at all, every Job_Posting `NOT_ASSESSED` (15.9, 15.10).
 * - **Containment.** A cancelled Scrape_Run and a sink that refuses a result, neither of which may
 *   cost the remaining candidates their assessment.
 *
 * The content hash gate, the Posting_Store write and the end-of-run counters are not here: they are
 * tasks 14.4 and 14.5. The property tests of 14.7 to 14.9 and the full provider matrix of 14.10 own
 * the generated cases.
 *
 * Requirements: 15.7, 15.8, 15.9, 15.10, 15.11, 15.12.
 */

import type { EffectiveSearchProfile } from '@job-scraper/domain';
import { Logger } from '@nestjs/common';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { EnvConfig } from '../../config/env.schema';
import { NoopRelevanceAssessor } from '../noop-relevance.assessor';
import {
  compareRelevanceCandidates,
  type RelevanceAssessment,
  type RelevanceBatchItem,
  type RelevanceBatchReport,
  relevanceDisabledReasonOf,
  RelevanceService,
} from '../relevance.service';
import {
  RELEVANCE_MAX_ATTEMPTS,
  RELEVANCE_RETRY_BACKOFF_MS,
  type RelevanceAssessor,
  type RelevanceFailureCode,
  type RelevanceOutcome,
  type RelevanceRequest,
} from '../relevance-assessor.port';

/** The model the stub reports as the one that answered. */
const MODEL = 'claude-sonnet-4-5-20250929';

const PROFILE: EffectiveSearchProfile = {
  platform: 'STEPSTONE',
  criteria: [{ field: 'jobTitle', value: 'Pflegefachkraft', provenance: 'DEFAULT' }],
};

/** What is transmitted for one Job_Posting (15.2); its content is irrelevant to this suite. */
const requestFor = (title: string): RelevanceRequest => ({
  title,
  employer: 'Klinikum München',
  workLocation: 'München',
  publishedAt: new Date('2026-03-02T07:30:00.000Z'),
  descriptionText: 'Wir suchen eine Pflegefachkraft in Festanstellung.',
  profile: PROFILE,
});

const REQUEST = requestFor('Pflegefachkraft (m/w/d)');

/** A usable AI_Provider answer. */
const assessed = (): RelevanceOutcome => ({
  kind: 'ASSESSED',
  response: { verdict: 'RELEVANT', reason: 'Fachgebiet und Seniorität passen zum Suchprofil.' },
  model: MODEL,
});

const failedWith = (code: RelevanceFailureCode): RelevanceOutcome => ({ kind: 'FAILED', code });

/** The configuration as the service reads it; only the four relevance values matter. */
const envWith = (overrides: Partial<EnvConfig> = {}): EnvConfig =>
  ({
    relevanceEnabled: true,
    anthropicApiKey: 'sk-ant-test-key',
    relevanceMaxPerRun: 200,
    relevanceConcurrency: 4,
    ...overrides,
  }) as unknown as EnvConfig;

/** The AI_Provider as a test states it, with what the service asked of it recorded. */
interface AssessorStub {
  readonly assessor: RelevanceAssessor;
  /** The request of every `assess` call, in the order they were made. */
  readonly calls: readonly RelevanceRequest[];
  /** The highest number of calls that were in flight at the same time (15.8). */
  readonly peakInFlight: () => number;
}

const stubAssessor = (
  answer: (request: RelevanceRequest, call: number) => RelevanceOutcome | Promise<RelevanceOutcome>,
): AssessorStub => {
  const calls: RelevanceRequest[] = [];
  let inFlight = 0;
  let peak = 0;

  return {
    calls,
    peakInFlight: () => peak,
    assessor: {
      model: MODEL,
      assess: async (request: RelevanceRequest): Promise<RelevanceOutcome> => {
        const call = calls.push(request);

        inFlight += 1;
        peak = Math.max(peak, inFlight);

        try {
          return await answer(request, call);
        } finally {
          inFlight -= 1;
        }
      },
    },
  };
};

/** One batch run: what the sink received per Job_Posting, and what the service reported. */
interface BatchRun {
  readonly assessments: ReadonlyMap<string, RelevanceAssessment>;
  readonly report: RelevanceBatchReport;
}

const runBatch = async (
  service: RelevanceService,
  items: readonly RelevanceBatchItem[],
  signal: AbortSignal,
  onResult?: (postingId: string) => void,
): Promise<BatchRun> => {
  const assessments = new Map<string, RelevanceAssessment>();

  const report = await service.assessAll({
    items,
    signal,
    onResult: (postingId, assessment) => {
      onResult?.(postingId);
      assessments.set(postingId, assessment);
    },
  });

  return { assessments, report };
};

/** `count` candidates, named `p-0`, `p-1`, ... in the selection order of 15.7. */
const candidates = (count: number): readonly RelevanceBatchItem[] =>
  Array.from({ length: count }, (_unused, index) => ({
    postingId: `p-${String(index)}`,
    request: requestFor(`Stelle ${String(index)}`),
  }));

/** The totality invariant of a report: every candidate is accounted for exactly once (15.14). */
const expectTotalReport = (report: RelevanceBatchReport): void => {
  expect(report.assessed + report.notAssessed + report.outstanding + report.deliveryFailures).toBe(
    report.considered,
  );
};

beforeAll(() => {
  // The service reports a refused result through the Nest logger; a quiet test output is what makes
  // a real failure readable.
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RelevanceService retry chain (15.11)', () => {
  it('repeats a timed-out request and stores the answer of the third attempt', async () => {
    vi.useFakeTimers();

    const { assessor, calls } = stubAssessor((_request, call) =>
      call < RELEVANCE_MAX_ATTEMPTS ? failedWith('TIMEOUT') : assessed(),
    );
    const service = new RelevanceService(envWith(), assessor);
    const pending = service.assess(REQUEST, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(
      RELEVANCE_RETRY_BACKOFF_MS.reduce((total, interval) => total + interval, 0),
    );

    const assessment = await pending;

    expect(calls).toHaveLength(RELEVANCE_MAX_ATTEMPTS);
    expect(assessment.kind).toBe('ASSESSED');
    expect(assessment).toMatchObject({ verdict: 'RELEVANT', model: MODEL, attempts: 3 });
  });

  it('waits out the increasing interval before each repetition', async () => {
    vi.useFakeTimers();

    const { assessor, calls } = stubAssessor(() => failedWith('RATE_LIMIT'));
    const service = new RelevanceService(envWith(), assessor);
    const pending = service.assess(REQUEST, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RELEVANCE_RETRY_BACKOFF_MS[0] - 1);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(RELEVANCE_RETRY_BACKOFF_MS[1] - 1);
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(RELEVANCE_MAX_ATTEMPTS);

    await expect(pending).resolves.toMatchObject({
      kind: 'NOT_ASSESSED',
      cause: 'REQUEST_FAILED',
      failureCode: 'RATE_LIMIT',
      attempts: RELEVANCE_MAX_ATTEMPTS,
    });
  });

  it('leaves a German note of at most 300 characters after the last permitted attempt', async () => {
    vi.useFakeTimers();

    const { assessor } = stubAssessor(() => failedWith('TRANSPORT'));
    const service = new RelevanceService(envWith(), assessor);
    const pending = service.assess(REQUEST, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(10_000);

    const assessment = await pending;
    const reasonDe = assessment.kind === 'NOT_ASSESSED' ? assessment.reasonDe : null;

    expect(reasonDe).toContain('nicht');
    expect((reasonDe ?? '').length).toBeGreaterThan(0);
    expect((reasonDe ?? '').length).toBeLessThanOrEqual(300);
  });

  it('does not repeat an unusable answer (15.12)', async () => {
    const { assessor, calls } = stubAssessor(() => failedWith('SCHEMA_VIOLATION'));
    const service = new RelevanceService(envWith(), assessor);

    const assessment = await service.assess(REQUEST, new AbortController().signal);

    expect(calls).toHaveLength(1);
    expect(assessment).toMatchObject({
      kind: 'NOT_ASSESSED',
      cause: 'SCHEMA_VIOLATION',
      attempts: 1,
    });
    expect(assessment.kind === 'NOT_ASSESSED' ? assessment.reasonDe : null).not.toBeNull();
  });

  it('stops repeating when the Scrape_Run is cancelled during the interval', async () => {
    vi.useFakeTimers();

    const controller = new AbortController();
    const { assessor, calls } = stubAssessor(() => failedWith('TIMEOUT'));
    const service = new RelevanceService(envWith(), assessor);
    const pending = service.assess(REQUEST, controller.signal);

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    controller.abort();

    await expect(pending).resolves.toMatchObject({ kind: 'NOT_ASSESSED', cause: 'CANCELLED' });
    expect(calls).toHaveLength(1);
  });
});

describe('RelevanceService run budget (15.7)', () => {
  it('assesses the first candidates of the list and reports the rest as not assessed', async () => {
    const { assessor, calls } = stubAssessor(() => assessed());
    const service = new RelevanceService(envWith({ relevanceMaxPerRun: 2 }), assessor);
    const items = candidates(5);

    const { report, assessments } = await runBatch(service, items, new AbortController().signal);

    expect(calls.map((request) => request.title)).toEqual(['Stelle 0', 'Stelle 1']);
    expect(report).toMatchObject({
      considered: 5,
      requested: 2,
      assessed: 2,
      notAssessed: 3,
      skippedByBudget: 3,
      outstanding: 0,
      deliveryFailures: 0,
    });
    expect(assessments.get('p-0')?.kind).toBe('ASSESSED');
    expect(assessments.get('p-4')).toMatchObject({
      kind: 'NOT_ASSESSED',
      cause: 'BUDGET_REACHED',
      // No per-Job_Posting note: the budget is reported once per run (15.7).
      reasonDe: null,
      attempts: 0,
    });
    expectTotalReport(report);
  });

  it('counts a repeated request as one assessment against the budget', async () => {
    vi.useFakeTimers();

    const { assessor, calls } = stubAssessor((_request, call) =>
      call < 3 ? failedWith('TIMEOUT') : assessed(),
    );
    const service = new RelevanceService(
      envWith({ relevanceMaxPerRun: 1, relevanceConcurrency: 1 }),
      assessor,
    );
    const pending = runBatch(service, candidates(2), new AbortController().signal);

    await vi.advanceTimersByTimeAsync(10_000);

    const { report } = await pending;

    expect(calls).toHaveLength(RELEVANCE_MAX_ATTEMPTS);
    expect(report).toMatchObject({ requested: 1, assessed: 1, skippedByBudget: 1 });
  });

  it('orders candidates by first sighting and then by identifier', () => {
    const older = { firstSeenAt: new Date('2026-03-01T08:00:00.000Z'), id: 'b' };
    const newer = { firstSeenAt: new Date('2026-03-02T08:00:00.000Z'), id: 'a' };
    const sameTime = { firstSeenAt: older.firstSeenAt, id: 'a' };

    expect([newer, older, sameTime].sort(compareRelevanceCandidates).map((row) => row.id)).toEqual([
      'a',
      'b',
      'a',
    ]);
    expect(compareRelevanceCandidates(older, newer)).toBeLessThan(0);
    expect(compareRelevanceCandidates(sameTime, older)).toBeLessThan(0);
  });
});

describe('RelevanceService concurrency bound (15.8)', () => {
  it('never sends more simultaneous requests than configured', async () => {
    const { assessor, peakInFlight } = stubAssessor(
      async () =>
        new Promise<RelevanceOutcome>((resolve) => {
          setTimeout(() => resolve(assessed()), 1);
        }),
    );
    const service = new RelevanceService(envWith({ relevanceConcurrency: 3 }), assessor);

    const { report } = await runBatch(service, candidates(12), new AbortController().signal);

    expect(peakInFlight()).toBeGreaterThan(1);
    expect(peakInFlight()).toBeLessThanOrEqual(3);
    expect(report).toMatchObject({ considered: 12, assessed: 12, outstanding: 0 });
  });
});

describe('RelevanceService deactivated (15.9, 15.10)', () => {
  it('sends no request and reports every Job_Posting as not assessed', async () => {
    const assessor = new NoopRelevanceAssessor();
    const spy = vi.spyOn(assessor, 'assess');
    const service = new RelevanceService(envWith({ relevanceEnabled: false }), assessor);

    const { report, assessments } = await runBatch(
      service,
      candidates(3),
      new AbortController().signal,
    );

    expect(spy).not.toHaveBeenCalled();
    expect(service.activated).toBe(false);
    expect(service.disabledReason).toBe('SWITCHED_OFF');
    expect(report).toMatchObject({
      considered: 3,
      requested: 0,
      assessed: 0,
      notAssessed: 3,
      skippedByBudget: 0,
      outstanding: 0,
    });
    expect(assessments.get('p-1')).toMatchObject({
      kind: 'NOT_ASSESSED',
      cause: 'DISABLED',
      reasonDe: null,
      attempts: 0,
    });
    expectTotalReport(report);
  });

  it('turns a no-key answer of the bound assessor into the deactivated cause', async () => {
    const service = new RelevanceService(envWith(), new NoopRelevanceAssessor());

    await expect(service.assess(REQUEST, new AbortController().signal)).resolves.toMatchObject({
      kind: 'NOT_ASSESSED',
      cause: 'DISABLED',
      failureCode: 'NO_API_KEY',
    });
  });

  it('names the switch before the missing key', () => {
    expect(
      relevanceDisabledReasonOf({ relevanceEnabled: true, anthropicApiKey: 'sk-ant' }),
    ).toBeNull();
    expect(relevanceDisabledReasonOf({ relevanceEnabled: true, anthropicApiKey: '  ' })).toBe(
      'NO_API_KEY',
    );
    expect(relevanceDisabledReasonOf({ relevanceEnabled: false, anthropicApiKey: '' })).toBe(
      'SWITCHED_OFF',
    );
  });
});

describe('RelevanceService containment', () => {
  it('reports the candidates a cancelled Scrape_Run did not reach as outstanding', async () => {
    const controller = new AbortController();
    const { assessor, calls } = stubAssessor((_request, call) => {
      if (call === 2) {
        controller.abort();
      }

      return assessed();
    });
    const service = new RelevanceService(envWith({ relevanceConcurrency: 1 }), assessor);

    const { report } = await runBatch(service, candidates(6), controller.signal);

    expect(calls.length).toBeLessThan(6);
    expect(report.outstanding).toBeGreaterThan(0);
    expect(report.assessed).toBe(calls.length);
    expectTotalReport(report);
  });

  it('contains a sink that refuses one result and keeps assessing the rest', async () => {
    const { assessor } = stubAssessor(() => assessed());
    const service = new RelevanceService(envWith({ relevanceConcurrency: 1 }), assessor);

    const { report, assessments } = await runBatch(
      service,
      candidates(3),
      new AbortController().signal,
      (postingId) => {
        if (postingId === 'p-1') {
          throw new Error('the Posting_Store refused the write');
        }
      },
    );

    expect(report).toMatchObject({ considered: 3, assessed: 2, deliveryFailures: 1 });
    expect(assessments.has('p-2')).toBe(true);
    expectTotalReport(report);
  });

  it('answers an empty candidate list without asking anything', async () => {
    const { assessor, calls } = stubAssessor(() => assessed());
    const service = new RelevanceService(envWith(), assessor);

    const { report } = await runBatch(service, [], new AbortController().signal);

    expect(calls).toHaveLength(0);
    expect(report).toMatchObject({ considered: 0, assessed: 0, notAssessed: 0, outstanding: 0 });
  });
});
