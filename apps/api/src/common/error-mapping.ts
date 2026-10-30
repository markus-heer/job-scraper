/**
 * The one place a failure of the Job_Tool is turned into something a person can read (2.5, 7.4, 13.1).
 *
 * Every row of the design's error table that reaches the API_Service at runtime is a member of
 * {@link JobToolFailure}, and {@link mapFailure} answers for each of them with the four things the
 * rest of the system needs: the Platform_Status to record, the Run_Outcome to record, the German
 * sentence the user reads, and the level plus the stable English code of the Log_Stream entry. The
 * union is the contract: a new failure kind cannot be added without the compiler demanding its row
 * here, which is what keeps an untranslated technical string out of the Web_App.
 *
 * ## What this module owns, and what it deliberately does not
 *
 * A Platform_Adapter already carries its own German Log_Stream lines (`packages/scrapers/src/
 * adapters/<platform>/messages.ts`). Those are *progress* narration — "Seite 3 gelesen, 24 Treffer
 * gefunden" — which only the adapter can write, because only it knows the page number and the count
 * while the retrieval is still running. This module owns the *classification*: which of the 14
 * Platform_Status values and which of the 3 Run_Outcome values a failure stands for, at what level
 * and under which code it is logged, and the sentence that explains it to the user afterwards. Where
 * an adapter already emitted its own end-of-retrieval line, the Scraper_Service should forward that
 * event rather than emit a second line for the same observation (see {@link failureLogEntry}); what
 * it takes from here in that case is the Platform_Status, the Run_Outcome and the summary sentence.
 *
 * Everything the adapters cannot see is mapped here and nowhere else: robots.txt decisions, rejected
 * Posting_Store writes, enrichment outcomes, the run lifecycle and the deadlines.
 *
 * Where a German text already has an owner, this module calls that owner instead of restating the
 * wording — the incomplete per-Platform configuration (4.9, 4.10) and the rejected Commute_Threshold
 * (8.14) are built by `platform-config.messages.ts` and `config.messages.ts`. A second copy of a
 * sentence is a second place for it to drift, which is the problem this module exists to solve.
 *
 * ## Rows of the table that are not mapped here
 *
 * Six rows describe failures that never reach this process, so a function in `apps/api/src` could
 * not be called for them and a copy of their text here would only rot:
 *
 * - *Log_Stream connection broken* and *Log_Stream reconnect exhausted* (12.11, 12.12) happen in the
 *   browser; the table itself records "client-side only; the server logs nothing". They belong to the
 *   Web_App's Log_View.
 * - *Invalid Default_Search_Profile* (3.6) and *missing configuration key* (1.15) are console output
 *   printed before the API_Service accepts a request — there is no Scrape_Run and therefore no
 *   Log_Stream to map onto. Their wording lives in `profile.messages.ts` and `config.messages.ts`.
 * - *Container runtime unreachable* (1.13), *Prisma migration failed* (1.14) and *service not ready
 *   within 60 s* (1.11) are Start_Script steps in `scripts/start.mjs`, a separate program.
 *
 * {@link UNMAPPED_FAILURE_OWNERS} names them with their owner, so the accounting is checkable rather
 * than implied.
 *
 * ## Two things this module must not do
 *
 * It does not mask secrets. `LogStreamService.emit` is the single masking seam (14.9): it masks the
 * text and the structured context of every message in front of the write, so masking here as well
 * would add a second place to get it right without covering anything `emit` does not. What this
 * module does do is refuse to put technical strings into German text at all: the cause of a rejected
 * database write is derived from the Prisma error *code* ({@link storeFailureCauseDe}), never from
 * its message, because a driver message can carry a connection string and the user has no use for
 * it. The raw error belongs in the `detail` of the Log_Stream entry, where `emit` masks it.
 *
 * It does not invent status values. Platform_Status and Run_Outcome come from `@job-scraper/domain`;
 * a failure that names neither simply leaves both fields absent.
 *
 * ## Why the error types are detected structurally
 *
 * `@job-scraper/scrapers` is an ESM package that depends on Playwright, and the API_Service compiles
 * to CommonJS. The error classes are therefore imported as types only and recognised by their `name`
 * and their fields rather than with `instanceof`: that keeps a pure text mapping out of the require
 * graph of a browser automation library, and it keeps the classification working even where the same
 * class was loaded twice through two module systems, which is exactly the situation in which
 * `instanceof` quietly answers `false`. {@link classifyPlatformError} is total over `unknown`, so no
 * thrown value can reach the user unclassified.
 *
 * Requirements: 2.5, 4.9, 4.10, 6.5, 6.8, 6.9, 7.4, 7.8, 8.5, 8.12, 8.13, 8.14, 9.9, 10.14, 12.5,
 * 12.7, 12.13, 12.14, 13.1, 13.3, 13.4, 13.5, 13.6, 13.8, 14.2, 14.3, 15.7, 15.9, 15.10, 15.11,
 * 15.12, 16.8.
 */

import {
  type CommuteMode,
  type CriterionField,
  type Platform,
  PLATFORM_STATUSES,
  type PlatformStatus,
  type RunOutcome,
} from '@job-scraper/domain';
import type {
  NormalizationNote,
  NormalizedJobPosting,
  RequiredPostingField,
} from '@job-scraper/scrapers';

import { commuteThresholdRejectedMessageDe } from '../config/config.messages';
import type { LogMessagePayload } from '../log-stream/log-stream.service';
import {
  PLATFORM_LABELS_DE,
  platformIncompleteConfigurationMessageDe,
} from '../platform-config/platform-config.messages';
import type { LogLevel } from '../prisma/prisma.types';

/**
 * What a mapped failure answers, and the whole of it.
 *
 * `platformStatus` and `runOutcome` are absent where the table's row leaves them unchanged — an
 * optional posting field, a failed relevance assessment and a rejected write all say nothing about
 * how a Platform or a Scrape_Run ended, and a mapping that invented a value for them would overwrite
 * a status the retrieval had already established.
 *
 * `userMessageDe` is the German sentence of 2.5: it names the cause and exactly one recommended next
 * step. It is also the text of the Log_Stream entry, so the Log_View and the summary cannot disagree
 * about what happened; the technical particulars go into the entry's `detail` instead.
 */
export interface FailureMapping {
  /** The Platform_Status to record for the affected Platform, where the failure determines one. */
  readonly platformStatus?: PlatformStatus;
  /** The Run_Outcome to record for the Scrape_Run, where the failure determines one. */
  readonly runOutcome?: RunOutcome;
  /** German text for the user: cause plus exactly one recommended next step (2.5). */
  readonly userMessageDe: string;
  /** Stable English log key, identical to the failure's `kind`. */
  readonly logCode: JobToolFailureKind;
  /** Level of the Log_Stream entry. */
  readonly logLevel: LogLevel;
}

/**
 * The fields of a Job_Posting whose absence keeps the posting but leaves the field empty (6.8).
 *
 * `satisfies` ties the list to the normalized posting shape, so renaming a field in
 * `NormalizedJobPosting` breaks the build here instead of producing a log entry about a field that
 * no longer exists. The three mandatory fields of 6.5 are not restated: `RequiredPostingField` in
 * `@job-scraper/scrapers` already declares them, and the normalization layer reports with it.
 */
export const OPTIONAL_POSTING_FIELDS = [
  'employer',
  'workLocation',
  'publishedAt',
  'descriptionText',
] as const satisfies readonly (keyof NormalizedJobPosting)[];

/** One of the four fields of 6.8. */
export type OptionalPostingField = (typeof OPTIONAL_POSTING_FIELDS)[number];

/** Why the Relevance_Service performs no assessment at all (15.9, 15.10). */
export type RelevanceDisabledReason = 'NO_API_KEY' | 'SWITCHED_OFF';

/**
 * Every failure of the Job_Tool that reaches the API_Service, one member per row of the design's
 * error table.
 *
 * The discriminator *is* the stable log code of that row. One identifier per row rather than a pair
 * of them: the code is what the table pins, what a test asserts on and what a developer greps for,
 * and deriving `logCode` from `kind` removes the one way the two could fall out of step.
 *
 * Each member carries exactly what its German sentence and its log detail need, and no more. Fields
 * that an adapter may or may not know — a page number, a source URL — are optional, and the sentence
 * is phrased for both cases rather than printing a guessed "Seite 1".
 */
export type JobToolFailure =
  /** The robots.txt of a Platform forbids an intended path (14.2). No page of it is requested. */
  | {
      readonly kind: 'robots.disallowed';
      readonly platform: Platform;
      /** The forbidden path, for the log detail. */
      readonly path?: string;
    }
  /** The robots.txt could not be fetched within 10 s or not be evaluated (14.3). */
  | { readonly kind: 'robots.unavailable'; readonly platform: Platform }
  /** The Platform shows its result list only after sign-in (7.2); no further attempt follows (7.8). */
  | {
      readonly kind: 'platform.signInRequired';
      readonly platform: Platform;
      readonly sourceUrl?: string;
    }
  /** A Captcha page or bot check was served (7.6); it is left unanswered and no attempt follows (7.8). */
  | { readonly kind: 'platform.blocked'; readonly platform: Platform; readonly sourceUrl?: string }
  /** A Result_Page loaded but yielded no readable Job_Posting (6.7). */
  | {
      readonly kind: 'platform.layoutUnknown';
      readonly platform: Platform;
      readonly pageNumber?: number;
      readonly sourceUrl?: string;
    }
  /**
   * A page request stayed without a result and a repetition follows (13.4).
   *
   * The only member that reports no Platform_Status: the retrieval has not ended, and recording a
   * status here would overwrite the one the finished retrieval is about to report.
   */
  | {
      readonly kind: 'page.retry';
      readonly platform: Platform;
      readonly pageNumber: number;
      /** The 1-based attempt that is about to be sent, at most 3 (13.4). */
      readonly attempt: number;
      /** How many attempts the Platform_Adapter is permitted, for the user-facing count. */
      readonly maxAttempts: number;
    }
  /** Every permitted attempt of a page request stayed without a result (13.8). */
  | { readonly kind: 'page.failed'; readonly platform: Platform; readonly pageNumber?: number }
  /** The Platform stayed unanswered at the transport level (6.10). */
  | {
      readonly kind: 'platform.unreachable';
      readonly platform: Platform;
      readonly pageNumber?: number;
    }
  /** The Platform reported an exceeded fetch rate (13.5); no further request reaches it this run. */
  | {
      readonly kind: 'platform.rateLimited';
      readonly platform: Platform;
      readonly pageNumber?: number;
    }
  /** The 10-page limit was reached (13.3). A normal end of retrieval, not a failure. */
  | {
      readonly kind: 'platform.pageLimit';
      readonly platform: Platform;
      readonly pagesFetched?: number;
    }
  /**
   * An activated Platform whose mandatory Criterion_Field do not resolve (4.9, 4.10, 5.8).
   *
   * The German text is built by `platform-config.messages.ts`, which already owns the wording and
   * the field labels for the startup check; this row only classifies it.
   */
  | {
      readonly kind: 'platform.incompleteConfiguration';
      readonly platform: Platform;
      readonly missingFields: readonly CriterionField[];
    }
  /**
   * A Job_Posting was discarded because a mandatory field was missing (6.5).
   *
   * Logged under the table's code `posting.discarded`; the normalization layer reports the same
   * observation under its own `posting.discardedMissingField`. The translation between the two is
   * this row, which is the point of a central mapping — see {@link failureForDiscardedPosting}.
   */
  | {
      readonly kind: 'posting.discarded';
      readonly platform: Platform;
      readonly field: RequiredPostingField;
      /** The Result_Page or posting URL, where one is known; `null` when the URL is what is missing. */
      readonly sourceUrl?: string | null;
    }
  /** An optional field was absent and the Job_Posting was stored with it empty (6.8, 10.15). */
  | {
      readonly kind: 'posting.fieldEmpty';
      readonly platform: Platform;
      readonly field: OptionalPostingField;
    }
  /** A non-empty publication date text could not be parsed (6.9). */
  | {
      readonly kind: 'posting.dateUnparsed';
      readonly platform: Platform;
      readonly sourceUrl?: string | null;
      /** The unparsable text, for the log detail only. */
      readonly rawText?: string | null;
    }
  /**
   * A single upsert into the Posting_Store was rejected (9.9).
   *
   * The repository propagates the original error — a Prisma `P1001` and the like — so `cause` is
   * that object, and the German sentence names the cause derived from its code. Emitting this is the
   * Scraper_Service's job (tasks 12.3, 12.9): only the caller of the per-posting loop can truthfully
   * say that the run continues, and only it holds the count for the run summary (task 11.7).
   */
  | {
      readonly kind: 'posting.writeFailed';
      readonly platform: Platform;
      readonly postingId: string;
      readonly cause?: unknown;
    }
  /** `setInterestFlag` was rejected (10.14). Nothing was persisted. */
  | {
      readonly kind: 'posting.interestFlagFailed';
      readonly postingId: string;
      readonly cause?: unknown;
    }
  /** The Routing_Provider failed or timed out for every permitted attempt (8.8, 8.13). */
  | {
      readonly kind: 'commute.providerFailed';
      readonly postingId: string;
      readonly mode: CommuteMode;
    }
  /** The work location yielded no coordinate (8.5, 8.6). */
  | {
      readonly kind: 'commute.geocodeFailed';
      readonly postingId: string;
      /** The work location value as stored, for the log detail only. */
      readonly rawLocation?: string | null;
    }
  /** The geocoder answered with a municipality or district centroid (8.12). */
  | {
      readonly kind: 'commute.imprecise';
      readonly postingId: string;
      /** The Best_Commute_Time in whole minutes, as it is shown. */
      readonly minutes: number;
    }
  /** The AI_Provider failed, timed out or rate-limited every permitted attempt (15.11). */
  | {
      readonly kind: 'relevance.requestFailed';
      readonly postingId: string;
      /** Stable English reason code of the Relevance_Service, for the log detail only. */
      readonly reasonCode?: string;
    }
  /** The AI response did not satisfy the schema (15.12, 15.14). Not retried. */
  | { readonly kind: 'relevance.schemaViolation'; readonly postingId: string }
  /** The per-run assessment budget is used up (15.7). */
  | { readonly kind: 'relevance.budgetReached'; readonly count: number }
  /** No API key, or the Relevance_Service is switched off (15.9, 15.10, 14.8). */
  | { readonly kind: 'relevance.disabled'; readonly reason: RelevanceDisabledReason }
  /**
   * A Commute_Threshold change was rejected (8.14).
   *
   * The German text is built by `config.messages.ts`, which owns the permitted range it names.
   */
  | { readonly kind: 'config.commuteThresholdInvalid'; readonly retainedMinutes: number }
  /**
   * The retrieval deadline was reached (13.6).
   *
   * `limitMinutes` is passed in rather than fixed here: the deadline is the Scraper_Service's
   * constant, and a second declaration of "30" would be a second thing to keep in step.
   */
  | { readonly kind: 'run.timeLimitReached'; readonly limitMinutes?: number }
  /** The enrichment grace deadline passed with work outstanding. */
  | {
      readonly kind: 'run.enrichmentDeadline';
      /** Job_Posting left without a Best_Commute_Time. */
      readonly commuteOutstanding: number;
      /** Job_Posting left at `NOT_ASSESSED`. */
      readonly relevanceOutstanding: number;
    }
  /**
   * The user cancelled a running Scrape_Run (12.7).
   *
   * No Platform_Status: an unfinished Platform keeps its last reported status or `NOT_YET_RUN`, which
   * is a per-Platform decision the Scraper_Service makes, not a single value this row could name.
   */
  | { readonly kind: 'run.cancelledByUser' }
  /** A cancellation reached a Scrape_Run that is not running (12.14). */
  | {
      readonly kind: 'run.cancelRejected';
      readonly runId: string;
      readonly runOutcome: RunOutcome;
    }
  /** The Scrape_Run could not be created (12.13). */
  | { readonly kind: 'run.createFailed'; readonly cause?: unknown }
  /** A second start was requested while a Scrape_Run is running (12.5). */
  | { readonly kind: 'run.alreadyRunning'; readonly runningRunId: string }
  /** A Scrape_Run left in status "running" by a process crash was closed at bootstrap (12.2, 9.7). */
  | { readonly kind: 'run.recoveredStale'; readonly runId: string };

/** The stable log code of a failure, which is also its discriminator. */
export type JobToolFailureKind = JobToolFailure['kind'];

/**
 * Marker map whose keys are the failure kinds.
 *
 * `Record<JobToolFailureKind, true>` is total by type, so a new member of the union is a compile
 * error here until it is listed — and {@link JOB_TOOL_FAILURE_KINDS} is derived from it, which is
 * what lets the totality test iterate the union at runtime without a second hand-written list.
 */
const FAILURE_KIND_MARKERS: Readonly<Record<JobToolFailureKind, true>> = {
  'robots.disallowed': true,
  'robots.unavailable': true,
  'platform.signInRequired': true,
  'platform.blocked': true,
  'platform.layoutUnknown': true,
  'page.retry': true,
  'page.failed': true,
  'platform.unreachable': true,
  'platform.rateLimited': true,
  'platform.pageLimit': true,
  'platform.incompleteConfiguration': true,
  'posting.discarded': true,
  'posting.fieldEmpty': true,
  'posting.dateUnparsed': true,
  'posting.writeFailed': true,
  'posting.interestFlagFailed': true,
  'commute.providerFailed': true,
  'commute.geocodeFailed': true,
  'commute.imprecise': true,
  'relevance.requestFailed': true,
  'relevance.schemaViolation': true,
  'relevance.budgetReached': true,
  'relevance.disabled': true,
  'config.commuteThresholdInvalid': true,
  'run.timeLimitReached': true,
  'run.enrichmentDeadline': true,
  'run.cancelledByUser': true,
  'run.cancelRejected': true,
  'run.createFailed': true,
  'run.alreadyRunning': true,
  'run.recoveredStale': true,
};

/** Every failure kind, in declaration order. The runtime view of the union. */
export const JOB_TOOL_FAILURE_KINDS = Object.keys(
  FAILURE_KIND_MARKERS,
) as readonly JobToolFailureKind[];

/**
 * The rows of the error table that are mapped elsewhere, with the reason and the owner.
 *
 * Here so that "every row is accounted for" is a statement a reader and a test can check, rather
 * than something to take on trust. The keys are descriptive, not log codes: these rows have none.
 */
export const UNMAPPED_FAILURE_OWNERS: Readonly<Record<string, string>> = {
  logStreamConnectionBroken: 'Web_App Log_View (12.11); the server logs nothing',
  logStreamReconnectExhausted: 'Web_App Log_View (12.12); the server logs nothing',
  invalidDefaultSearchProfile: 'apps/api/src/profile/profile.messages.ts (3.6); console, pre-start',
  missingConfigurationKey: 'apps/api/src/config/config.messages.ts (1.15); console, pre-start',
  containerRuntimeUnreachable: 'scripts/start.mjs (1.13); console',
  prismaMigrationFailed: 'scripts/start.mjs (1.14); console',
  serviceNotReady: 'scripts/start.mjs (1.11); console',
};

/** German labels of the three Run_Outcome values, for the summary and the rejection of 12.14. */
export const RUN_OUTCOME_LABELS_DE: Readonly<Record<RunOutcome, string>> = {
  COMPLETED: 'abgeschlossen',
  CANCELLED_BY_USER: 'abgebrochen',
  CANCELLED_BY_TIME_LIMIT: 'durch Zeitlimit beendet',
};

/**
 * German labels of all 14 Platform_Status values, for the per-Platform summary of 7.4.
 *
 * Short labels rather than sentences: the summary shows one status per requested Platform next to
 * its count, and the explaining sentences are the business of the failure rows above. Total over
 * `PlatformStatus`, so the four non-error values — `COMPLETED`, `DISABLED`,
 * `INCOMPLETE_CONFIGURATION` and `NOT_YET_RUN` — are covered as well, which is what keeps a
 * Platform that was never requested from being rendered as an error.
 */
export const PLATFORM_STATUS_LABELS_DE: Readonly<Record<PlatformStatus, string>> = {
  COMPLETED: 'vollständig abgefragt',
  DISABLED: 'im Quellcode deaktiviert',
  INCOMPLETE_CONFIGURATION: 'Konfiguration unvollständig',
  SIGN_IN_REQUIRED: 'Anmeldung erforderlich',
  PLATFORM_BLOCKED: 'Abruf blockiert',
  PLATFORM_UNREACHABLE: 'nicht erreichbar',
  PAGE_LAYOUT_UNKNOWN: 'Seitenaufbau unbekannt',
  PAGE_LIMIT_REACHED: 'Seitenlimit erreicht',
  FETCH_RATE_LIMITED: 'Abfragerate begrenzt',
  FAILED: 'fehlgeschlagen',
  EXCLUDED_BY_ROBOTS_TXT: 'durch robots.txt ausgeschlossen',
  ROBOTS_TXT_UNAVAILABLE: 'robots.txt nicht prüfbar',
  CANCELLED_BY_TIME_LIMIT: 'durch Zeitlimit beendet',
  NOT_YET_RUN: 'noch nicht abgefragt',
};

/** German labels of the two modes of transport (8.4). */
export const COMMUTE_MODE_LABELS_DE: Readonly<Record<CommuteMode, string>> = {
  BICYCLE: 'Fahrrad',
  TRANSIT: 'öffentliche Verkehrsmittel',
};

/** German labels of the three mandatory posting fields of 6.5. */
export const REQUIRED_POSTING_FIELD_LABELS_DE: Readonly<Record<RequiredPostingField, string>> = {
  title: 'Titel',
  sourceUrl: 'Link zur Anzeige',
  postingId: 'Kennung der Anzeige',
};

/** German labels of the four optional posting fields of 6.8. */
export const OPTIONAL_POSTING_FIELD_LABELS_DE: Readonly<Record<OptionalPostingField, string>> = {
  employer: 'Arbeitgeber',
  workLocation: 'Arbeitsort',
  publishedAt: 'Veröffentlichungsdatum',
  descriptionText: 'Beschreibung',
};

/**
 * The hint 7.4 asks for whenever at least one requested Platform ended with a status other than
 * "completed".
 */
export const RESULT_INCOMPLETE_HINT_DE =
  'Die Trefferliste ist unvollständig, weil mindestens eine Plattform nicht vollständig abgefragt ' +
  'werden konnte. Bitte den Suchlauf später wiederholen.';

/**
 * One line of the per-Platform summary of 7.4: the Platform, its single Platform_Status and the
 * number of Job_Posting taken over from it.
 *
 * @param platform The requested Platform.
 * @param status The one Platform_Status recorded for it in this Scrape_Run.
 * @param takenOverCount How many Job_Posting of that Platform the Scrape_Run stored.
 */
export const platformStatusLineDe = (
  platform: Platform,
  status: PlatformStatus,
  takenOverCount: number,
): string =>
  `${PLATFORM_LABELS_DE[platform]}: ${PLATFORM_STATUS_LABELS_DE[status]}, ` +
  `${String(takenOverCount)} Treffer übernommen.`;

/**
 * Whether the summary has to carry {@link RESULT_INCOMPLETE_HINT_DE} (7.4).
 *
 * @param statuses The Platform_Status of every Platform requested in the Scrape_Run.
 */
export const isResultIncomplete = (statuses: readonly PlatformStatus[]): boolean =>
  statuses.some((status) => status !== 'COMPLETED');

/**
 * The run-summary sentence for the failed writes of 9.9.
 *
 * Separate from the per-posting row above because the two are different statements on different
 * surfaces: the row explains one rejected write in the Log_View, this one tells the user how much of
 * the result list is missing. A count of 0 produces no sentence.
 *
 * @param failedWriteCount How many single upserts the Scrape_Run could not store.
 * @returns The sentence, or `null` when every write succeeded.
 */
export const failedWriteSummaryDe = (failedWriteCount: number): string | null =>
  failedWriteCount <= 0
    ? null
    : `${String(failedWriteCount)} Treffer konnten nicht gespeichert werden. ` +
      'Bitte den Suchlauf wiederholen, um sie erneut zu lesen.';

/**
 * A short German cause for a rejected database operation, derived from the Prisma error code.
 *
 * The code and nothing else: a driver message can contain the host, the user and in the worst case
 * the connection string of the Posting_Store, and none of that helps the person reading the sentence.
 * An unrecognised code is still printed, because `P2xxx` is a stable Prisma identifier rather than
 * data — but only after it has been checked against the code shape, so an arbitrary string on a
 * `code` property cannot ride into the message.
 *
 * Total over `unknown`: a rejection that is not an error object at all still yields a sentence.
 */
export const storeFailureCauseDe = (cause: unknown): string => {
  const code = prismaErrorCode(cause);

  switch (code) {
    case 'P1000':
      return 'Die Datenbank hat die Anmeldung abgelehnt.';
    case 'P1001':
    case 'P1002':
    case 'P1017':
      return 'Die Datenbank war nicht erreichbar.';
    case 'P1008':
    case 'P2024':
      return 'Die Datenbank hat zu lange nicht geantwortet.';
    case 'P2002':
      return 'Es ist bereits ein Eintrag mit demselben Schlüssel gespeichert.';
    case 'P2003':
      return 'Ein verknüpfter Datensatz fehlt.';
    case 'P2025':
      return 'Der zu ändernde Datensatz war nicht vorhanden.';
    default:
      return code === undefined
        ? 'Die Datenbank hat den Vorgang abgelehnt.'
        : `Die Datenbank hat den Vorgang abgelehnt (Fehlercode ${code}).`;
  }
};

/**
 * Maps one failure onto its row of the design's error table.
 *
 * Total over {@link JobToolFailure} by construction: the switch has one case per member and a
 * `default` that the compiler only accepts while the union is fully covered, so a new failure kind
 * is a build error rather than an English string in the Web_App.
 */
export function mapFailure(failure: JobToolFailure): FailureMapping {
  switch (failure.kind) {
    case 'robots.disallowed':
      return {
        platformStatus: 'EXCLUDED_BY_ROBOTS_TXT',
        logCode: failure.kind,
        logLevel: 'ERROR',
        userMessageDe:
          `Plattform ${label(failure.platform)} wurde nicht abgefragt, weil deren robots.txt den ` +
          'Abruf untersagt. Bitte die Treffer der übrigen Plattformen verwenden.',
      };

    case 'robots.unavailable':
      return {
        platformStatus: 'ROBOTS_TXT_UNAVAILABLE',
        logCode: failure.kind,
        logLevel: 'ERROR',
        userMessageDe:
          `Für ${label(failure.platform)} konnte die robots.txt nicht geprüft werden; die ` +
          'Plattform wurde übersprungen. Bitte den Suchlauf später wiederholen.',
      };

    case 'platform.signInRequired':
      return {
        platformStatus: 'SIGN_IN_REQUIRED',
        logCode: failure.kind,
        logLevel: 'WARN',
        userMessageDe:
          `${label(failure.platform)} zeigt Ergebnisse nur nach Anmeldung. Die Trefferliste ist ` +
          'für diese Plattform unvollständig. Bitte diese Plattform bei Bedarf direkt im Browser ' +
          'durchsuchen.',
      };

    case 'platform.blocked':
      return {
        platformStatus: 'PLATFORM_BLOCKED',
        logCode: failure.kind,
        logLevel: 'WARN',
        userMessageDe:
          `${label(failure.platform)} hat den automatischen Abruf blockiert. Bitte später erneut ` +
          'versuchen.',
      };

    case 'platform.layoutUnknown':
      return {
        platformStatus: 'PAGE_LAYOUT_UNKNOWN',
        logCode: failure.kind,
        logLevel: 'ERROR',
        userMessageDe:
          `Der Seitenaufbau von ${label(failure.platform)} hat sich geändert; es konnten keine ` +
          'Treffer gelesen werden. Bitte den Suchlauf später wiederholen; bleibt die Meldung ' +
          'bestehen, muss der Abruf dieser Plattform angepasst werden.',
      };

    case 'page.retry':
      return {
        // No Platform_Status: the retrieval continues, and the status of its end is not decided yet.
        logCode: failure.kind,
        logLevel: 'WARN',
        userMessageDe:
          `${label(failure.platform)}: Seite ${String(failure.pageNumber)} wird erneut abgerufen ` +
          `(Versuch ${String(failure.attempt)} von ${String(failure.maxAttempts)}). Bitte den ` +
          'Suchlauf weiterlaufen lassen.',
      };

    case 'page.failed':
      return {
        platformStatus: 'FAILED',
        logCode: failure.kind,
        logLevel: 'ERROR',
        userMessageDe:
          failure.pageNumber === undefined
            ? `${label(failure.platform)} hat nicht geantwortet. Die bis dahin gelesenen Treffer ` +
              'wurden gespeichert. Bitte den Suchlauf später wiederholen.'
            : `${label(failure.platform)} hat auf Seite ${String(failure.pageNumber)} nicht ` +
              'geantwortet. Treffer bis zu dieser Seite wurden gespeichert. Bitte den Suchlauf ' +
              'später wiederholen.',
      };

    case 'platform.unreachable':
      return {
        platformStatus: 'PLATFORM_UNREACHABLE',
        logCode: failure.kind,
        logLevel: 'ERROR',
        userMessageDe: `${label(failure.platform)} war nicht erreichbar. Bitte den Suchlauf später wiederholen.`,
      };

    case 'platform.rateLimited':
      return {
        platformStatus: 'FETCH_RATE_LIMITED',
        logCode: failure.kind,
        logLevel: 'WARN',
        userMessageDe:
          `${label(failure.platform)} hat die Abfragerate begrenzt. Der Abruf dieser Plattform ` +
          'wurde beendet. Bitte den Suchlauf später wiederholen.',
      };

    case 'platform.pageLimit':
      return {
        platformStatus: 'PAGE_LIMIT_REACHED',
        logCode: failure.kind,
        logLevel: 'INFO',
        userMessageDe:
          failure.pagesFetched === undefined
            ? `${label(failure.platform)}: Seitenlimit erreicht. Bitte die Suchkriterien ` +
              'einengen, wenn Treffer fehlen.'
            : `${label(failure.platform)}: Seitenlimit erreicht, es wurden ` +
              `${String(failure.pagesFetched)} Ergebnisseiten gelesen. Bitte die Suchkriterien ` +
              'einengen, wenn Treffer fehlen.',
      };

    case 'platform.incompleteConfiguration':
      return {
        platformStatus: 'INCOMPLETE_CONFIGURATION',
        logCode: failure.kind,
        logLevel: 'ERROR',
        // The owner of this wording is the startup check of 4.9; it names the missing fields with
        // their German labels and their constant identifiers. An empty list cannot be handed to it
        // without producing a dangling "fehlende Felder: ", so that case gets the generic sentence.
        userMessageDe:
          failure.missingFields.length === 0
            ? `${label(failure.platform)}: Konfiguration unvollständig. Bitte die Suchkriterien ` +
              'dieser Plattform im Quellcode vervollständigen.'
            : `${platformIncompleteConfigurationMessageDe(failure.platform, failure.missingFields)} ` +
              'Bitte die genannten Felder im Quellcode ergänzen.',
      };

    case 'posting.discarded':
      return {
        // The Platform_Status stays as it is: one unusable posting says nothing about the retrieval.
        logCode: failure.kind,
        logLevel: 'WARN',
        userMessageDe:
          `${label(failure.platform)}: Ein Treffer wurde verworfen, weil die Pflichtangabe ` +
          `"${REQUIRED_POSTING_FIELD_LABELS_DE[failure.field]}" fehlt. Bitte die Anzahl ` +
          'verworfener Treffer in der Zusammenfassung des Suchlaufs ansehen.',
      };

    case 'posting.fieldEmpty':
      return {
        logCode: failure.kind,
        logLevel: 'INFO',
        userMessageDe:
          `${label(failure.platform)}: Ein Treffer wurde ohne die Angabe ` +
          `"${OPTIONAL_POSTING_FIELD_LABELS_DE[failure.field]}" gespeichert. Bitte die ` +
          'Stellenanzeige über ihren Link öffnen, wenn diese Angabe benötigt wird.',
      };

    case 'posting.dateUnparsed':
      return {
        logCode: failure.kind,
        logLevel: 'WARN',
        userMessageDe:
          `${label(failure.platform)}: Das Veröffentlichungsdatum eines Treffers konnte nicht ` +
          'gelesen werden; der Treffer wird mit "Datum unbekannt" geführt. Bitte das Datum bei ' +
          'Bedarf in der Stellenanzeige nachsehen.',
      };

    case 'posting.writeFailed':
      return {
        logCode: failure.kind,
        logLevel: 'ERROR',
        userMessageDe:
          `${label(failure.platform)}: Der Treffer ${failure.postingId} konnte nicht gespeichert ` +
          `werden: ${storeFailureCauseDe(failure.cause)} Der Suchlauf wird mit den übrigen ` +
          'Treffern fortgesetzt; bitte ihn später wiederholen.',
      };

    case 'posting.interestFlagFailed':
      return {
        logCode: failure.kind,
        logLevel: 'ERROR',
        userMessageDe: 'Die Markierung konnte nicht gespeichert werden. Bitte erneut versuchen.',
      };

    case 'commute.providerFailed':
      return {
        logCode: failure.kind,
        logLevel: 'WARN',
        userMessageDe:
          'Die Erreichbarkeit eines Treffers konnte nicht ermittelt werden ' +
          `(${COMMUTE_MODE_LABELS_DE[failure.mode]}); sie wird als "Erreichbarkeit unbekannt" ` +
          'angezeigt. Beim nächsten Suchlauf wird die Ermittlung automatisch wiederholt.',
      };

    case 'commute.geocodeFailed':
      return {
        logCode: failure.kind,
        logLevel: 'WARN',
        userMessageDe:
          'Der Arbeitsort eines Treffers enthält keinen auffindbaren Ort; die Erreichbarkeit ' +
          'bleibt unbekannt. Bitte den Arbeitsort in der Stellenanzeige selbst ansehen.',
      };

    case 'commute.imprecise':
      return {
        logCode: failure.kind,
        logLevel: 'INFO',
        userMessageDe:
          `Erreichbarkeit ungefähr: ${String(failure.minutes)} Min. Der Arbeitsort ist nur auf ` +
          'Gemeindeebene bekannt; bitte die genaue Adresse in der Stellenanzeige ansehen.',
      };

    case 'relevance.requestFailed':
      return {
        logCode: failure.kind,
        logLevel: 'WARN',
        // The reason code stays in the log detail: it is a stable English key, and a German
        // sentence with an English token in it would be neither (16.8).
        userMessageDe:
          'Die KI-Bewertung eines Treffers ist fehlgeschlagen; der Treffer bleibt "nicht ' +
          'bewertet". Bitte den Treffer selbst ansehen.',
      };

    case 'relevance.schemaViolation':
      return {
        logCode: failure.kind,
        logLevel: 'ERROR',
        userMessageDe:
          'Die Antwort der KI-Bewertung war unbrauchbar; der Treffer bleibt "nicht bewertet". ' +
          'Bitte den Treffer selbst ansehen.',
      };

    case 'relevance.budgetReached':
      return {
        logCode: failure.kind,
        logLevel: 'INFO',
        userMessageDe:
          `Bewertungslimit erreicht: ${String(failure.count)} Treffer wurden nicht bewertet. ` +
          'Bitte diese Treffer selbst ansehen.',
      };

    case 'relevance.disabled':
      return {
        logCode: failure.kind,
        logLevel: 'INFO',
        userMessageDe:
          failure.reason === 'NO_API_KEY'
            ? 'KI-Bewertung ist deaktiviert, weil kein Zugangsschlüssel hinterlegt ist. Bitte den ' +
              'Schlüssel ANTHROPIC_API_KEY in der Umgebungsdatei eintragen, wenn die Bewertung ' +
              'genutzt werden soll.'
            : 'KI-Bewertung ist deaktiviert, weil sie in der Konfiguration abgeschaltet ist. ' +
              'Bitte RELEVANCE_ENABLED in der Umgebungsdatei auf "true" setzen, wenn die ' +
              'Bewertung genutzt werden soll.',
      };

    case 'config.commuteThresholdInvalid':
      return {
        logCode: failure.kind,
        logLevel: 'ERROR',
        // Owned by the configuration check, which declares the permitted range it names.
        userMessageDe: commuteThresholdRejectedMessageDe(failure.retainedMinutes),
      };

    case 'run.timeLimitReached':
      return {
        platformStatus: 'CANCELLED_BY_TIME_LIMIT',
        runOutcome: 'CANCELLED_BY_TIME_LIMIT',
        logCode: failure.kind,
        logLevel: 'WARN',
        userMessageDe:
          (failure.limitMinutes === undefined
            ? 'Das Zeitlimit des Suchlaufs wurde erreicht.'
            : `Zeitlimit von ${String(failure.limitMinutes)} Minuten erreicht.`) +
          ' Der Suchlauf wurde beendet. Bitte den Suchlauf erneut starten, wenn weitere Treffer ' +
          'gelesen werden sollen.',
      };

    case 'run.enrichmentDeadline':
      return {
        logCode: failure.kind,
        logLevel: 'WARN',
        userMessageDe:
          'Bewertung und Erreichbarkeit konnten nicht für alle Treffer ermittelt werden ' +
          `(${String(failure.commuteOutstanding)} ohne Erreichbarkeit, ` +
          `${String(failure.relevanceOutstanding)} ohne Bewertung). Beim nächsten Suchlauf wird ` +
          'die Ermittlung automatisch wiederholt.',
      };

    case 'run.cancelledByUser':
      return {
        // No Platform_Status: an unfinished Platform keeps its last reported one or NOT_YET_RUN.
        runOutcome: 'CANCELLED_BY_USER',
        logCode: failure.kind,
        logLevel: 'INFO',
        userMessageDe:
          'Suchlauf abgebrochen. Die bis dahin gespeicherten Treffer stehen in der Trefferliste; ' +
          'bitte den Suchlauf erneut starten, um die Suche fortzusetzen.',
      };

    case 'run.cancelRejected':
      return {
        logCode: failure.kind,
        logLevel: 'INFO',
        userMessageDe:
          `Dieser Suchlauf läuft nicht mehr; Ergebnis: ` +
          `${RUN_OUTCOME_LABELS_DE[failure.runOutcome]}. Bitte einen neuen Suchlauf starten.`,
      };

    case 'run.createFailed':
      return {
        logCode: failure.kind,
        logLevel: 'ERROR',
        userMessageDe:
          `Der Suchlauf konnte nicht gestartet werden: ${storeFailureCauseDe(failure.cause)} ` +
          'Bitte erneut versuchen.',
      };

    case 'run.alreadyRunning':
      return {
        logCode: failure.kind,
        logLevel: 'INFO',
        userMessageDe: 'Es läuft bereits ein Suchlauf. Bitte das Log öffnen, um ihn zu verfolgen.',
      };

    case 'run.recoveredStale':
      return {
        platformStatus: 'CANCELLED_BY_TIME_LIMIT',
        runOutcome: 'CANCELLED_BY_TIME_LIMIT',
        logCode: failure.kind,
        logLevel: 'WARN',
        userMessageDe:
          'Suchlauf durch Neustart beendet. Die gespeicherten Treffer bleiben erhalten; bitte ' +
          'einen neuen Suchlauf starten.',
      };

    default:
      // `failure` is `never` here while the union is covered, so an unmapped kind fails the build.
      return unmappedFailure(failure);
  }
}

/**
 * The Log_Stream entry of a failure, without the `runId` its emitter owns.
 *
 * Typed as the payload of `LogStreamService.emit` minus that field, so the two cannot drift: a
 * caller writes `logStream.emit({ runId, ...failureLogEntry(failure) })` and the compiler checks the
 * result. The `detail` carries the technical particulars the table's log column names — platform,
 * path, page number, Posting_Id, field name, the raw error — which is where they belong: `emit`
 * masks `detail` before the write (14.9), and the German text stays free of them.
 */
export type FailureLogEntry = Omit<LogMessagePayload, 'runId'>;

/**
 * Builds the Log_Stream entry of a failure.
 *
 * Where a Platform_Adapter has already emitted its own line for the same observation, do not call
 * this as well — forward the adapter's event and take only the Platform_Status and the summary
 * sentence from {@link mapFailure}. Two entries for one observation would make the Log_View read as
 * if the Job_Tool had seen the thing twice.
 */
/** The stable log code of the Robots_Policy warning of 14.12. */
export const ROBOTS_IGNORED_LOG_CODE = 'robots.ignoredByPolicy';

/**
 * The Log_Stream entry for a Platform the Job_Tool retrieves although its robots.txt asks it not to
 * (14.11, 14.12).
 *
 * `WARN` rather than `ERROR`: nothing failed, and the retrieval is doing what the configuration
 * says. But it is not `INFO` either, because the decision is one the user should notice every time
 * rather than once in a configuration file they edited months ago.
 *
 * The German sentence names the Platform, what the robots.txt said and that the Job_Tool went ahead
 * anyway. It states the configured value by name so the reader can find the switch — the single
 * non-technical user is still the audience, and "Einstellung" plus the key is what turns the line
 * from a mystery into something they can act on.
 */
export function robotsIgnoredLogEntry(
  platform: Platform,
  status: 'EXCLUDED_BY_ROBOTS_TXT' | 'ROBOTS_TXT_UNAVAILABLE',
  disallowedPaths: readonly string[],
): FailureLogEntry {
  const cause =
    status === 'EXCLUDED_BY_ROBOTS_TXT'
      ? `Die robots.txt von ${label(platform)} untersagt den Abruf` +
        (disallowedPaths[0] === undefined ? '' : ` von ${disallowedPaths[0]}`)
      : `Die robots.txt von ${label(platform)} konnte nicht geprüft werden`;

  return {
    level: 'WARN',
    code: ROBOTS_IGNORED_LOG_CODE,
    messageDe:
      `${cause}. Die Plattform wurde trotzdem abgefragt, weil die Einstellung ` +
      'ROBOTS_POLICY auf "ignore" steht.',
    platform,
    ...(disallowedPaths.length === 0 ? {} : { detail: { disallowedPaths: [...disallowedPaths] } }),
  };
}

export function failureLogEntry(failure: JobToolFailure): FailureLogEntry {
  const mapping = mapFailure(failure);
  const platform = platformOf(failure);
  const detail = detailOf(failure);

  return {
    level: mapping.logLevel,
    code: mapping.logCode,
    messageDe: mapping.userMessageDe,
    ...(platform === undefined ? {} : { platform }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** What the caller knows about the place an error was raised in. */
export interface PlatformErrorContext {
  /** The Platform whose retrieval raised the error. */
  readonly platform: Platform;
  /** The 1-based Result_Page, where the caller knows it and the error carries none. */
  readonly pageNumber?: number;
  /** The Result_Page URL, where the caller knows it and the error carries none. */
  readonly sourceUrl?: string;
  /**
   * What an abort means, when the caller knows the Scrape_Run was cancelled.
   *
   * Passed in rather than read off the thrown value: the cancellation reason travels through an
   * `AbortSignal` and is forwarded unchanged by the `PlatformQueue`, so only the component that
   * aborted can say whether the user asked for it (12.7) or the deadline did (13.6).
   */
  readonly cancellation?:
    | { readonly kind: 'BY_USER' }
    | { readonly kind: 'BY_TIME_LIMIT'; readonly limitMinutes?: number };
}

/**
 * Classifies anything a Platform retrieval can throw (13.1).
 *
 * Total over `unknown`, which is the point: the Scraper_Service has to close every Platform with one
 * of the 14 permitted Platform_Status values whatever lands in its catch block, so an unrecognised
 * value maps to the `FAILED` row rather than escaping as a technical string.
 *
 * The order of the checks is the order of the error table's specificity:
 *
 * 1. An adapter error names the Platform_Status it stands for, so it decides.
 * 2. An exhausted attempt series is the `FAILED` row of 13.8.
 * 3. A closed platform queue is not a cause of its own — it is the consequence of the error that
 *    closed it (13.5) — so the cause chain is followed and classified instead. Without that, the
 *    second request after a sign-in prompt would turn `SIGN_IN_REQUIRED` into `FAILED`.
 * 4. A cancellation the caller told us about maps to its run row.
 * 5. Anything else is the `FAILED` row.
 *
 * A retryable request error is deliberately *not* the retry row: by the time it reaches a caller the
 * queue has given up on it, and the retry row is emitted by the queue's own attempt loop.
 */
export function classifyPlatformError(
  error: unknown,
  context: PlatformErrorContext,
): JobToolFailure {
  return classifyThrown(error, context, new Set<unknown>());
}

/**
 * The classification proper, with the values already visited along a `cause` chain.
 *
 * The chain is followed one link at a time and every link is classified on its own merits, so a
 * queue closed by a sign-in prompt reports the sign-in row rather than `FAILED`. `visited` is what
 * makes that safe against a wrapper that names itself, or two wrappers that name each other: a
 * value is classified at most once, so no chain can loop.
 */
function classifyThrown(
  error: unknown,
  context: PlatformErrorContext,
  visited: Set<unknown>,
): JobToolFailure {
  const adapterError = asAdapterError(error);

  if (adapterError !== undefined) {
    return failureForAdapterStatus(adapterError, context);
  }

  const name = errorNameOf(error);

  if (name === 'RequestAttemptsExhaustedError') {
    return pageFailed(context);
  }

  if (name === 'PlatformQueueClosedError' && !visited.has(error)) {
    visited.add(error);

    const cause = propertyOf(error, 'cause');

    if (cause !== undefined && cause !== null && !visited.has(cause)) {
      return classifyThrown(cause, context, visited);
    }

    return pageFailed(context);
  }

  const cancellation = context.cancellation;

  if (cancellation !== undefined) {
    return cancellation.kind === 'BY_USER'
      ? { kind: 'run.cancelledByUser' }
      : { kind: 'run.timeLimitReached', limitMinutes: cancellation.limitMinutes };
  }

  return pageFailed(context);
}

/** {@link classifyPlatformError} followed by {@link mapFailure}, for a caller that needs only the row. */
export function mapPlatformError(error: unknown, context: PlatformErrorContext): FailureMapping {
  return mapFailure(classifyPlatformError(error, context));
}

/**
 * The failure of a Job_Posting the normalization layer discarded (6.5).
 *
 * Takes the layer's own report rather than loose arguments, so the field and the source URL cannot
 * be paired with the wrong platform on the way here.
 */
export function failureForDiscardedPosting(discarded: {
  readonly platform: Platform;
  readonly field: RequiredPostingField;
  readonly sourceUrl: string | null;
}): JobToolFailure {
  return {
    kind: 'posting.discarded',
    platform: discarded.platform,
    field: discarded.field,
    sourceUrl: discarded.sourceUrl,
  };
}

/**
 * The failure behind a normalization note (6.9).
 *
 * Total over `NormalizationNote`, so a note added to the normalization layer later has to be given
 * its row here before it compiles.
 */
export function failureForNormalizationNote(
  note: NormalizationNote,
  context: {
    readonly platform: Platform;
    readonly sourceUrl?: string | null;
    readonly rawText?: string | null;
  },
): JobToolFailure {
  switch (note) {
    case 'posting.publicationDateUnparsable':
      return {
        kind: 'posting.dateUnparsed',
        platform: context.platform,
        sourceUrl: context.sourceUrl,
        rawText: context.rawText,
      };

    default:
      return unmappedNote(note);
  }
}

/** The German label of a Platform, as the user sees it spelled. */
const label = (platform: Platform): string => PLATFORM_LABELS_DE[platform];

/** The `FAILED` row of 13.1 and 13.8, with whatever page number the caller knows. */
const pageFailed = (context: PlatformErrorContext): JobToolFailure => ({
  kind: 'page.failed',
  platform: context.platform,
  pageNumber: context.pageNumber,
});

/** The shape of an adapter error, as far as the classification reads it. */
interface AdapterErrorShape {
  readonly platform: Platform;
  readonly platformStatus: PlatformStatus;
  readonly pageNumber?: number;
  readonly sourceUrl?: string;
}

/** The permitted Platform_Status values as a set, for validating a value off an unknown object. */
const PLATFORM_STATUS_SET: ReadonlySet<string> = new Set<string>(PLATFORM_STATUSES);

/** A readable property of an unknown value, or `undefined` where there is none. */
const propertyOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;

/** The `name` of a thrown value, where it carries one. */
const errorNameOf = (error: unknown): string | undefined => {
  const name = propertyOf(error, 'name');

  return typeof name === 'string' ? name : undefined;
};

/** A string property, where it is present and non-empty. */
const stringPropertyOf = (value: unknown, key: string): string | undefined => {
  const property = propertyOf(value, key);

  return typeof property === 'string' && property.length > 0 ? property : undefined;
};

/** A positive integer property, where it is present. */
const integerPropertyOf = (value: unknown, key: string): number | undefined => {
  const property = propertyOf(value, key);

  return typeof property === 'number' && Number.isInteger(property) && property > 0
    ? property
    : undefined;
};

/**
 * Reads an adapter error off an unknown thrown value.
 *
 * Structural rather than `instanceof` — see the note at the top of the file — and strict about what
 * it accepts: the `platformStatus` has to be one of the 14 permitted values, so an unrelated object
 * that happens to carry such a field cannot smuggle an invented status into a Scrape_Run.
 */
const asAdapterError = (error: unknown): AdapterErrorShape | undefined => {
  const platformStatus = propertyOf(error, 'platformStatus');
  const platform = propertyOf(error, 'platform');

  if (
    typeof platformStatus !== 'string' ||
    !PLATFORM_STATUS_SET.has(platformStatus) ||
    typeof platform !== 'string'
  ) {
    return undefined;
  }

  return {
    platform: platform as Platform,
    platformStatus: platformStatus as PlatformStatus,
    pageNumber: integerPropertyOf(error, 'pageNumber'),
    sourceUrl: stringPropertyOf(error, 'sourceUrl'),
  };
};

/**
 * The row an adapter error's Platform_Status stands for.
 *
 * Every one of the 14 values is answered for, because {@link AdapterError} stays usable on its own
 * and a later adapter may report a status none of today's subclasses does. The four values that
 * describe no failure — `COMPLETED`, `DISABLED`, `INCOMPLETE_CONFIGURATION` carried by an *error*,
 * and `NOT_YET_RUN` — fall through to the `FAILED` row: an error that claims a Platform completed is
 * a contradiction, and 13.1 answers contradictions with "failed".
 */
const failureForAdapterStatus = (
  error: AdapterErrorShape,
  context: PlatformErrorContext,
): JobToolFailure => {
  const platform = error.platform;
  const pageNumber = error.pageNumber ?? context.pageNumber;
  const sourceUrl = error.sourceUrl ?? context.sourceUrl;

  switch (error.platformStatus) {
    case 'SIGN_IN_REQUIRED':
      return { kind: 'platform.signInRequired', platform, sourceUrl };
    case 'PLATFORM_BLOCKED':
      return { kind: 'platform.blocked', platform, sourceUrl };
    case 'PAGE_LAYOUT_UNKNOWN':
      return { kind: 'platform.layoutUnknown', platform, pageNumber, sourceUrl };
    case 'FETCH_RATE_LIMITED':
      return { kind: 'platform.rateLimited', platform, pageNumber };
    case 'PLATFORM_UNREACHABLE':
      return { kind: 'platform.unreachable', platform, pageNumber };
    case 'PAGE_LIMIT_REACHED':
      return { kind: 'platform.pageLimit', platform, pagesFetched: pageNumber };
    case 'EXCLUDED_BY_ROBOTS_TXT':
      return { kind: 'robots.disallowed', platform, path: sourceUrl };
    case 'ROBOTS_TXT_UNAVAILABLE':
      return { kind: 'robots.unavailable', platform };
    case 'INCOMPLETE_CONFIGURATION':
      return { kind: 'platform.incompleteConfiguration', platform, missingFields: [] };
    case 'CANCELLED_BY_TIME_LIMIT':
      return {
        kind: 'run.timeLimitReached',
        limitMinutes:
          context.cancellation?.kind === 'BY_TIME_LIMIT'
            ? context.cancellation.limitMinutes
            : undefined,
      };
    case 'COMPLETED':
    case 'DISABLED':
    case 'FAILED':
    case 'NOT_YET_RUN':
      return { kind: 'page.failed', platform, pageNumber };
    default:
      return unmappedPlatformStatus(error.platformStatus);
  }
};

/** The Platform a failure belongs to, where it names one. */
const platformOf = (failure: JobToolFailure): Platform | undefined => {
  const platform = propertyOf(failure, 'platform');

  return typeof platform === 'string' ? (platform as Platform) : undefined;
};

/** Drops absent entries, so a `detail` never carries a key with no value. Empty becomes absent. */
const detailOf = (failure: JobToolFailure): PrismaJson.LogMessageDetailJson | undefined => {
  const entries = Object.entries(detailFieldsOf(failure)).filter(
    ([, value]) => value !== undefined,
  );

  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

/**
 * The structured context of each row, as the table's log column names it.
 *
 * The platform is not repeated in here: it travels in the entry's own `platform` column. Raw inputs
 * — an unparsable date text, a work location, a rejected error object — are passed through
 * unedited, because `LogStreamService.emit` masks `detail` before the write (14.9) and a mapping
 * that pre-sanitised would only hide what a developer needs to read.
 */
const detailFieldsOf = (failure: JobToolFailure): Record<string, unknown> => {
  switch (failure.kind) {
    case 'robots.disallowed':
      return { path: failure.path };
    case 'platform.signInRequired':
    case 'platform.blocked':
      return { sourceUrl: failure.sourceUrl };
    case 'platform.layoutUnknown':
      return { pageNumber: failure.pageNumber, sourceUrl: failure.sourceUrl };
    case 'page.retry':
      return {
        pageNumber: failure.pageNumber,
        attempt: failure.attempt,
        maxAttempts: failure.maxAttempts,
      };
    case 'page.failed':
    case 'platform.unreachable':
    case 'platform.rateLimited':
      return { pageNumber: failure.pageNumber };
    case 'platform.pageLimit':
      return { pagesFetched: failure.pagesFetched };
    case 'platform.incompleteConfiguration':
      return { fields: failure.missingFields };
    case 'posting.discarded':
      return { field: failure.field, sourceUrl: failure.sourceUrl };
    case 'posting.fieldEmpty':
      return { field: failure.field };
    case 'posting.dateUnparsed':
      return { sourceUrl: failure.sourceUrl, rawText: failure.rawText };
    case 'posting.writeFailed':
      return { postingId: failure.postingId, cause: describeCause(failure.cause) };
    case 'posting.interestFlagFailed':
      return { postingId: failure.postingId, cause: describeCause(failure.cause) };
    case 'commute.providerFailed':
      return { postingId: failure.postingId, mode: failure.mode };
    case 'commute.geocodeFailed':
      return { postingId: failure.postingId, rawLocation: failure.rawLocation };
    case 'commute.imprecise':
      return { postingId: failure.postingId, minutes: failure.minutes };
    case 'relevance.requestFailed':
      return { postingId: failure.postingId, reasonCode: failure.reasonCode };
    case 'relevance.schemaViolation':
      return { postingId: failure.postingId };
    case 'relevance.budgetReached':
      return { count: failure.count };
    case 'relevance.disabled':
      return { reason: failure.reason };
    case 'config.commuteThresholdInvalid':
      return { retainedMinutes: failure.retainedMinutes };
    case 'run.timeLimitReached':
      return { limitMinutes: failure.limitMinutes };
    case 'run.enrichmentDeadline':
      return {
        commuteOutstanding: failure.commuteOutstanding,
        relevanceOutstanding: failure.relevanceOutstanding,
      };
    case 'run.cancelRejected':
      return { runId: failure.runId, runOutcome: failure.runOutcome };
    case 'run.createFailed':
      return { cause: describeCause(failure.cause) };
    case 'run.alreadyRunning':
      return { runningRunId: failure.runningRunId };
    case 'run.recoveredStale':
      return { runId: failure.runId };
    // Two rows carry nothing beyond the platform column and the code: the unavailable robots.txt
    // names only its Platform, and a cancellation by the user names only the run it belongs to.
    case 'robots.unavailable':
    case 'run.cancelledByUser':
      return {};
    default:
      return unmappedDetail(failure);
  }
};

/**
 * A rejected operation reduced to what a log reader can use: the error's name, its Prisma code and
 * its message.
 *
 * The message is included here and nowhere else. The `detail` of a Log_Stream entry is the one place
 * the design puts technical particulars (2.5) and `emit` masks it on the way to the store, whereas
 * the German sentence is read by a person who cannot act on a driver string.
 */
const describeCause = (cause: unknown): Record<string, unknown> | undefined => {
  if (cause === undefined || cause === null) {
    return undefined;
  }

  const code = prismaErrorCode(cause);
  const name = errorNameOf(cause);
  const message = stringPropertyOf(cause, 'message');

  if (code === undefined && name === undefined && message === undefined) {
    return { value: String(cause) };
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
  };
};

/** The shape of a Prisma error code: the letter `P` and four digits. */
const PRISMA_ERROR_CODE_PATTERN = /^P\d{4}$/;

/**
 * The Prisma error code of a rejection, where it carries one in that exact shape.
 *
 * The shape check is what makes the code safe to print in a German sentence: an arbitrary string on
 * a `code` property — a provider response, a message with a key in it — is rejected instead.
 */
const prismaErrorCode = (cause: unknown): string | undefined => {
  const code = stringPropertyOf(cause, 'code');

  return code !== undefined && PRISMA_ERROR_CODE_PATTERN.test(code) ? code : undefined;
};

/** Reached only if a failure kind is added without a row; `never` makes that a build error. */
function unmappedFailure(failure: never): never {
  throw new TypeError(`No error-table row for failure ${JSON.stringify(failure)}.`);
}

/** Reached only if a failure kind is added without log detail; `never` makes that a build error. */
function unmappedDetail(failure: never): never {
  throw new TypeError(`No log detail for failure ${JSON.stringify(failure)}.`);
}

/** Reached only if a normalization note is added without a row. */
function unmappedNote(note: never): never {
  throw new TypeError(`No error-table row for normalization note ${String(note)}.`);
}

/** Reached only if `PLATFORM_STATUSES` gains a value without a classification. */
function unmappedPlatformStatus(status: never): never {
  throw new TypeError(`No error-table row for Platform_Status ${String(status)}.`);
}
