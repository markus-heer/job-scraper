/**
 * What the relevance enrichment stage of a Scrape_Run selects, writes and reports (15.1, 15.5,
 * 15.6, 15.11, 15.12, 15.15).
 *
 * The AI_Provider is a stub and the Posting_Store is the in-memory delegate of
 * `./relevance-store.fixture.ts`, so the suite is offline, free and deterministic. Everything else
 * is real: the stage drives the real `RelevanceService` and writes through the real
 * `PostingRepository`, which is the point — the counted outcomes, the stored columns and the
 * Log_Stream lines cannot drift apart in a test either.
 *
 * What this suite is about is task 14.4 and nothing else:
 *
 * - **The content hash gate.** Which Job_Posting cost an AI_Provider request: never one with a
 *   manual verdict (15.15), never one whose stored assessment covers the current content (15.5),
 *   always one whose content changed or was never assessed (15.6). The generated cases are
 *   Property 21 (task 14.9).
 * - **The write.** All six relevance columns in one statement, including the denormalized rank of
 *   10.7, and `relevanceContentHash` set only by an assessment that happened — so a failed one is
 *   requested again in the next Scrape_Run.
 * - **The two per-Job_Posting lines.** `relevance.requestFailed` and `relevance.schemaViolation`,
 *   and no line at all for the causes that are about the whole run.
 * - **The window and the containment.** A cancelled Scrape_Run, a closed grace window, a rejected
 *   write and a rejected candidate query.
 *
 * Several cases pin `RELEVANCE_CONCURRENCY` to 1. The bound itself is
 * `./relevance.service.test.ts`'s subject; here it would only make the order of the writes depend
 * on how fast a stub resolves, and the order is what some of these assertions are about.
 *
 * The retry chain, the budget and the concurrency bound are `./relevance.service.test.ts`; the
 * end-of-run counters and the budget line are task 14.5.
 *
 * Requirements: 15.1, 15.5, 15.6, 15.11, 15.12, 15.13, 15.15.
 */

import { type EffectiveSearchProfile, RELEVANCE_RANK } from '@job-scraper/domain';
import { Logger } from '@nestjs/common';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { EnvConfig } from '../../config/env.schema';
import type { LogMessagePayload } from '../../log-stream/log-stream.service';
import { PostingRepository } from '../../posting/posting.repository';
import type { LogMessage } from '../../prisma/prisma.types';
import { RelevanceService } from '../relevance.service';
import {
  RELEVANCE_DESCRIPTION_MAX_LENGTH,
  type RelevanceAssessor,
  type RelevanceFailureCode,
  type RelevanceOutcome,
  type RelevanceRequest,
} from '../relevance-assessor.port';
import {
  type RelevanceEnrichmentLog,
  type RelevanceEnrichmentReport,
  RelevanceEnrichmentService,
  type RelevanceProfileSource,
} from '../relevance-enrichment.service';
import {
  createRelevanceStore,
  type RelevanceStoreFixture,
  type SeedPosting,
} from './relevance-store.fixture';

/** The Scrape_Run the stage runs in; its start time is the `lastSeenAt` of its candidates (9.3). */
const RUN_ID = 'run-1';
const RUN_STARTED_AT = new Date('2026-03-02T08:00:00.000Z');

/** The model the stub reports as the one that answered. */
const MODEL = 'claude-sonnet-4-5-20250929';

/** The German reason the stub answers with; at most 300 characters, as 15.3 requires. */
const REASON_DE = 'Fachgebiet und Seniorität passen zum Suchprofil.';

const PROFILE: EffectiveSearchProfile = {
  platform: 'STEPSTONE',
  criteria: [{ field: 'jobTitle', value: 'Pflegefachkraft', provenance: 'DEFAULT' }],
};

/** The configuration as the Relevance_Service reads it; only the four relevance values matter. */
const envWith = (overrides: Partial<EnvConfig> = {}): EnvConfig =>
  ({
    relevanceEnabled: true,
    anthropicApiKey: 'sk-ant-test-key',
    relevanceMaxPerRun: 200,
    relevanceConcurrency: 4,
    ...overrides,
  }) as unknown as EnvConfig;

/** A usable AI_Provider answer. */
const assessedOutcome = (
  verdict: 'RELEVANT' | 'NOT_RELEVANT' | 'UNCERTAIN' = 'RELEVANT',
): RelevanceOutcome => ({
  kind: 'ASSESSED',
  response: { verdict, reason: REASON_DE },
  model: MODEL,
});

const failedWith = (code: RelevanceFailureCode): RelevanceOutcome => ({ kind: 'FAILED', code });

/** The AI_Provider as a test states it, with what it was asked recorded. */
interface AssessorStub {
  readonly assessor: RelevanceAssessor;
  readonly calls: readonly RelevanceRequest[];
  /** The title of every request, in the order the stage spent them. */
  titles(): readonly string[];
}

const stubAssessor = (
  answer: (request: RelevanceRequest, call: number) => RelevanceOutcome,
): AssessorStub => {
  const calls: RelevanceRequest[] = [];

  return {
    calls,
    titles: () => calls.map((request) => request.title),
    assessor: {
      model: MODEL,
      assess: (request: RelevanceRequest): Promise<RelevanceOutcome> => {
        const call = calls.push(request);

        return Promise.resolve(answer(request, call));
      },
    },
  };
};

/** Records every Log_Stream message of the stage, and optionally refuses them all. */
interface LogRecorder {
  readonly log: RelevanceEnrichmentLog;
  readonly messages: readonly LogMessagePayload[];
  codes(): readonly string[];
}

const createLogRecorder = (rejectWith?: unknown): LogRecorder => {
  const messages: LogMessagePayload[] = [];

  const log: RelevanceEnrichmentLog = {
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

/** Every Platform resolves to one profile; an absent one is a case of its own below. */
const profiles = (effective: EffectiveSearchProfile | null = PROFILE): RelevanceProfileSource => ({
  effectiveProfileOf: () => effective,
});

interface Harness {
  readonly fixture: RelevanceStoreFixture;
  readonly stage: RelevanceEnrichmentService;
  readonly log: LogRecorder;
  readonly assessor: AssessorStub;
}

/** The stage with a stubbed AI_Provider, the real Relevance_Service and the real write path. */
const harness = (
  answer: (request: RelevanceRequest, call: number) => RelevanceOutcome,
  options: {
    readonly env?: Partial<EnvConfig>;
    readonly log?: LogRecorder;
    readonly profileSource?: RelevanceProfileSource;
  } = {},
): Harness => {
  const fixture = createRelevanceStore();
  const assessor = stubAssessor(answer);
  const log = options.log ?? createLogRecorder();
  const stage = new RelevanceEnrichmentService(
    fixture.store,
    new RelevanceService(envWith(options.env), assessor.assessor),
    new PostingRepository(fixture.store),
    log.log,
    options.profileSource ?? profiles(),
  );

  return { fixture, stage, log, assessor };
};

/** A Job_Posting as the retrieval phase of this Scrape_Run left it. */
const seed = (
  fixture: RelevanceStoreFixture,
  id: string,
  overrides: Partial<SeedPosting> = {},
): void => {
  fixture.seedPosting({
    id,
    title: id,
    employer: 'Klinikum München',
    workLocation: 'München',
    descriptionText: 'Wir suchen eine Pflegefachkraft in Festanstellung.',
    lastSeenAt: RUN_STARTED_AT,
    firstSeenAt: RUN_STARTED_AT,
    contentHash: `hash-${id}`,
    ...overrides,
  });
};

/** Runs the stage over the Job_Posting of the Scrape_Run. */
const enrich = (
  stage: RelevanceEnrichmentService,
  overrides: { readonly signal?: AbortSignal; readonly graceDeadline?: Date | null } = {},
): Promise<RelevanceEnrichmentReport> =>
  stage.enrichRun({
    runId: RUN_ID,
    runStartedAt: RUN_STARTED_AT,
    signal: overrides.signal ?? new AbortController().signal,
    graceDeadline: overrides.graceDeadline ?? null,
  });

beforeAll(() => {
  // The stage and the service report contained failures through the Nest logger; a quiet test
  // output is what makes a real failure readable.
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RelevanceEnrichmentService.enrichRun, one assessment', () => {
  it('stores verdict, reason, model, time, content hash and rank in one write (15.1)', async () => {
    const { fixture, stage, log, assessor } = harness(() => assessedOutcome('UNCERTAIN'));

    seed(fixture, 'p1');

    const report = await enrich(stage);
    const row = fixture.postingOf('p1');

    expect(report.considered).toBe(1);
    expect(report.assessed).toBe(1);
    expect(row?.relevanceVerdict).toBe('UNCERTAIN');
    expect(row?.relevanceReason).toBe(REASON_DE);
    expect(row?.relevanceModel).toBe(MODEL);
    expect(row?.relevanceAssessedAt).toBeInstanceOf(Date);
    // The gate of the next Scrape_Run reads this against `contentHash` (15.5).
    expect(row?.relevanceContentHash).toBe('hash-p1');
    expect(row?.relevanceRank).toBe(RELEVANCE_RANK.UNCERTAIN);
    expect(fixture.writes).toStrictEqual(['p1']);
    // An assessment that worked needs no explanation in the Log_View.
    expect(log.codes()).toStrictEqual([]);
    expect(assessor.calls).toHaveLength(1);
  });

  it('transmits the stored posting data, the truncated description and the profile (15.2)', async () => {
    const { fixture, stage, assessor } = harness(() => assessedOutcome());

    seed(fixture, 'p1', {
      title: 'Pflegefachkraft (m/w/d)',
      publishedAt: new Date('2026-03-01T06:00:00.000Z'),
      descriptionText: 'ä'.repeat(RELEVANCE_DESCRIPTION_MAX_LENGTH + 500),
    });

    await enrich(stage);

    const request = assessor.calls[0];

    expect(request?.title).toBe('Pflegefachkraft (m/w/d)');
    expect(request?.employer).toBe('Klinikum München');
    expect(request?.workLocation).toBe('München');
    expect(request?.publishedAt).toStrictEqual(new Date('2026-03-01T06:00:00.000Z'));
    expect(request?.descriptionText).toHaveLength(RELEVANCE_DESCRIPTION_MAX_LENGTH);
    expect(request?.profile).toStrictEqual(PROFILE);
  });

  it('counts the "not relevant" verdicts 15.16 asks for', async () => {
    const { fixture, stage } = harness((request) =>
      request.title === 'agency' ? assessedOutcome('NOT_RELEVANT') : assessedOutcome(),
    );

    seed(fixture, 'p1');
    seed(fixture, 'agency');

    const report = await enrich(stage);

    expect(report.assessed).toBe(2);
    expect(report.notRelevant).toBe(1);
    expect(fixture.postingOf('agency')?.relevanceRank).toBe(RELEVANCE_RANK.NOT_RELEVANT);
  });
});

describe('RelevanceEnrichmentService.enrichRun, the content hash gate', () => {
  it('asks exactly for the Job_Posting the gate opens (15.5, 15.6, 15.15)', async () => {
    const { fixture, stage, assessor } = harness(() => assessedOutcome());

    // Never assessed: the gate is open.
    seed(fixture, 'never-assessed');
    // Assessed, content unchanged: retained, no request (15.5).
    seed(fixture, 'unchanged', { relevanceContentHash: 'hash-unchanged' });
    // Assessed, content changed since: exactly one new assessment (15.6).
    seed(fixture, 'changed', { relevanceContentHash: 'older-hash' });
    // Manually set: retained in place of a service assessment (15.15).
    seed(fixture, 'manual', { relevanceSetManually: true, relevanceVerdict: 'RELEVANT' });
    // Not seen by this Scrape_Run, so not a candidate of this stage at all.
    seed(fixture, 'older-run', { lastSeenAt: new Date('2026-03-01T08:00:00.000Z') });

    const report = await enrich(stage);

    expect(report.considered).toBe(2);
    expect([...assessor.titles()].sort()).toStrictEqual(['changed', 'never-assessed']);
    expect([...fixture.writes].sort()).toStrictEqual(['changed', 'never-assessed']);
    // The retained ones keep every stored column, including the manual verdict.
    expect(fixture.postingOf('unchanged')?.relevanceContentHash).toBe('hash-unchanged');
    expect(fixture.postingOf('manual')?.relevanceVerdict).toBe('RELEVANT');
    expect(fixture.postingOf('manual')?.relevanceSetManually).toBe(true);
  });

  it('works through the candidates oldest first, then by identifier (15.7)', async () => {
    const { fixture, stage, assessor } = harness(() => assessedOutcome(), {
      env: { relevanceConcurrency: 1 },
    });

    seed(fixture, 'newest', { firstSeenAt: new Date('2026-03-02T07:00:00.000Z') });
    seed(fixture, 'b-older', { firstSeenAt: new Date('2026-03-01T07:00:00.000Z') });
    seed(fixture, 'a-older', { firstSeenAt: new Date('2026-03-01T07:00:00.000Z') });

    await enrich(stage);

    // Deterministic, so a Job_Posting a bound budget pushed out of one Scrape_Run is at the front
    // of the next one's list.
    expect(assessor.titles()).toStrictEqual(['a-older', 'b-older', 'newest']);
    expect(fixture.writes).toStrictEqual(['a-older', 'b-older', 'newest']);
  });

  it('leaves a Job_Posting alone whose Platform has no effective Search_Profile (4.9, 15.2)', async () => {
    const { fixture, stage, assessor } = harness(() => assessedOutcome(), {
      profileSource: profiles(null),
    });

    seed(fixture, 'p1');

    const report = await enrich(stage);

    // No benchmark means no assessment request; the Job_Posting keeps the verdict it carries, and
    // the next Scrape_Run asks again once the Platform is completely configured.
    expect(report.considered).toBe(0);
    expect(assessor.calls).toStrictEqual([]);
    expect(fixture.writes).toStrictEqual([]);
    expect(fixture.postingOf('p1')?.relevanceVerdict).toBe('NOT_ASSESSED');
  });
});

describe('RelevanceEnrichmentService.enrichRun, what it stores without a verdict', () => {
  it('stores "not assessed" with the German note and reports it once (15.11)', async () => {
    // Fake timers, so the two increasing intervals of 15.11 are waited out instantly.
    vi.useFakeTimers();

    const { fixture, stage, log, assessor } = harness(() => failedWith('TIMEOUT'));

    seed(fixture, 'p1');

    const pending = enrich(stage);

    await vi.advanceTimersByTimeAsync(10_000);

    const report = await pending;
    const row = fixture.postingOf('p1');

    expect(report.notAssessed).toBe(1);
    expect(row?.relevanceVerdict).toBe('NOT_ASSESSED');
    expect(row?.relevanceReason).toContain('KI-Bewertung');
    expect(row?.relevanceModel).toBeNull();
    expect(row?.relevanceAssessedAt).toBeNull();
    expect(row?.relevanceRank).toBe(RELEVANCE_RANK.NOT_ASSESSED);
    // No stored assessment covers the current content, so the next Scrape_Run asks again (15.5).
    expect(row?.relevanceContentHash).toBeNull();
    expect(log.codes()).toStrictEqual(['relevance.requestFailed']);
    expect(log.messages[0]?.detail).toStrictEqual({ postingId: 'p1', reasonCode: 'TIMEOUT' });
    // Three attempts: one request plus the two repetitions 15.11 permits.
    expect(assessor.calls).toHaveLength(3);
  });

  it('reports an unusable response without repeating the request (15.12)', async () => {
    const { fixture, stage, log, assessor } = harness(() => failedWith('SCHEMA_VIOLATION'));

    seed(fixture, 'p1');

    const report = await enrich(stage);

    expect(report.notAssessed).toBe(1);
    expect(fixture.postingOf('p1')?.relevanceReason).toContain('unbrauchbar');
    expect(log.codes()).toStrictEqual(['relevance.schemaViolation']);
    expect(assessor.calls).toHaveLength(1);
  });

  it('stores "not assessed" without a note and without a line while the service is off (15.10)', async () => {
    const { fixture, stage, log, assessor } = harness(() => assessedOutcome(), {
      env: { relevanceEnabled: false },
    });

    seed(fixture, 'p1', { relevanceContentHash: 'older-hash', relevanceVerdict: 'RELEVANT' });

    const report = await enrich(stage);
    const row = fixture.postingOf('p1');

    expect(assessor.calls).toStrictEqual([]);
    expect(report.notAssessed).toBe(1);
    expect(row?.relevanceVerdict).toBe('NOT_ASSESSED');
    // The deactivation is one sentence about the whole process, not a note on every Job_Posting.
    expect(row?.relevanceReason).toBeNull();
    expect(row?.relevanceContentHash).toBeNull();
    expect(log.codes()).toStrictEqual([]);
  });

  it('keeps the stored verdict when the Log_Stream refuses its explanation', async () => {
    const log = createLogRecorder(new Error('log stream unavailable'));
    const { fixture, stage } = harness(() => failedWith('SCHEMA_VIOLATION'), { log });

    seed(fixture, 'p1');

    const report = await enrich(stage);

    // A refused line is not a refused write: the verdict stands and the stage counts it as stored.
    expect(report.notAssessed).toBe(1);
    expect(report.deliveryFailures).toBe(0);
    expect(fixture.postingOf('p1')?.relevanceVerdict).toBe('NOT_ASSESSED');
    expect(log.codes()).toStrictEqual(['relevance.schemaViolation']);
  });
});

describe('RelevanceEnrichmentService.enrichRun, the end of the window', () => {
  it('reports the Job_Posting it did not reach after the Scrape_Run was cancelled (12.7)', async () => {
    const controller = new AbortController();
    const { fixture, stage, log } = harness(
      (request) => {
        if (request.title === 'a-first') {
          controller.abort(new Error('Der Suchlauf wurde abgebrochen.'));
        }

        return assessedOutcome();
      },
      { env: { relevanceConcurrency: 1 } },
    );

    seed(fixture, 'a-first');
    seed(fixture, 'b-second');

    const report = await enrich(stage, { signal: controller.signal });

    expect(report.considered).toBe(2);
    expect(report.outstanding).toBe(1);
    // A cancelled candidate is not a verdict: its columns stay untouched and the next Scrape_Run
    // asks again.
    expect(fixture.writes).toStrictEqual(['a-first']);
    expect(fixture.postingOf('b-second')?.relevanceVerdict).toBe('NOT_ASSESSED');
    expect(fixture.postingOf('b-second')?.relevanceContentHash).toBeNull();
    expect(log.codes()).toStrictEqual([]);
  });

  it('starts no assessment at all once the grace window has passed', async () => {
    const { fixture, stage, assessor } = harness(() => assessedOutcome());

    seed(fixture, 'p1');

    const report = await enrich(stage, { graceDeadline: new Date(Date.now() - 1_000) });

    expect(assessor.calls).toStrictEqual([]);
    expect(report.outstanding).toBe(1);
    expect(fixture.writes).toStrictEqual([]);
  });

  it('leaves no timer behind after a stage that finished inside its window', async () => {
    vi.useFakeTimers();

    try {
      const { fixture, stage } = harness(() => assessedOutcome());

      seed(fixture, 'p1');

      const report = await enrich(stage, { graceDeadline: new Date(Date.now() + 600_000) });

      expect(report.assessed).toBe(1);
      // An uncleared deadline would keep the process alive for the rest of the grace period after
      // a Scrape_Run that finished in seconds.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('RelevanceEnrichmentService.enrichRun, what it contains', () => {
  it('counts a rejected write and keeps the remaining Job_Posting going (9.9)', async () => {
    const { fixture, stage, log } = harness(() => assessedOutcome(), {
      env: { relevanceConcurrency: 1 },
    });

    seed(fixture, 'a-first');
    seed(fixture, 'b-second');
    fixture.failNextWrite(new Error('connection closed'));

    const report = await enrich(stage);

    expect(report.deliveryFailures).toBe(1);
    expect(report.assessed).toBe(1);
    // Nothing was stored for the refused one, so no German line would be a true statement about it.
    expect(log.codes()).toStrictEqual([]);
    expect(fixture.postingOf('a-first')?.relevanceVerdict).toBe('NOT_ASSESSED');
    expect(fixture.postingOf('b-second')?.relevanceVerdict).toBe('RELEVANT');
  });

  it('reports an empty stage when the candidate query is rejected', async () => {
    const { fixture, stage, assessor } = harness(() => assessedOutcome());

    seed(fixture, 'p1');
    fixture.failReads(new Error('connection closed'));

    const report = await enrich(stage);

    expect(report).toStrictEqual({
      considered: 0,
      requested: 0,
      assessed: 0,
      notRelevant: 0,
      notAssessed: 0,
      skippedByBudget: 0,
      outstanding: 0,
      deliveryFailures: 0,
    });
    expect(assessor.calls).toStrictEqual([]);
  });

  it('keeps the batch invariant of the Relevance_Service over a mixed batch', async () => {
    const { fixture, stage } = harness((request) =>
      request.title === 'fails' ? failedWith('SCHEMA_VIOLATION') : assessedOutcome(),
    );

    seed(fixture, 'p1');
    seed(fixture, 'fails');
    seed(fixture, 'p3');

    const report = await enrich(stage);

    expect(
      report.assessed + report.notAssessed + report.outstanding + report.deliveryFailures,
    ).toBe(report.considered);
  });
});
