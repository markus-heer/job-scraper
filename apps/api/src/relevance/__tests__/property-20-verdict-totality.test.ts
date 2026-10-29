/**
 * Property 20 of the job-search-tool design: every Job_Posting carries exactly one
 * Relevance_Verdict.
 *
 * The subject is one whole batch of the Relevance_Service — `assessAll` over a *combination* of
 * per-Job_Posting AI_Provider behaviours — which is what makes this a property rather than a case:
 * 15.14 promises one verdict per Job_Posting however the provider behaves, and the interesting
 * failures of such a rule are the mixtures. A batch in which the budget binds in the middle, three
 * candidates exhaust their retry chain, one answer is discarded and the rest succeed is a state the
 * example suite cannot enumerate, and it is exactly where a lost or a double-counted candidate
 * would hide.
 *
 * The run is fully offline, free and deterministic. The AI_Provider is stubbed at the port
 * (`../relevance-assessor.port.ts`), so no request is sent and no key is read; the decisions under
 * test — the retry chain of 15.11, the per-run budget of 15.7, the deactivated case of 15.9 and
 * 15.10 and the `NOT_ASSESSED` of 15.12 — are the Relevance_Service's own and need neither a
 * network nor a database.
 *
 * ## Why the stub rather than the real assessor
 *
 * `vi.useFakeTimers()` drives the service's own backoff intervals, but not the `AbortSignal.timeout`
 * the `AnthropicRelevanceAssessor` arms inside its request: a property that produced a real timeout
 * would wait 30 real seconds per candidate. The three retriable codes are therefore *stated* by the
 * stub, which is also the only way to produce a rate limit on demand.
 *
 * ## The oracle, and where it departs from the design's wording
 *
 * The design asks for "every row has a non-null `relevanceVerdict` inside `RELEVANCE_VERDICTS`".
 * The row is reached without a database by projecting each delivered assessment through the *real*
 * `persistedRelevanceResultOf` (task 14.4), which is the function the Posting_Store write is fed
 * with — so the claim is about the stored columns, not about an intermediate shape. The Posting_Store
 * write itself, the content hash gate and the end-of-run counters are tasks 14.4, 14.5 and
 * Properties 21 and 29.
 *
 * Two honest departures:
 *
 * - The design's "the mocked assessor's call count is at most `min(postingCount, budget)`" cannot
 *   hold literally: 15.11 permits three *attempts* per assessment, so a batch of one failing
 *   candidate makes three calls against a budget of one. 15.7 bounds assessments, and an assessment
 *   is one candidate however many attempts it cost, so the oracle counts the *distinct* Job_Posting
 *   the assessor was asked about — which is what the generated titles are unique for.
 * - The design's generator draws a boolean for "service deactivated"; this one draws between the
 *   two causes 15.10 names, the switch of 15.9 and the absent API key, because the service reads
 *   them in that order and both must end in the same verdict for every candidate.
 *
 * A cancelled Scrape_Run is deliberately outside the generator: `cause: 'CANCELLED'` is not a
 * verdict and is never handed to the sink — the Job_Posting keeps its stored columns and is asked
 * again in the next Scrape_Run — so a cancelled batch has nothing to say about "exactly one
 * verdict". Its containment is the example suite's (`./relevance.service.test.ts`).
 */

// Feature: job-search-tool, Property 20 - Every Job_Posting carries exactly one Relevance_Verdict

import {
  type EffectiveSearchProfile,
  RELEVANCE_RANK,
  RELEVANCE_VERDICTS,
} from '@job-scraper/domain';
import { Logger } from '@nestjs/common';
import fc from 'fast-check';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { EnvConfig } from '../../config/env.schema';
import { persistedRelevanceResultOf } from '../persisted-relevance';
import {
  type RelevanceAssessment,
  type RelevanceBatchItem,
  type RelevanceBatchReport,
  type RelevanceNotAssessedCause,
  RelevanceService,
} from '../relevance.service';
import {
  ASSESSED_RELEVANCE_VERDICTS,
  type AssessedRelevanceVerdict,
  RELEVANCE_MAX_ATTEMPTS,
  type RelevanceAssessor,
  type RelevanceFailureCode,
  type RelevanceOutcome,
  type RelevanceRequest,
} from '../relevance-assessor.port';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** The model the stub reports as the one that answered (15.1). */
const MODEL = 'claude-sonnet-4-5-20250929';

/** The content hash of the row an assessment is requested for; opaque to this property (15.5). */
const CONTENT_HASH = 'e3b0c44298fc1c149afbf4c8996fb924';

/** The assessment benchmark every request carries (15.2); its content is irrelevant here. */
const PROFILE: EffectiveSearchProfile = {
  platform: 'STEPSTONE',
  criteria: [{ field: 'jobTitle', value: 'Pflegefachkraft', provenance: 'DEFAULT' }],
};

/** The per-Job_Posting AI_Provider behaviours the design's generator draws from. */
const BEHAVIOURS = ['ok', 'timeout', 'rateLimit', 'schemaViolation', 'transport'] as const;

type Behaviour = (typeof BEHAVIOURS)[number];

/** The failure code each failing behaviour reports; `ok` answers instead of failing. */
const FAILURE_CODE: Readonly<Record<Exclude<Behaviour, 'ok'>, RelevanceFailureCode>> = {
  timeout: 'TIMEOUT',
  rateLimit: 'RATE_LIMIT',
  schemaViolation: 'SCHEMA_VIOLATION',
  transport: 'TRANSPORT',
};

/**
 * Attempts one behaviour costs, per 15.11 and 15.12.
 *
 * Stated here rather than derived from `RELEVANCE_RETRIABLE_FAILURE_CODES`, so that a code which
 * silently became retriable — or stopped being — fails this property instead of being blessed by it.
 */
const EXPECTED_ATTEMPTS: Readonly<Record<Behaviour, number>> = {
  ok: 1,
  timeout: RELEVANCE_MAX_ATTEMPTS,
  rateLimit: RELEVANCE_MAX_ATTEMPTS,
  transport: RELEVANCE_MAX_ATTEMPTS,
  schemaViolation: 1,
};

/** Whether the Relevance_Service is asked at all, and if not, which cause of 15.10 switched it off. */
const ACTIVATIONS = ['ACTIVATED', 'SWITCHED_OFF', 'NO_API_KEY'] as const;

type Activation = (typeof ACTIVATIONS)[number];

/** What one Job_Posting of a generated batch is and what the AI_Provider does for it. */
interface CandidatePlan {
  readonly behaviour: Behaviour;
  /** The verdict a usable answer carries, drawn from the permitted value list (15.3, 15.12). */
  readonly verdict: AssessedRelevanceVerdict;
}

/** One generated Scrape_Run's relevance batch. */
interface BatchPlan {
  readonly candidates: readonly CandidatePlan[];
  /** `RELEVANCE_MAX_PER_RUN` of this run, from 0 to the candidate count (15.7). */
  readonly budget: number;
  readonly activation: Activation;
}

const candidatePlanArbitrary = fc.record<CandidatePlan>({
  behaviour: fc.constantFrom(...BEHAVIOURS),
  verdict: fc.constantFrom(...ASSESSED_RELEVANCE_VERDICTS),
});

/**
 * A batch of at most eight candidates with a budget somewhere inside it.
 *
 * Eight keeps a run of 100 iterations fast while leaving room for a budget that binds in the middle
 * of a mixture; the budget is drawn after the candidates so it stays within the count the design
 * names.
 */
const batchPlanArbitrary: fc.Arbitrary<BatchPlan> = fc
  .array(candidatePlanArbitrary, { maxLength: 8 })
  .chain((candidates) =>
    fc.record<BatchPlan>({
      candidates: fc.constant(candidates),
      budget: fc.nat({ max: candidates.length }),
      activation: fc.constantFrom(...ACTIVATIONS),
    }),
  );

/** `JobPosting.id` of the candidate at one position of the batch. */
const postingIdOf = (index: number): string => `p-${String(index)}`;

/**
 * The title of the candidate at one position, unique within a batch.
 *
 * It is what the stub recognises a candidate by: 15.2 transmits no identifier, so the title is the
 * only thing that correlates a request with the row it is about — and that is what the budget bound
 * of 15.7 is counted over.
 */
const titleOf = (index: number): string => `Stelle ${String(index)} (m/w/d)`;

/** The candidates in the selection order the budget is allocated in (15.7). */
const itemsOf = (plan: BatchPlan): readonly RelevanceBatchItem[] =>
  plan.candidates.map((_candidate, index) => ({
    postingId: postingIdOf(index),
    request: {
      title: titleOf(index),
      employer: 'Klinikum München',
      workLocation: 'München',
      publishedAt: new Date('2026-03-02T07:30:00.000Z'),
      descriptionText: 'Wir suchen eine Pflegefachkraft in Festanstellung.',
      profile: PROFILE,
    } satisfies RelevanceRequest,
  }));

/** The configuration as the service reads it; only the four relevance values matter. */
const envOf = (plan: BatchPlan): EnvConfig =>
  ({
    relevanceEnabled: plan.activation !== 'SWITCHED_OFF',
    anthropicApiKey: plan.activation === 'NO_API_KEY' ? '' : 'sk-ant-test-key',
    relevanceMaxPerRun: plan.budget,
    relevanceConcurrency: 4,
  }) as unknown as EnvConfig;

/** The AI_Provider as the plan states it, with the Job_Posting it was asked about recorded. */
interface AssessorStub {
  readonly assessor: RelevanceAssessor;
  /** The titles of every `assess` call, in the order they were made, repetitions included. */
  readonly calls: readonly string[];
}

const stubAssessor = (plan: BatchPlan): AssessorStub => {
  const byTitle = new Map(
    plan.candidates.map((candidate, index) => [titleOf(index), candidate] as const),
  );
  const calls: string[] = [];

  return {
    calls,
    assessor: {
      model: MODEL,
      assess: (request: RelevanceRequest): Promise<RelevanceOutcome> => {
        calls.push(request.title);

        const candidate = byTitle.get(request.title);

        if (candidate === undefined) {
          throw new Error(`The stub was asked about an unknown Job_Posting: ${request.title}`);
        }

        if (candidate.behaviour === 'ok') {
          return Promise.resolve({
            kind: 'ASSESSED',
            response: {
              verdict: candidate.verdict,
              reason: 'Fachgebiet und Seniorität passen zum Suchprofil.',
            },
            model: MODEL,
          });
        }

        return Promise.resolve({ kind: 'FAILED', code: FAILURE_CODE[candidate.behaviour] });
      },
    },
  };
};

/** What one generated batch produced: every delivery, in order, plus the report and the calls. */
interface BatchRun {
  readonly deliveries: readonly (readonly [string, RelevanceAssessment])[];
  readonly report: RelevanceBatchReport;
  readonly calls: readonly string[];
}

/**
 * Runs one generated batch to its end under fake timers.
 *
 * The backoff intervals of 15.11 are the service's own `setTimeout`, so draining the timers is what
 * turns three real waits of up to five seconds per failing candidate into an instant batch. The
 * batch is started before the drain because its timers do not exist until the first attempt failed.
 */
const runBatch = async (plan: BatchPlan): Promise<BatchRun> => {
  const { assessor, calls } = stubAssessor(plan);
  const service = new RelevanceService(envOf(plan), assessor);
  const deliveries: (readonly [string, RelevanceAssessment])[] = [];

  const pending = service.assessAll({
    items: itemsOf(plan),
    signal: new AbortController().signal,
    onResult: (postingId, assessment) => {
      deliveries.push([postingId, assessment]);
    },
  });

  await vi.runAllTimersAsync();

  return { deliveries, report: await pending, calls };
};

/** The cause a candidate at one position has to end at, or `null` where it is assessed. */
const expectedCauseOf = (plan: BatchPlan, index: number): RelevanceNotAssessedCause | null => {
  if (plan.activation !== 'ACTIVATED') {
    // 15.10: no request at all, one shared verdict for every candidate.
    return 'DISABLED';
  }

  if (index >= plan.budget) {
    // 15.7: the budget is allocated by position before anything is sent.
    return 'BUDGET_REACHED';
  }

  const behaviour = plan.candidates[index]?.behaviour;

  if (behaviour === 'ok') {
    return null;
  }

  // 15.12 discards an unusable answer without a repetition; 15.11 ends an exhausted retry chain.
  return behaviour === 'schemaViolation' ? 'SCHEMA_VIOLATION' : 'REQUEST_FAILED';
};

beforeAll(() => {
  // The service reports a refused result through the Nest logger; nothing here refuses one, and a
  // quiet output is what makes a real failure readable.
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Property 20: Every Job_Posting carries exactly one Relevance_Verdict', () => {
  /**
   * **Validates: Requirements 15.1, 15.7, 15.10, 15.11**
   *
   * For all AI_Provider behaviours — an absent API key, a deactivated Relevance_Service, timeouts,
   * rate limits, schema violations, transport errors and a binding run budget — every Job_Posting of
   * the batch is reported exactly once and ends with exactly one Relevance_Verdict from
   * `RELEVANCE_VERDICTS`; a Job_Posting the AI_Provider answered for carries that answer's verdict
   * together with the model name and the assessment time (15.1), while a Job_Posting beyond the
   * budget, one whose permitted attempts all failed, one whose answer was discarded and every
   * Job_Posting of a deactivated service carry `NOT_ASSESSED` (15.7, 15.10, 15.11, 15.12); and the
   * number of Job_Posting an assessment was requested for never exceeds the configured run budget
   * and is zero while the service is deactivated.
   */
  it('ends every Job_Posting at exactly one verdict for every mixture of provider behaviours', async () => {
    vi.useFakeTimers();

    await fc.assert(
      fc.asyncProperty(batchPlanArbitrary, async (plan) => {
        const { deliveries, report, calls } = await runBatch(plan);
        const count = plan.candidates.length;

        // Exactly one delivery per candidate: none dropped, none reported twice. Nothing in this
        // generator cancels the run or refuses a result, so the whole batch is accounted for.
        expect(deliveries).toHaveLength(count);
        expect(new Set(deliveries.map(([postingId]) => postingId)).size).toBe(count);
        expect(report.considered).toBe(count);
        expect(report.outstanding).toBe(0);
        expect(report.deliveryFailures).toBe(0);

        // The report invariant that makes "exactly one verdict per Job_Posting" countable (15.14).
        expect(
          report.assessed + report.notAssessed + report.outstanding + report.deliveryFailures,
        ).toBe(report.considered);

        const byPostingId = new Map(deliveries);

        for (let index = 0; index < count; index += 1) {
          const assessment = byPostingId.get(postingIdOf(index));

          if (assessment === undefined) {
            throw new Error(`No assessment for Job_Posting ${postingIdOf(index)}`);
          }

          const expectedCause = expectedCauseOf(plan, index);
          const candidate = plan.candidates[index];
          // The six columns the Posting_Store write is fed with (task 14.4).
          const row = persistedRelevanceResultOf(assessment, CONTENT_HASH);

          // Exactly one verdict, from the permitted value list, on every row.
          expect(RELEVANCE_VERDICTS).toContain(row.relevanceVerdict);
          expect(row.relevanceVerdict).not.toBeNull();
          expect(row.relevanceRank).toBe(RELEVANCE_RANK[row.relevanceVerdict]);

          if (expectedCause === null) {
            // 15.1: the verdict the AI_Provider answered with, plus model name and assessment time.
            expect(assessment).toMatchObject({
              kind: 'ASSESSED',
              verdict: candidate?.verdict,
              model: MODEL,
              attempts: EXPECTED_ATTEMPTS.ok,
            });
            expect(row.relevanceVerdict).toBe(candidate?.verdict);
            expect(row.relevanceModel).toBe(MODEL);
            expect(row.relevanceAssessedAt).toBeInstanceOf(Date);
            expect(row.relevanceContentHash).toBe(CONTENT_HASH);

            continue;
          }

          // 15.7, 15.10, 15.11, 15.12: everything else ends at `NOT_ASSESSED`, with the attempts the
          // cause permits and without a stored model, time or content hash.
          expect(assessment).toMatchObject({ kind: 'NOT_ASSESSED', cause: expectedCause });
          expect(row.relevanceVerdict).toBe('NOT_ASSESSED');
          expect(row.relevanceModel).toBeNull();
          expect(row.relevanceAssessedAt).toBeNull();
          expect(row.relevanceContentHash).toBeNull();

          const attempts =
            expectedCause === 'DISABLED' || expectedCause === 'BUDGET_REACHED'
              ? 0
              : EXPECTED_ATTEMPTS[candidate?.behaviour ?? 'ok'];

          expect(assessment.attempts).toBe(attempts);

          // A cause about this one Job_Posting carries the German note of 15.11 and 15.12; a cause
          // reported once per run carries none. Either way at most 300 characters (15.3).
          if (expectedCause === 'DISABLED' || expectedCause === 'BUDGET_REACHED') {
            expect(row.relevanceReason).toBeNull();
          } else {
            expect(row.relevanceReason ?? '').not.toBe('');
            expect((row.relevanceReason ?? '').length).toBeLessThanOrEqual(300);
          }
        }

        // 15.7: assessments are bounded by the run budget, counted over distinct Job_Posting,
        // because a repetition of 15.11 is the same assessment asked again. 15.10: a deactivated
        // service asks about nobody.
        const askedAbout = new Set(calls);
        const expectedRequested = plan.activation === 'ACTIVATED' ? plan.budget : 0;

        expect(askedAbout.size).toBe(expectedRequested);
        expect(askedAbout.size).toBeLessThanOrEqual(Math.min(count, plan.budget));
        expect(report.requested).toBe(expectedRequested);
        expect(report.notAssessed + report.assessed).toBe(count);
        expect(report.skippedByBudget).toBe(
          plan.activation === 'ACTIVATED' ? count - plan.budget : 0,
        );
      }),
      PROPERTY_RUNS,
    );
  });
});
