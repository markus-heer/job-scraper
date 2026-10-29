/**
 * Unit tests for the central error mapping (2.5, 7.4, 12.5, 13.1).
 *
 * The suite is deliberately shaped like the design's error table, because that table is the
 * specification: {@link EXPECTED_ROWS} restates the Platform_Status, the Run_Outcome and the log
 * level of every row, and {@link SAMPLE_FAILURES} holds one instance of every member of the union.
 * Both are `Record<JobToolFailureKind, …>`, so they are total by type — a failure kind added without
 * a row in either of them fails the type check rather than this suite, which is the point of the
 * task: a new error kind cannot reach the user as an untranslated technical string.
 *
 * What the mapping is held to beyond the table:
 *
 * - every German text names a next step (2.5), with the two documented exceptions below;
 * - no German text carries a technical string from a driver or a provider — the one place such a
 *   string may appear is the `detail` of the Log_Stream entry, where `emit` masks it (14.9);
 * - the Log_Stream entry of a failure is shaped like what `LogStreamService.emit` expects, with the
 *   detail keys the table's log column names.
 */

import { PLATFORM_STATUSES, RUN_OUTCOMES } from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import {
  COMMUTE_MODE_LABELS_DE,
  failedWriteSummaryDe,
  failureForDiscardedPosting,
  failureForNormalizationNote,
  failureLogEntry,
  isResultIncomplete,
  JOB_TOOL_FAILURE_KINDS,
  type JobToolFailure,
  type JobToolFailureKind,
  mapFailure,
  OPTIONAL_POSTING_FIELD_LABELS_DE,
  PLATFORM_STATUS_LABELS_DE,
  platformStatusLineDe,
  REQUIRED_POSTING_FIELD_LABELS_DE,
  RESULT_INCOMPLETE_HINT_DE,
  RUN_OUTCOME_LABELS_DE,
  storeFailureCauseDe,
  UNMAPPED_FAILURE_OWNERS,
} from '../error-mapping';

/** A rejection shaped like the generated Prisma client's, with a connection string in its message. */
const storeUnreachable = (): Error & { code: string } =>
  Object.assign(
    new Error(
      "Can't reach database server at `localhost:5432`, url postgresql://jobs:sup3rs3cret@localhost:5432/jobs",
    ),
    { code: 'P1001' },
  );

/** One instance of every member of the union. Total by type. */
const SAMPLE_FAILURES: Readonly<Record<JobToolFailureKind, JobToolFailure>> = {
  'robots.disallowed': { kind: 'robots.disallowed', platform: 'STEPSTONE', path: '/jobs' },
  'robots.unavailable': { kind: 'robots.unavailable', platform: 'INDEED' },
  'platform.signInRequired': {
    kind: 'platform.signInRequired',
    platform: 'STEPSTONE',
    sourceUrl: 'https://www.stepstone.de/jobs?page=2',
  },
  'platform.blocked': { kind: 'platform.blocked', platform: 'JOBVECTOR' },
  'platform.layoutUnknown': {
    kind: 'platform.layoutUnknown',
    platform: 'STEPSTONE',
    pageNumber: 4,
    sourceUrl: 'https://www.stepstone.de/jobs?page=4',
  },
  'page.retry': {
    kind: 'page.retry',
    platform: 'STEPSTONE',
    pageNumber: 2,
    attempt: 2,
    maxAttempts: 3,
  },
  'page.failed': { kind: 'page.failed', platform: 'STEPSTONE', pageNumber: 3 },
  'platform.unreachable': { kind: 'platform.unreachable', platform: 'INDEED', pageNumber: 1 },
  'platform.rateLimited': { kind: 'platform.rateLimited', platform: 'GLASSDOOR', pageNumber: 5 },
  'platform.pageLimit': { kind: 'platform.pageLimit', platform: 'STEPSTONE', pagesFetched: 10 },
  'platform.incompleteConfiguration': {
    kind: 'platform.incompleteConfiguration',
    platform: 'GLASSDOOR',
    missingFields: ['searchLocation', 'searchRadiusKm'],
  },
  'posting.discarded': {
    kind: 'posting.discarded',
    platform: 'STEPSTONE',
    field: 'title',
    sourceUrl: 'https://www.stepstone.de/stellenangebote--abc-123',
  },
  'posting.fieldEmpty': {
    kind: 'posting.fieldEmpty',
    platform: 'STEPSTONE',
    field: 'descriptionText',
  },
  'posting.dateUnparsed': {
    kind: 'posting.dateUnparsed',
    platform: 'INDEED',
    sourceUrl: 'https://de.indeed.com/viewjob?jk=abc',
    rawText: 'vor einer Weile',
  },
  'posting.writeFailed': {
    kind: 'posting.writeFailed',
    platform: 'STEPSTONE',
    postingId: 'abc-123',
    cause: storeUnreachable(),
  },
  'posting.interestFlagFailed': {
    kind: 'posting.interestFlagFailed',
    postingId: 'abc-123',
    cause: storeUnreachable(),
  },
  'commute.providerFailed': {
    kind: 'commute.providerFailed',
    postingId: 'abc-123',
    mode: 'TRANSIT',
  },
  'commute.geocodeFailed': {
    kind: 'commute.geocodeFailed',
    postingId: 'abc-123',
    rawLocation: 'Remote',
  },
  'commute.imprecise': { kind: 'commute.imprecise', postingId: 'abc-123', minutes: 38 },
  'relevance.requestFailed': {
    kind: 'relevance.requestFailed',
    postingId: 'abc-123',
    reasonCode: 'provider.timeout',
  },
  'relevance.schemaViolation': { kind: 'relevance.schemaViolation', postingId: 'abc-123' },
  'relevance.budgetReached': { kind: 'relevance.budgetReached', count: 7 },
  'relevance.disabled': { kind: 'relevance.disabled', reason: 'NO_API_KEY' },
  'config.commuteThresholdInvalid': {
    kind: 'config.commuteThresholdInvalid',
    retainedMinutes: 45,
  },
  'run.timeLimitReached': { kind: 'run.timeLimitReached', limitMinutes: 30 },
  'run.enrichmentDeadline': {
    kind: 'run.enrichmentDeadline',
    commuteOutstanding: 12,
    relevanceOutstanding: 4,
  },
  'run.cancelledByUser': { kind: 'run.cancelledByUser' },
  'run.cancelRejected': { kind: 'run.cancelRejected', runId: 'run-1', runOutcome: 'COMPLETED' },
  'run.createFailed': { kind: 'run.createFailed', cause: storeUnreachable() },
  'run.alreadyRunning': { kind: 'run.alreadyRunning', runningRunId: 'run-1' },
  'run.recoveredStale': { kind: 'run.recoveredStale', runId: 'run-1' },
};

/** The classification columns of the design's error table, restated per row. */
const EXPECTED_ROWS: Readonly<
  Record<
    JobToolFailureKind,
    {
      readonly logLevel: 'INFO' | 'WARN' | 'ERROR';
      readonly platformStatus?: (typeof PLATFORM_STATUSES)[number];
      readonly runOutcome?: (typeof RUN_OUTCOMES)[number];
    }
  >
> = {
  'robots.disallowed': { logLevel: 'ERROR', platformStatus: 'EXCLUDED_BY_ROBOTS_TXT' },
  'robots.unavailable': { logLevel: 'ERROR', platformStatus: 'ROBOTS_TXT_UNAVAILABLE' },
  'platform.signInRequired': { logLevel: 'WARN', platformStatus: 'SIGN_IN_REQUIRED' },
  'platform.blocked': { logLevel: 'WARN', platformStatus: 'PLATFORM_BLOCKED' },
  'platform.layoutUnknown': { logLevel: 'ERROR', platformStatus: 'PAGE_LAYOUT_UNKNOWN' },
  // The one row that reports no Platform_Status: the retrieval is still running.
  'page.retry': { logLevel: 'WARN' },
  'page.failed': { logLevel: 'ERROR', platformStatus: 'FAILED' },
  'platform.unreachable': { logLevel: 'ERROR', platformStatus: 'PLATFORM_UNREACHABLE' },
  'platform.rateLimited': { logLevel: 'WARN', platformStatus: 'FETCH_RATE_LIMITED' },
  'platform.pageLimit': { logLevel: 'INFO', platformStatus: 'PAGE_LIMIT_REACHED' },
  'platform.incompleteConfiguration': {
    logLevel: 'ERROR',
    platformStatus: 'INCOMPLETE_CONFIGURATION',
  },
  'posting.discarded': { logLevel: 'WARN' },
  'posting.fieldEmpty': { logLevel: 'INFO' },
  'posting.dateUnparsed': { logLevel: 'WARN' },
  'posting.writeFailed': { logLevel: 'ERROR' },
  'posting.interestFlagFailed': { logLevel: 'ERROR' },
  'commute.providerFailed': { logLevel: 'WARN' },
  'commute.geocodeFailed': { logLevel: 'WARN' },
  'commute.imprecise': { logLevel: 'INFO' },
  'relevance.requestFailed': { logLevel: 'WARN' },
  'relevance.schemaViolation': { logLevel: 'ERROR' },
  'relevance.budgetReached': { logLevel: 'INFO' },
  'relevance.disabled': { logLevel: 'INFO' },
  'config.commuteThresholdInvalid': { logLevel: 'ERROR' },
  'run.timeLimitReached': {
    logLevel: 'WARN',
    platformStatus: 'CANCELLED_BY_TIME_LIMIT',
    runOutcome: 'CANCELLED_BY_TIME_LIMIT',
  },
  'run.enrichmentDeadline': { logLevel: 'WARN' },
  // No Platform_Status: an unfinished Platform keeps its last reported one or NOT_YET_RUN.
  'run.cancelledByUser': { logLevel: 'INFO', runOutcome: 'CANCELLED_BY_USER' },
  'run.cancelRejected': { logLevel: 'INFO' },
  'run.createFailed': { logLevel: 'ERROR' },
  'run.alreadyRunning': { logLevel: 'INFO' },
  'run.recoveredStale': {
    logLevel: 'WARN',
    platformStatus: 'CANCELLED_BY_TIME_LIMIT',
    runOutcome: 'CANCELLED_BY_TIME_LIMIT',
  },
};

/**
 * The three rows whose recommended next step is not an instruction to the user.
 *
 * `commute.providerFailed` (8.8) and `run.enrichmentDeadline` both state that the determination is
 * repeated automatically in the next Scrape_Run — that is the next step, and it asks for nothing.
 * `config.commuteThresholdInvalid` is worded by the configuration check, whose first sentence
 * already names the permitted range — the action — and whose last one names the value that stays
 * active (8.14).
 */
const STEP_WITHOUT_INSTRUCTION: readonly JobToolFailureKind[] = [
  'commute.providerFailed',
  'config.commuteThresholdInvalid',
  'run.enrichmentDeadline',
];

const mappingOf = (kind: JobToolFailureKind) => mapFailure(SAMPLE_FAILURES[kind]);

describe('mapFailure totality over the failure union', () => {
  it('covers every kind of the union at runtime', () => {
    // `SAMPLE_FAILURES` and `EXPECTED_ROWS` are total by type; this asserts that the runtime list
    // the suite iterates is the same set, so neither map can silently go unexercised.
    expect([...JOB_TOOL_FAILURE_KINDS].sort()).toEqual(Object.keys(SAMPLE_FAILURES).sort());
    expect([...JOB_TOOL_FAILURE_KINDS].sort()).toEqual(Object.keys(EXPECTED_ROWS).sort());
    expect(JOB_TOOL_FAILURE_KINDS).toHaveLength(31);
  });

  it.each([...JOB_TOOL_FAILURE_KINDS])('maps %s onto its row of the table', (kind) => {
    const mapping = mappingOf(kind);
    const expected = EXPECTED_ROWS[kind];

    expect(mapping.logLevel).toBe(expected.logLevel);
    expect(mapping.platformStatus).toBe(expected.platformStatus);
    expect(mapping.runOutcome).toBe(expected.runOutcome);

    // The code is the kind: one identifier per table row, so the two cannot drift apart.
    expect(mapping.logCode).toBe(kind);
  });

  it.each([...JOB_TOOL_FAILURE_KINDS])('names a cause and a next step for %s', (kind) => {
    const { userMessageDe } = mappingOf(kind);

    expect(userMessageDe.length).toBeGreaterThan(0);
    expect(userMessageDe.trim()).toBe(userMessageDe);
    expect(userMessageDe).toMatch(/\.$/);

    // Cause plus next step is at least two sentences; a single sentence cannot be both.
    expect(userMessageDe.split('. ').length).toBeGreaterThanOrEqual(2);

    if (!STEP_WITHOUT_INSTRUCTION.includes(kind)) {
      expect(userMessageDe).toMatch(/bitte/i);
    }

    // No unresolved placeholder from the table reaches the user.
    expect(userMessageDe).not.toMatch(/[{}]/);
    expect(userMessageDe).not.toContain('undefined');
    expect(userMessageDe).not.toContain('NaN');
  });

  it('reports only Platform_Status and Run_Outcome values from the domain vocabulary', () => {
    for (const kind of JOB_TOOL_FAILURE_KINDS) {
      const { platformStatus, runOutcome } = mappingOf(kind);

      if (platformStatus !== undefined) {
        expect(PLATFORM_STATUSES).toContain(platformStatus);
      }

      if (runOutcome !== undefined) {
        expect(RUN_OUTCOMES).toContain(runOutcome);
      }
    }
  });
});

describe('mapFailure German wording pinned by the error table', () => {
  it.each([
    [
      'robots.disallowed' as const,
      'Plattform Stepstone wurde nicht abgefragt, weil deren robots.txt den Abruf untersagt.',
    ],
    [
      'robots.unavailable' as const,
      'Für Indeed konnte die robots.txt nicht geprüft werden; die Plattform wurde übersprungen.',
    ],
    [
      'platform.signInRequired' as const,
      'Stepstone zeigt Ergebnisse nur nach Anmeldung. Die Trefferliste ist für diese Plattform unvollständig.',
    ],
    [
      'platform.blocked' as const,
      'Jobvector hat den automatischen Abruf blockiert. Bitte später erneut versuchen.',
    ],
    [
      'platform.layoutUnknown' as const,
      'Der Seitenaufbau von Stepstone hat sich geändert; es konnten keine Treffer gelesen werden.',
    ],
    ['page.retry' as const, 'Stepstone: Seite 2 wird erneut abgerufen'],
    [
      'page.failed' as const,
      'Stepstone hat auf Seite 3 nicht geantwortet. Treffer bis zu dieser Seite wurden gespeichert.',
    ],
    [
      'platform.unreachable' as const,
      'Indeed war nicht erreichbar. Bitte den Suchlauf später wiederholen.',
    ],
    [
      'platform.rateLimited' as const,
      'Glassdoor hat die Abfragerate begrenzt. Der Abruf dieser Plattform wurde beendet.',
    ],
    [
      'platform.pageLimit' as const,
      'Stepstone: Seitenlimit erreicht, es wurden 10 Ergebnisseiten gelesen.',
    ],
    [
      'platform.incompleteConfiguration' as const,
      'Glassdoor: Konfiguration unvollständig, fehlende Felder: Suchort (searchLocation), Suchradius (searchRadiusKm).',
    ],
    [
      'posting.interestFlagFailed' as const,
      'Die Markierung konnte nicht gespeichert werden. Bitte erneut versuchen.',
    ],
    ['commute.imprecise' as const, 'Erreichbarkeit ungefähr: 38 Min.'],
    [
      'relevance.budgetReached' as const,
      'Bewertungslimit erreicht: 7 Treffer wurden nicht bewertet.',
    ],
    ['relevance.disabled' as const, 'KI-Bewertung ist deaktiviert'],
    [
      'run.timeLimitReached' as const,
      'Zeitlimit von 30 Minuten erreicht. Der Suchlauf wurde beendet.',
    ],
    [
      'run.enrichmentDeadline' as const,
      'Bewertung und Erreichbarkeit konnten nicht für alle Treffer ermittelt werden',
    ],
    ['run.cancelledByUser' as const, 'Suchlauf abgebrochen.'],
    ['run.cancelRejected' as const, 'Dieser Suchlauf läuft nicht mehr; Ergebnis: abgeschlossen.'],
    [
      'run.createFailed' as const,
      'Der Suchlauf konnte nicht gestartet werden: Die Datenbank war nicht erreichbar.',
    ],
    ['run.alreadyRunning' as const, 'Es läuft bereits ein Suchlauf.'],
    ['run.recoveredStale' as const, 'Suchlauf durch Neustart beendet.'],
  ])('keeps the pinned wording of %s', (kind, pinned) => {
    expect(mappingOf(kind).userMessageDe).toContain(pinned);
  });

  it('phrases the failed page without a page number when the adapter knew none', () => {
    const mapping = mapFailure({ kind: 'page.failed', platform: 'INDEED' });

    // Rather than printing a guessed "Seite 1": the sentence states what is true either way.
    expect(mapping.userMessageDe).toContain('Indeed hat nicht geantwortet.');
    expect(mapping.userMessageDe).not.toContain('Seite');
    expect(mapping.platformStatus).toBe('FAILED');
  });

  it('names the switched-off relevance service and the switched-off key apart', () => {
    expect(
      mapFailure({ kind: 'relevance.disabled', reason: 'NO_API_KEY' }).userMessageDe,
    ).toContain('ANTHROPIC_API_KEY');
    expect(
      mapFailure({ kind: 'relevance.disabled', reason: 'SWITCHED_OFF' }).userMessageDe,
    ).toContain('RELEVANCE_ENABLED');
  });

  it('names the Posting_Id and the platform of a rejected write (9.9)', () => {
    const mapping = mapFailure(SAMPLE_FAILURES['posting.writeFailed']);

    expect(mapping.userMessageDe).toContain('Stepstone');
    expect(mapping.userMessageDe).toContain('abc-123');
    expect(mapping.userMessageDe).toContain('Die Datenbank war nicht erreichbar.');
    // The run goes on: 9.9 asks for the remaining postings to be stored, and the sentence has to
    // agree with what the Scraper_Service actually does.
    expect(mapping.userMessageDe).toContain('fortgesetzt');
  });
});

describe('storeFailureCauseDe', () => {
  it.each([
    ['P1000', 'Die Datenbank hat die Anmeldung abgelehnt.'],
    ['P1001', 'Die Datenbank war nicht erreichbar.'],
    ['P1002', 'Die Datenbank war nicht erreichbar.'],
    ['P1017', 'Die Datenbank war nicht erreichbar.'],
    ['P1008', 'Die Datenbank hat zu lange nicht geantwortet.'],
    ['P2024', 'Die Datenbank hat zu lange nicht geantwortet.'],
    ['P2002', 'Es ist bereits ein Eintrag mit demselben Schlüssel gespeichert.'],
    ['P2003', 'Ein verknüpfter Datensatz fehlt.'],
    ['P2025', 'Der zu ändernde Datensatz war nicht vorhanden.'],
  ])('translates the Prisma code %s', (code, expected) => {
    expect(storeFailureCauseDe(Object.assign(new Error('technical'), { code }))).toBe(expected);
  });

  it('names an unknown Prisma code but prints nothing that is not one', () => {
    expect(storeFailureCauseDe(Object.assign(new Error('x'), { code: 'P9999' }))).toContain(
      'P9999',
    );

    // A `code` that is not a Prisma code is data, not an identifier, and never reaches the user.
    const suspicious = Object.assign(new Error('x'), { code: 'sk-live-abcdef' });

    expect(storeFailureCauseDe(suspicious)).toBe('Die Datenbank hat den Vorgang abgelehnt.');
    expect(storeFailureCauseDe(suspicious)).not.toContain('sk-live');
  });

  it('answers for a rejection that is not an error object at all', () => {
    for (const cause of [undefined, null, 'boom', 42, {}, []]) {
      expect(storeFailureCauseDe(cause)).toBe('Die Datenbank hat den Vorgang abgelehnt.');
    }
  });
});

describe('technical detail stays out of the German text', () => {
  it.each([
    'posting.writeFailed' as const,
    'posting.interestFlagFailed' as const,
    'run.createFailed' as const,
  ])('keeps the driver message and the connection string out of %s', (kind) => {
    const { userMessageDe } = mappingOf(kind);

    expect(userMessageDe).not.toContain('postgresql://');
    expect(userMessageDe).not.toContain('sup3rs3cret');
    expect(userMessageDe).not.toContain('localhost');
    expect(userMessageDe).not.toContain("Can't reach");
  });

  it('carries the raw cause in the log detail instead, where emit masks it (14.9)', () => {
    const entry = failureLogEntry(SAMPLE_FAILURES['posting.writeFailed']);
    const cause = entry.detail?.['cause'] as Record<string, unknown> | undefined;

    expect(cause?.['code']).toBe('P1001');
    expect(String(cause?.['message'])).toContain('postgresql://');
  });

  it('keeps the relevance reason code in the detail and out of the German sentence (16.8)', () => {
    const entry = failureLogEntry(SAMPLE_FAILURES['relevance.requestFailed']);

    expect(entry.detail?.['reasonCode']).toBe('provider.timeout');
    expect(entry.messageDe).not.toContain('provider.timeout');
  });
});

describe('failureLogEntry', () => {
  it.each([...JOB_TOOL_FAILURE_KINDS])('builds an emittable entry for %s', (kind) => {
    const failure = SAMPLE_FAILURES[kind];
    const entry = failureLogEntry(failure);
    const mapping = mapFailure(failure);

    expect(entry.code).toBe(mapping.logCode);
    expect(entry.level).toBe(mapping.logLevel);
    // The Log_View and the summary say the same thing about the same failure.
    expect(entry.messageDe).toBe(mapping.userMessageDe);

    // No key with an absent value: the detail is a JSON column, and `undefined` is not JSON.
    if (entry.detail !== undefined) {
      expect(Object.values(entry.detail)).not.toContain(undefined);
      expect(Object.keys(entry.detail).length).toBeGreaterThan(0);
    }
  });

  it('sets the platform column for a Platform-scoped failure and leaves it absent otherwise', () => {
    expect(failureLogEntry(SAMPLE_FAILURES['platform.blocked']).platform).toBe('JOBVECTOR');
    expect(failureLogEntry(SAMPLE_FAILURES['commute.imprecise']).platform).toBeUndefined();
    expect(failureLogEntry({ kind: 'run.cancelledByUser' }).platform).toBeUndefined();
  });

  it.each([
    ['robots.disallowed' as const, { path: '/jobs' }],
    ['page.retry' as const, { pageNumber: 2, attempt: 2, maxAttempts: 3 }],
    ['page.failed' as const, { pageNumber: 3 }],
    ['platform.pageLimit' as const, { pagesFetched: 10 }],
    ['posting.discarded' as const, { field: 'title' }],
    ['posting.fieldEmpty' as const, { field: 'descriptionText' }],
    ['commute.providerFailed' as const, { postingId: 'abc-123', mode: 'TRANSIT' }],
    ['commute.imprecise' as const, { postingId: 'abc-123', minutes: 38 }],
    ['relevance.budgetReached' as const, { count: 7 }],
    ['run.timeLimitReached' as const, { limitMinutes: 30 }],
    ['run.cancelRejected' as const, { runId: 'run-1', runOutcome: 'COMPLETED' }],
    ['run.recoveredStale' as const, { runId: 'run-1' }],
  ])('carries the log detail the table names for %s', (kind, expected) => {
    expect(failureLogEntry(SAMPLE_FAILURES[kind]).detail).toMatchObject(expected);
  });

  it('leaves the detail absent for the rows that carry nothing beyond their platform', () => {
    expect(
      failureLogEntry({ kind: 'robots.unavailable', platform: 'INDEED' }).detail,
    ).toBeUndefined();
    expect(failureLogEntry({ kind: 'run.cancelledByUser' }).detail).toBeUndefined();
  });
});

describe('failures built from the normalization layer', () => {
  it('translates a discarded posting onto the table row of 6.5', () => {
    const failure = failureForDiscardedPosting({
      platform: 'STEPSTONE',
      field: 'sourceUrl',
      sourceUrl: null,
    });
    const mapping = mapFailure(failure);

    // The normalization layer reports this under `posting.discardedMissingField`; the Log_Stream
    // code is the table's `posting.discarded`, and this mapping is where the two meet.
    expect(mapping.logCode).toBe('posting.discarded');
    expect(mapping.logLevel).toBe('WARN');
    expect(mapping.platformStatus).toBeUndefined();
    expect(mapping.userMessageDe).toContain(REQUIRED_POSTING_FIELD_LABELS_DE.sourceUrl);
  });

  it('translates the unparsable publication date note onto the table row of 6.9', () => {
    const mapping = mapFailure(
      failureForNormalizationNote('posting.publicationDateUnparsable', {
        platform: 'INDEED',
        sourceUrl: 'https://de.indeed.com/viewjob?jk=abc',
        rawText: 'vor einer Weile',
      }),
    );

    expect(mapping.logCode).toBe('posting.dateUnparsed');
    expect(mapping.logLevel).toBe('WARN');
    expect(mapping.userMessageDe).toContain('Datum unbekannt');
  });

  it('labels every mandatory and optional posting field in German', () => {
    for (const label of [
      ...Object.values(REQUIRED_POSTING_FIELD_LABELS_DE),
      ...Object.values(OPTIONAL_POSTING_FIELD_LABELS_DE),
    ]) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe('the per-Platform summary of 7.4', () => {
  it('labels all 14 Platform_Status values, including the four that are no failure', () => {
    for (const status of PLATFORM_STATUSES) {
      expect(PLATFORM_STATUS_LABELS_DE[status].length).toBeGreaterThan(0);
    }

    expect(Object.keys(PLATFORM_STATUS_LABELS_DE)).toHaveLength(PLATFORM_STATUSES.length);
    expect(PLATFORM_STATUS_LABELS_DE.DISABLED).toBe('im Quellcode deaktiviert');
    expect(PLATFORM_STATUS_LABELS_DE.NOT_YET_RUN).toBe('noch nicht abgefragt');
  });

  it('labels all three Run_Outcome values', () => {
    for (const outcome of RUN_OUTCOMES) {
      expect(RUN_OUTCOME_LABELS_DE[outcome].length).toBeGreaterThan(0);
    }
  });

  it('labels both modes of transport', () => {
    expect(COMMUTE_MODE_LABELS_DE.BICYCLE).toBe('Fahrrad');
    expect(COMMUTE_MODE_LABELS_DE.TRANSIT).toBe('öffentliche Verkehrsmittel');
  });

  it('shows exactly one status and the taken-over count per Platform', () => {
    expect(platformStatusLineDe('STEPSTONE', 'COMPLETED', 42)).toBe(
      'Stepstone: vollständig abgefragt, 42 Treffer übernommen.',
    );
    expect(platformStatusLineDe('GLASSDOOR', 'SIGN_IN_REQUIRED', 0)).toBe(
      'Glassdoor: Anmeldung erforderlich, 0 Treffer übernommen.',
    );
  });

  it('asks for the incompleteness hint exactly when a status differs from "completed"', () => {
    expect(isResultIncomplete(['COMPLETED', 'COMPLETED'])).toBe(false);
    expect(isResultIncomplete(['COMPLETED', 'SIGN_IN_REQUIRED'])).toBe(true);
    // A Platform that was never requested is not "completed" either, so the list is incomplete.
    expect(isResultIncomplete(['NOT_YET_RUN'])).toBe(true);
    expect(isResultIncomplete([])).toBe(false);
    expect(RESULT_INCOMPLETE_HINT_DE).toMatch(/unvollständig/);
  });

  it('summarises the failed writes of a run and stays silent when there were none', () => {
    expect(failedWriteSummaryDe(0)).toBeNull();
    expect(failedWriteSummaryDe(-1)).toBeNull();
    expect(failedWriteSummaryDe(3)).toContain('3 Treffer konnten nicht gespeichert werden.');
    expect(failedWriteSummaryDe(3)).toMatch(/bitte/i);
  });
});

describe('rows of the error table that are owned elsewhere', () => {
  it('names an owner for every row this module does not map', () => {
    const owners = Object.entries(UNMAPPED_FAILURE_OWNERS);

    expect(owners).toHaveLength(7);

    for (const [row, owner] of owners) {
      expect(row.length).toBeGreaterThan(0);
      // Each entry names where the wording lives, so the accounting can be followed.
      expect(owner).toMatch(/Web_App|scripts\/start\.mjs|apps\/api\/src/);
    }
  });
});
