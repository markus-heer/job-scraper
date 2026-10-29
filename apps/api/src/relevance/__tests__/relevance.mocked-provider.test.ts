/**
 * The Relevance_Service over the *real* `AnthropicRelevanceAssessor` with a mocked AI_Provider
 * (task 14.10).
 *
 * The suites next to this one each drive one layer: `./anthropic-relevance.assessor.test.ts` asserts
 * one request and one answer, `./relevance.service.test.ts` asserts the retry chain, the budget and
 * the concurrency over a stubbed assessor, and `./relevance.module.test.ts` asserts which assessor
 * the object graph binds. What none of them covers is the three cases of 14.10 that only exist where
 * the service and the provider meet, and those are what this file asserts:
 *
 * - **A request that never answers.** The service repeats a failed request, so a provider that
 *   neither answers nor fails must not produce a second one and must not leave the enrichment stage
 *   hanging. The caller's abort is the only thing that may end it (15.11).
 * - **Two rate limits then an answer.** 429 and 529 are retriable at the HTTP level, and the verdict
 *   of the third attempt is the one that gets stored — three requests in total and never a fourth,
 *   which is what bounds what one Job_Posting may cost at a paid provider (15.11).
 * - **A deactivated service that constructs no client.** 15.10 promises that no key means no
 *   request. Asserted on the booted object graph with the HTTP port bound and counted, so "zero
 *   requests" is a statement about the whole wired graph rather than about one class; an activated
 *   boot over the same binding proves the counter is not vacuous.
 *
 * Everything is offline: the HTTP port of the assessor answers from this file, so no paid request is
 * ever sent. The one real request lives in `./anthropic-relevance.live.smoke.test.ts` behind an
 * opt-in.
 *
 * `vi.useFakeTimers()` drives the service's backoff intervals of 15.11. It deliberately does *not*
 * drive the 30-second per-request bound of the same requirement: that bound is an
 * `AbortSignal.timeout` inside the assessor, which runs on the platform clock no fake timer patches.
 * The never-answering request is therefore ended by a real `AbortController`, which is also what a
 * cancelled Scrape_Run does to it in production (12.7).
 *
 * Requirements: 15.2, 15.3, 15.7, 15.8, 15.10, 15.11, 15.12.
 */

import type { EffectiveSearchProfile } from '@job-scraper/domain';
import { Global, type INestApplicationContext, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ENV_CONFIG } from '../../config/env.config';
import type { EnvConfig } from '../../config/env.schema';
import { PlatformConfigurationService } from '../../platform-config/platform-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ANTHROPIC_FETCH,
  ANTHROPIC_VERSION,
  type AnthropicFetch,
  AnthropicRelevanceAssessor,
} from '../anthropic-relevance.assessor';
import { ANTHROPIC_TOOL_NAME } from '../anthropic-relevance.schema';
import { NoopRelevanceAssessor } from '../noop-relevance.assessor';
import { RelevanceModule } from '../relevance.module';
import {
  type RelevanceAssessment,
  type RelevanceBatchItem,
  type RelevanceBatchReport,
  RelevanceService,
} from '../relevance.service';
import {
  RELEVANCE_ASSESSOR,
  RELEVANCE_MAX_ATTEMPTS,
  RELEVANCE_REASON_MAX_LENGTH,
  RELEVANCE_RETRY_BACKOFF_MS,
  type RelevanceRequest,
  truncateDescription,
} from '../relevance-assessor.port';

/** The key under test. A failing assertion that prints it prints this string, not a real secret. */
const API_KEY = 'sk-ant-test-key-1470';

/** The configured model alias. */
const MODEL = 'claude-sonnet-4-5';

/** The dated snapshot the provider reports as the model that answered (15.1). */
const ANSWERING_MODEL = 'claude-sonnet-4-5-20250929';

const PROFILE: EffectiveSearchProfile = {
  platform: 'STEPSTONE',
  criteria: [
    { field: 'jobTitle', value: 'Pflegefachkraft', provenance: 'DEFAULT' },
    { field: 'searchLocation', value: 'München', provenance: 'OVERRIDE' },
  ],
};

/** What is transmitted for one Job_Posting (15.2). */
const requestFor = (title: string): RelevanceRequest => ({
  title,
  employer: 'Klinikum München',
  workLocation: 'München',
  publishedAt: new Date('2026-03-02T07:30:00.000Z'),
  descriptionText: truncateDescription('Wir suchen eine Pflegefachkraft in Festanstellung.'),
  profile: PROFILE,
});

const REQUEST = requestFor('Pflegefachkraft (m/w/d)');

/** The configuration as the service and the assessor read it. */
const envWith = (overrides: Partial<EnvConfig> = {}): EnvConfig =>
  ({
    relevanceEnabled: true,
    anthropicApiKey: API_KEY,
    anthropicModel: MODEL,
    relevanceMaxPerRun: 200,
    relevanceConcurrency: 4,
    ...overrides,
  }) as unknown as EnvConfig;

/** A JSON response, as `fetch` would deliver it. */
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A Messages API answer carrying one `report_relevance` tool call. */
const toolCallBody = (
  verdict: string,
  reason: string,
  model: string = ANSWERING_MODEL,
): unknown => ({
  id: 'msg_01',
  type: 'message',
  role: 'assistant',
  model,
  stop_reason: 'tool_use',
  content: [
    { type: 'tool_use', id: 'toolu_01', name: ANTHROPIC_TOOL_NAME, input: { verdict, reason } },
  ],
  usage: { input_tokens: 700, output_tokens: 60 },
});

/** The answer every provider stub in this file gives once it is willing to answer. */
const USABLE_ANSWER = {
  verdict: 'RELEVANT',
  reason: 'Fachgebiet und Arbeitsort passen zum Suchprofil.',
} as const;

/** One recorded HTTP request. */
interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A counted HTTP port that answers from a list of responses, one per attempt. */
interface FetchStub {
  readonly http: AnthropicFetch;
  readonly calls: readonly Call[];
}

/**
 * An HTTP port that answers the *n*-th request with the *n*-th entry of `answers`.
 *
 * A request beyond the list is a test bug rather than a provider behaviour, so it rejects with a
 * named error instead of quietly answering again: "never a fourth request" is one of the things
 * this file asserts.
 */
const answeringFetch = (answers: readonly (() => Response)[]): FetchStub => {
  const calls: Call[] = [];

  return {
    calls,
    http: (url, init) => {
      const answer = answers[calls.length];

      calls.push({ url, init });

      if (answer === undefined) {
        return Promise.reject(new Error(`unexpected request ${String(calls.length)}`));
      }

      return Promise.resolve(answer());
    },
  };
};

/**
 * An HTTP port that never answers until the signal it was handed fires.
 *
 * What a hanging provider looks like to `fetch`: the promise stays pending, and an abort rejects it
 * with an `AbortError`. Both the assessor's own 30-second bound and the caller's cancellation reach
 * it through that one signal.
 */
const hangingFetch = (): FetchStub => {
  const calls: Call[] = [];

  return {
    calls,
    http: (url, init) => {
      calls.push({ url, init });

      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        const abort = (): void => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        };

        if (signal == null) {
          return;
        }

        if (signal.aborted) {
          abort();

          return;
        }

        signal.addEventListener('abort', abort, { once: true });
      });
    },
  };
};

/** The service over the real assessor, with the mocked provider behind it. */
const serviceWith = (stub: FetchStub, env: EnvConfig = envWith()): RelevanceService =>
  new RelevanceService(env, new AnthropicRelevanceAssessor(env, stub.http));

/** `count` candidates, named `p-0`, `p-1`, ... in the selection order of 15.7. */
const candidates = (count: number): readonly RelevanceBatchItem[] =>
  Array.from({ length: count }, (_unused, index) => ({
    postingId: `p-${String(index)}`,
    request: requestFor(`Stelle ${String(index)}`),
  }));

/** One batch run: what the sink received per Job_Posting, and what the service reported. */
const runBatch = async (
  service: RelevanceService,
  items: readonly RelevanceBatchItem[],
  signal: AbortSignal,
): Promise<{
  readonly assessments: ReadonlyMap<string, RelevanceAssessment>;
  readonly report: RelevanceBatchReport;
}> => {
  const assessments = new Map<string, RelevanceAssessment>();
  const report = await service.assessAll({
    items,
    signal,
    onResult: (postingId, assessment) => {
      assessments.set(postingId, assessment);
    },
  });

  return { assessments, report };
};

/** A promise plus whether it has settled, for asserting that a request is still in flight. */
const watch = <T>(
  promise: Promise<T>,
): { readonly settled: () => boolean; readonly value: Promise<T> } => {
  let settled = false;

  return {
    settled: () => settled,
    value: promise.then((value) => {
      settled = true;

      return value;
    }),
  };
};

/** The total backoff of a Job_Posting that used every permitted attempt (15.11). */
const TOTAL_BACKOFF_MS = RELEVANCE_RETRY_BACKOFF_MS.reduce((total, step) => total + step, 0);

beforeAll(() => {
  // Every failure is reported through the Nest logger; a quiet test output is what makes a real
  // failure readable.
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a provider request that never answers (15.11)', () => {
  it('stays one request while the backoff clock runs and reports TIMEOUT on the caller abort', async () => {
    vi.useFakeTimers();

    const stub = hangingFetch();
    const assessor = new AnthropicRelevanceAssessor(envWith(), stub.http);
    const controller = new AbortController();
    const pending = watch(assessor.assess(REQUEST, controller.signal));

    // Well past the 30-second bound of 15.11 on the fake clock: that bound is an
    // `AbortSignal.timeout` on the platform clock, so a fake timer cannot end this request. What is
    // asserted here is the consequence — nothing times out, nothing is retried, one request stands.
    await vi.advanceTimersByTimeAsync(10 * 30_000);

    expect(pending.settled()).toBe(false);
    expect(stub.calls).toHaveLength(1);

    controller.abort();

    await expect(pending.value).resolves.toEqual({ kind: 'FAILED', code: 'TIMEOUT' });
    expect(stub.calls).toHaveLength(1);
  });

  it('opens no second attempt while the first is in flight, and ends the chain as cancelled', async () => {
    vi.useFakeTimers();

    const stub = hangingFetch();
    const service = serviceWith(stub);
    const controller = new AbortController();
    const pending = watch(service.assess(REQUEST, controller.signal));

    await vi.advanceTimersByTimeAsync(TOTAL_BACKOFF_MS * 10);

    // The retry chain of 15.11 waits for an outcome; a request that produces none costs one attempt
    // and not three, however much time passes.
    expect(stub.calls).toHaveLength(1);
    expect(pending.settled()).toBe(false);

    controller.abort();

    // A cancelled Job_Posting is not a failed assessment: its columns stay untouched and the next
    // Scrape_Run asks again.
    await expect(pending.value).resolves.toMatchObject({
      kind: 'NOT_ASSESSED',
      cause: 'CANCELLED',
      reasonDe: null,
      attempts: 1,
    });
    expect(stub.calls).toHaveLength(1);
  });

  it('spends no request on the candidates a cancelled batch had not started (15.8)', async () => {
    const stub = hangingFetch();
    const service = serviceWith(stub, envWith({ relevanceConcurrency: 2 }));
    const controller = new AbortController();
    const pending = runBatch(service, candidates(5), controller.signal);

    // One macrotask is enough for the two permitted requests to be in flight; the other three
    // candidates are queued behind the concurrency bound.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stub.calls).toHaveLength(2);

    controller.abort();

    const { report, assessments } = await pending;

    expect(assessments.size).toBe(0);
    expect(report).toMatchObject({
      considered: 5,
      // The two in-flight candidates cost one request each before the abort reached them; the three
      // queued ones cost none, which is the number that matters at a paid provider.
      requested: 2,
      assessed: 0,
      notAssessed: 0,
      outstanding: 5,
      deliveryFailures: 0,
    });
    // The three queued candidates never reached the provider: a cancelled Scrape_Run costs nothing
    // beyond what was already in flight.
    expect(stub.calls).toHaveLength(2);
  });
});

describe('two rate limits then an answer (15.11)', () => {
  it('stores the verdict of the third attempt after a 429 and a 529', async () => {
    vi.useFakeTimers();

    const stub = answeringFetch([
      () => jsonResponse({ type: 'error', error: { type: 'rate_limit_error' } }, 429),
      () => jsonResponse({ type: 'error', error: { type: 'overloaded_error' } }, 529),
      () => jsonResponse(toolCallBody(USABLE_ANSWER.verdict, USABLE_ANSWER.reason)),
    ]);
    const service = serviceWith(stub);
    const pending = service.assess(REQUEST, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(TOTAL_BACKOFF_MS);

    await expect(pending).resolves.toMatchObject({
      kind: 'ASSESSED',
      verdict: USABLE_ANSWER.verdict,
      reasonDe: USABLE_ANSWER.reason,
      // The model that answered, not the configured alias (15.1).
      model: ANSWERING_MODEL,
      attempts: RELEVANCE_MAX_ATTEMPTS,
    });
    expect(stub.calls).toHaveLength(RELEVANCE_MAX_ATTEMPTS);
  });

  it('repeats the same request unchanged, key and version header included (14.9)', async () => {
    vi.useFakeTimers();

    const stub = answeringFetch([
      () => jsonResponse({ type: 'error', error: { type: 'rate_limit_error' } }, 429),
      () => jsonResponse({ type: 'error', error: { type: 'rate_limit_error' } }, 429),
      () => jsonResponse(toolCallBody(USABLE_ANSWER.verdict, USABLE_ANSWER.reason)),
    ]);
    const service = serviceWith(stub);
    const pending = service.assess(REQUEST, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(TOTAL_BACKOFF_MS);
    await pending;

    const bodies = stub.calls.map((call) => String(call.init.body));
    const keys = stub.calls.map((call) => new Headers(call.init.headers).get('x-api-key'));
    const versions = stub.calls.map((call) =>
      new Headers(call.init.headers).get('anthropic-version'),
    );

    // A repetition of 15.11 is the same question asked again: a differing body would mean the
    // retried assessment judged something else than the first attempt did.
    expect(new Set(bodies).size).toBe(1);
    expect(keys).toEqual([API_KEY, API_KEY, API_KEY]);
    expect(versions).toEqual([ANTHROPIC_VERSION, ANTHROPIC_VERSION, ANTHROPIC_VERSION]);
    expect(stub.calls.every((call) => !call.url.includes(API_KEY))).toBe(true);
  });

  it('gives up after the third rate limit with a German note and sends no fourth request', async () => {
    vi.useFakeTimers();

    const rateLimited = (): Response =>
      jsonResponse({ type: 'error', error: { type: 'rate_limit_error' } }, 429);
    const stub = answeringFetch([rateLimited, rateLimited, rateLimited]);
    const service = serviceWith(stub);
    const pending = service.assess(REQUEST, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(TOTAL_BACKOFF_MS);

    const assessment = await pending;

    expect(assessment).toMatchObject({
      kind: 'NOT_ASSESSED',
      cause: 'REQUEST_FAILED',
      failureCode: 'RATE_LIMIT',
      attempts: RELEVANCE_MAX_ATTEMPTS,
    });

    const reasonDe = assessment.kind === 'NOT_ASSESSED' ? (assessment.reasonDe ?? '') : '';

    expect(reasonDe.length).toBeGreaterThan(0);
    expect(reasonDe.length).toBeLessThanOrEqual(RELEVANCE_REASON_MAX_LENGTH);
    // The provider is paid per request: three attempts per Job_Posting is the whole budget 15.11
    // allows, and the stub rejects a fourth rather than answering it.
    expect(stub.calls).toHaveLength(RELEVANCE_MAX_ATTEMPTS);
  });
});

describe('the deactivated Relevance_Service constructs no AI_Provider client (15.9, 15.10)', () => {
  let context: INestApplicationContext | undefined;

  /**
   * Boots `RelevanceModule` over one configuration with the HTTP port bound and counted.
   *
   * `@Global` for the three providers the module takes through their tokens, exactly as the
   * application declares them, plus `ANTHROPIC_FETCH` — which the module's factory forwards into the
   * assessor and which therefore records every request the booted graph would send. No environment
   * file, no database and no network are involved.
   */
  const bootWith = async (env: EnvConfig, stub: FetchStub): Promise<INestApplicationContext> => {
    @Global()
    @Module({
      providers: [
        { provide: ENV_CONFIG, useValue: env },
        { provide: PrismaService, useValue: {} },
        { provide: PlatformConfigurationService, useValue: { effectiveProfileOf: () => null } },
        { provide: ANTHROPIC_FETCH, useValue: stub.http },
      ],
      exports: [ENV_CONFIG, PrismaService, PlatformConfigurationService, ANTHROPIC_FETCH],
    })
    class StubInfrastructureModule {}

    @Module({ imports: [StubInfrastructureModule, RelevanceModule] })
    class RootModule {}

    context = await NestFactory.createApplicationContext(RootModule, { logger: false });

    return context;
  };

  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  it('sends no request for any Job_Posting when no API key is configured', async () => {
    const stub = answeringFetch([
      () => jsonResponse(toolCallBody(USABLE_ANSWER.verdict, USABLE_ANSWER.reason)),
    ]);
    const app = await bootWith(envWith({ anthropicApiKey: '' }), stub);
    const assessor = app.get(RELEVANCE_ASSESSOR, { strict: false });

    // No `AnthropicRelevanceAssessor` is constructed at all, so there is no object in the process
    // that could send a request or read the credential into one (14.9).
    expect(assessor).toBeInstanceOf(NoopRelevanceAssessor);
    expect(assessor).not.toBeInstanceOf(AnthropicRelevanceAssessor);

    const { report, assessments } = await runBatch(
      app.get(RelevanceService, { strict: false }),
      candidates(3),
      new AbortController().signal,
    );

    expect(stub.calls).toHaveLength(0);
    expect(report).toMatchObject({ considered: 3, requested: 0, assessed: 0, notAssessed: 3 });
    expect([...assessments.values()].map((assessment) => assessment.kind)).toEqual([
      'NOT_ASSESSED',
      'NOT_ASSESSED',
      'NOT_ASSESSED',
    ]);
    expect(assessments.get('p-0')).toMatchObject({ cause: 'DISABLED', attempts: 0 });
  });

  it('sends no request when the switch deactivates the service, key or no key', async () => {
    const stub = answeringFetch([
      () => jsonResponse(toolCallBody(USABLE_ANSWER.verdict, USABLE_ANSWER.reason)),
    ]);
    const app = await bootWith(envWith({ relevanceEnabled: false }), stub);

    expect(app.get(RELEVANCE_ASSESSOR, { strict: false })).toBeInstanceOf(NoopRelevanceAssessor);

    const { report } = await runBatch(
      app.get(RelevanceService, { strict: false }),
      candidates(2),
      new AbortController().signal,
    );

    expect(stub.calls).toHaveLength(0);
    expect(report).toMatchObject({ considered: 2, requested: 0, notAssessed: 2 });
  });

  it('reaches the provider through the same binding once the service is activated', async () => {
    const answer = (): Response =>
      jsonResponse(toolCallBody(USABLE_ANSWER.verdict, USABLE_ANSWER.reason));
    const stub = answeringFetch([answer, answer]);
    const app = await bootWith(envWith(), stub);

    expect(app.get(RELEVANCE_ASSESSOR, { strict: false })).toBeInstanceOf(
      AnthropicRelevanceAssessor,
    );

    const { report, assessments } = await runBatch(
      app.get(RelevanceService, { strict: false }),
      candidates(2),
      new AbortController().signal,
    );

    // The control for the two tests above: the counter they assert zero on does count when a request
    // is sent, so "no request" is a property of the deactivated graph and not of this binding.
    expect(stub.calls).toHaveLength(2);
    expect(report).toMatchObject({ considered: 2, requested: 2, assessed: 2, notAssessed: 0 });
    expect(assessments.get('p-1')).toMatchObject({
      kind: 'ASSESSED',
      verdict: USABLE_ANSWER.verdict,
      model: ANSWERING_MODEL,
      attempts: 1,
    });
  });
});
