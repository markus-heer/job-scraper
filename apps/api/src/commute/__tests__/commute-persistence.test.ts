/**
 * What a determination leaves behind: the stored commute columns and the German Log_Stream lines
 * (8.2, 8.5, 8.8, 8.12, 8.13).
 *
 * The subject is task 13.5 — the admissible range of 8.2, the `JobPosting` write, the degradation
 * cases and the enrichment stage that runs after persistence. The determination itself is the real
 * `CommuteService` over the stand-in Posting_Store and the counted Routing_Provider of
 * `./commute-store.fixture.ts`, so every test is offline and deterministic; the chain's own cases
 * are `commute.service.test.ts` and the fuller matrix is task 13.9.
 *
 * Requirements: 8.2, 8.5, 8.8, 8.12, 8.13.
 */

import { describe, expect, it } from 'vitest';

import type { LogMessagePayload } from '../../log-stream/log-stream.service';
import { PostingRepository } from '../../posting/posting.repository';
import type { LogMessage } from '../../prisma/prisma.types';
import {
  admissibleMinutes,
  bestCommuteOf,
  COMMUTE_MINUTES_MAX,
  persistedCommuteResultOf,
} from '../admissible-commute';
import { CommuteService } from '../commute.service';
import { type CommuteEnrichmentLog, CommuteEnrichmentService } from '../commute-enrichment.service';
import {
  type CommuteStoreFixture,
  createCommuteStore,
  geocoded,
  type RoutingAnswers,
  stubRouting,
} from './commute-store.fixture';

/** The Home_Address every route starts from (8.10). */
const HOME = 'Hörkherstraße 1d, 80689 München';

const HOME_COORDINATE = { lat: 48.11954, lon: 11.50851 };
const TARGET_COORDINATE = { lat: 48.15003, lon: 11.58004 };

/** A work location the rule-based parse resolves without help. */
const WORK_LOCATION = 'München (hybrid)';

/** The Scrape_Run the enrichment stage runs in; its start time is the candidates' `lastSeenAt`. */
const RUN_ID = 'run-1';
const RUN_STARTED_AT = new Date('2026-03-02T08:00:00.000Z');

/** A Routing_Provider that resolves both addresses and answers the two modes of transport. */
const answersFor = (
  bicycleMinutes: number | null,
  transitMinutes: number | null,
  precision: 'EXACT' | 'IMPRECISE' = 'EXACT',
): RoutingAnswers => ({
  geocode: (query) =>
    query === HOME
      ? geocoded(HOME_COORDINATE.lat, HOME_COORDINATE.lon)
      : geocoded(TARGET_COORDINATE.lat, TARGET_COORDINATE.lon, precision),
  duration: (request) => (request.mode === 'BICYCLE' ? bicycleMinutes : transitMinutes),
});

/** Records every Log_Stream message of the stage, so the German lines become assertable. */
interface LogRecorder {
  readonly log: CommuteEnrichmentLog;
  readonly messages: readonly LogMessagePayload[];
  codes(): readonly string[];
}

const createLogRecorder = (): LogRecorder => {
  const messages: LogMessagePayload[] = [];

  const log: CommuteEnrichmentLog = {
    emit: (payload: LogMessagePayload): Promise<LogMessage> => {
      messages.push(payload);

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
  readonly routing: ReturnType<typeof stubRouting>;
}

/** The enrichment stage wired to the real Commute_Service and the real repository. */
const harness = (answers: RoutingAnswers): Harness => {
  const fixture = createCommuteStore();
  const routing = stubRouting(answers);
  const log = createLogRecorder();
  const commute = new CommuteService(fixture.store, { homeAddress: HOME }, routing.provider);
  const stage = new CommuteEnrichmentService(
    fixture.store,
    commute,
    new PostingRepository(fixture.store),
    log.log,
  );

  return { fixture, stage, log, routing };
};

/** A Job_Posting as the retrieval phase of this Scrape_Run left it. */
const seedPosting = (
  fixture: CommuteStoreFixture,
  workLocation: string | null,
  id = 'p1',
): void => {
  fixture.seedPosting({
    id,
    title: 'Projektmanagerin',
    workLocation,
    lastSeenAt: RUN_STARTED_AT,
  });
};

/** Runs the stage over the Job_Posting of the Scrape_Run, with an open grace window. */
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

describe('the admissible range of a stored Commute_Time (8.2)', () => {
  it('rounds up to whole minutes and keeps the floor at one minute', () => {
    expect(admissibleMinutes(0.1)).toBe(1);
    expect(admissibleMinutes(0)).toBe(1);
    expect(admissibleMinutes(28.2)).toBe(29);
    expect(admissibleMinutes(COMMUTE_MINUTES_MAX)).toBe(600);
  });

  it('stores a value above 600 minutes and a value that is no measurement as unknown', () => {
    expect(admissibleMinutes(601)).toBeNull();
    expect(admissibleMinutes(900)).toBeNull();
    expect(admissibleMinutes(-1)).toBeNull();
    expect(admissibleMinutes(Number.POSITIVE_INFINITY)).toBeNull();
    expect(admissibleMinutes(Number.NaN)).toBeNull();
    expect(admissibleMinutes(null)).toBeNull();
  });

  it('picks the Best_Commute_Time over the admissible values only', () => {
    const measured = {
      bicycleMinutes: 900,
      transitMinutes: 52,
      precision: 'EXACT' as const,
      locationInput: WORK_LOCATION,
      checkedAt: RUN_STARTED_AT,
    };

    expect(persistedCommuteResultOf(measured)).toStrictEqual({
      bicycleMinutes: null,
      transitMinutes: 52,
      bestCommuteMinutes: 52,
      bestCommuteMode: 'TRANSIT',
      commutePrecision: 'EXACT',
      commuteLocationInput: WORK_LOCATION,
      commuteCheckedAt: RUN_STARTED_AT,
    });
  });

  it('collapses the precision together with an unknown Best_Commute_Time (8.13)', () => {
    const stored = persistedCommuteResultOf({
      bicycleMinutes: 700,
      transitMinutes: 900,
      precision: 'IMPRECISE',
      locationInput: WORK_LOCATION,
      checkedAt: RUN_STARTED_AT,
    });

    expect(stored.bestCommuteMinutes).toBeNull();
    expect(stored.bestCommuteMode).toBeNull();
    expect(stored.commutePrecision).toBe('UNKNOWN');
    expect(stored.commuteLocationInput).toBe(WORK_LOCATION);
  });

  it('gives a tie to the bicycle, so the stored pair is deterministic', () => {
    expect(bestCommuteOf(31, 31)).toStrictEqual({ minutes: 31, mode: 'BICYCLE' });
    expect(bestCommuteOf(null, null)).toStrictEqual({ minutes: null, mode: null });
  });
});

describe('the commute write of one Job_Posting (8.2, 8.12)', () => {
  it('stores both values, the Best_Commute_Time with its mode, the precision and the time', async () => {
    const { fixture, stage, log } = harness(answersFor(41, 28));

    seedPosting(fixture, WORK_LOCATION);

    const report = await enrich(stage);
    const stored = fixture.postingOf('p1');

    expect(report).toStrictEqual({
      considered: 1,
      determined: 1,
      reused: 0,
      unknown: 0,
      outstanding: 0,
    });
    expect(stored?.bicycleMinutes).toBe(41);
    expect(stored?.transitMinutes).toBe(28);
    expect(stored?.bestCommuteMinutes).toBe(28);
    expect(stored?.bestCommuteMode).toBe('TRANSIT');
    expect(stored?.commutePrecision).toBe('EXACT');
    expect(stored?.commuteLocationInput).toBe(WORK_LOCATION);
    expect(stored?.commuteCheckedAt).toBeInstanceOf(Date);

    // A determined, precise result explains itself in the list; no Log_Stream line belongs to it.
    expect(log.codes()).toStrictEqual([]);
  });

  it('leaves every column of the retrieval and of the user untouched (9.3)', async () => {
    const { fixture, stage } = harness(answersFor(41, 28));

    fixture.seedPosting({
      id: 'p1',
      title: 'Projektmanagerin',
      workLocation: WORK_LOCATION,
      lastSeenAt: RUN_STARTED_AT,
      interestFlag: 'NOT_INTERESTING',
      relevanceVerdict: 'RELEVANT',
      relevanceSetManually: true,
      contentHash: 'hash-1',
    });

    await enrich(stage);

    const stored = fixture.postingOf('p1');

    expect(stored?.interestFlag).toBe('NOT_INTERESTING');
    expect(stored?.relevanceVerdict).toBe('RELEVANT');
    expect(stored?.relevanceSetManually).toBe(true);
    expect(stored?.contentHash).toBe('hash-1');
    expect(stored?.title).toBe('Projektmanagerin');
  });

  it('stores a determined value above 600 minutes as unknown, without a line (8.2)', async () => {
    const { fixture, stage, log } = harness(answersFor(900, 780));

    seedPosting(fixture, WORK_LOCATION);

    const report = await enrich(stage);
    const stored = fixture.postingOf('p1');

    expect(report.unknown).toBe(1);
    expect(stored?.bicycleMinutes).toBeNull();
    expect(stored?.transitMinutes).toBeNull();
    expect(stored?.bestCommuteMinutes).toBeNull();
    expect(stored?.bestCommuteMode).toBeNull();
    expect(stored?.commutePrecision).toBe('UNKNOWN');

    // Nothing failed and the value is cached for 30 days, so neither failure row would be true.
    expect(log.codes()).toStrictEqual([]);
  });

  it('marks a municipality centroid as imprecise and says so once (8.12)', async () => {
    const { fixture, stage, log } = harness(answersFor(41, 28, 'IMPRECISE'));

    seedPosting(fixture, 'München');

    await enrich(stage);

    expect(fixture.postingOf('p1')?.commutePrecision).toBe('IMPRECISE');
    expect(log.codes()).toStrictEqual(['commute.imprecise']);
    expect(log.messages.at(0)?.level).toBe('INFO');
    expect(log.messages.at(0)?.messageDe).toContain('28 Min.');
    expect(log.messages.at(0)?.detail).toStrictEqual({ postingId: 'p1', minutes: 28 });
  });
});

describe('the degradation cases (8.5, 8.8, 8.13)', () => {
  it('stores "unknown" and names the Routing_Provider failure per mode (8.8)', async () => {
    const { fixture, stage, log } = harness(answersFor(null, null));

    seedPosting(fixture, WORK_LOCATION);

    const report = await enrich(stage);
    const stored = fixture.postingOf('p1');

    expect(report.unknown).toBe(1);
    expect(stored?.bestCommuteMinutes).toBeNull();
    expect(stored?.commutePrecision).toBe('UNKNOWN');
    expect(stored?.commuteLocationInput).toBe(WORK_LOCATION);
    expect(stored?.commuteCheckedAt).toBeInstanceOf(Date);

    expect(log.codes()).toStrictEqual(['commute.providerFailed', 'commute.providerFailed']);
    expect(log.messages.map((message) => message.detail?.mode)).toStrictEqual([
      'BICYCLE',
      'TRANSIT',
    ]);
    expect(log.messages.at(0)?.level).toBe('WARN');
  });

  it('stores "unknown" and names the work location where no place was found (8.5)', async () => {
    const { fixture, stage, log } = harness(answersFor(41, 28));

    seedPosting(fixture, 'Remote');

    const report = await enrich(stage);

    expect(report.unknown).toBe(1);
    expect(fixture.postingOf('p1')?.bestCommuteMinutes).toBeNull();
    expect(fixture.postingOf('p1')?.commuteLocationInput).toBe('Remote');
    expect(log.codes()).toStrictEqual(['commute.geocodeFailed']);
    expect(log.messages.at(0)?.detail).toStrictEqual({ postingId: 'p1', rawLocation: 'Remote' });
  });

  it('keeps the Best_Commute_Time where only one mode answered, and stays silent', async () => {
    const { fixture, stage, log } = harness(answersFor(null, 28));

    seedPosting(fixture, WORK_LOCATION);

    await enrich(stage);

    const stored = fixture.postingOf('p1');

    expect(stored?.bicycleMinutes).toBeNull();
    expect(stored?.bestCommuteMinutes).toBe(28);
    expect(stored?.bestCommuteMode).toBe('TRANSIT');

    // The posting shows a Best_Commute_Time, so the "Erreichbarkeit unbekannt" sentence of
    // `commute.providerFailed` would contradict the list.
    expect(log.codes()).toStrictEqual([]);
  });

  it('writes nothing and says nothing for a reused result (8.9)', async () => {
    const { fixture, stage, log, routing } = harness(answersFor(41, 28));

    fixture.seedPosting({
      id: 'p1',
      title: 'Projektmanagerin',
      workLocation: WORK_LOCATION,
      lastSeenAt: RUN_STARTED_AT,
      bicycleMinutes: 41,
      transitMinutes: 28,
      bestCommuteMinutes: 28,
      bestCommuteMode: 'TRANSIT',
      commutePrecision: 'EXACT',
      commuteLocationInput: WORK_LOCATION,
      // Yesterday, so the stored result is well inside the 30-day validity window of 8.9.
      commuteCheckedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000),
    });

    const report = await enrich(stage);

    expect(report).toStrictEqual({
      considered: 1,
      determined: 0,
      reused: 1,
      unknown: 0,
      outstanding: 0,
    });
    expect(fixture.writes).toStrictEqual([]);
    expect(routing.geocodeCalls).toStrictEqual([]);
    expect(log.codes()).toStrictEqual([]);
  });

  it('keeps the Job_Posting and stays silent when the write is rejected (9.9)', async () => {
    const { fixture, stage, log } = harness(answersFor(41, 28));

    seedPosting(fixture, WORK_LOCATION);
    fixture.failNextPostingWrite(new Error('connection closed'));

    const report = await enrich(stage);

    expect(report.determined).toBe(0);
    expect(fixture.postingOf('p1')?.bestCommuteMinutes).toBeNull();
    expect(log.codes()).toStrictEqual([]);
  });
});

describe('the bound of the enrichment stage', () => {
  it('starts no determination once the grace window has closed', async () => {
    const { fixture, stage, routing, log } = harness(answersFor(41, 28));

    seedPosting(fixture, WORK_LOCATION);
    seedPosting(fixture, WORK_LOCATION, 'p2');

    const report = await enrich(stage, { graceDeadline: new Date(Date.now() - 1_000) });

    expect(report).toStrictEqual({
      considered: 2,
      determined: 0,
      reused: 0,
      unknown: 0,
      outstanding: 2,
    });
    expect(routing.geocodeCalls).toStrictEqual([]);
    expect(fixture.postingOf('p1')?.commuteCheckedAt).toBeNull();
    expect(log.codes()).toStrictEqual([]);
  });

  it('considers only the Job_Posting the running Scrape_Run saw', async () => {
    const { fixture, stage } = harness(answersFor(41, 28));

    seedPosting(fixture, WORK_LOCATION);
    fixture.seedPosting({
      id: 'older',
      title: 'Aus einem früheren Suchlauf',
      workLocation: WORK_LOCATION,
      lastSeenAt: new Date(RUN_STARTED_AT.getTime() - 7 * 24 * 60 * 60 * 1_000),
    });

    const report = await enrich(stage);

    expect(report.considered).toBe(1);
    expect(fixture.postingOf('older')?.commuteCheckedAt).toBeNull();
  });
});
