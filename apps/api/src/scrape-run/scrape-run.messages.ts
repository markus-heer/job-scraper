/**
 * The German lifecycle texts of a Scrape_Run that the central error mapping does not carry.
 *
 * Everything the design's error table lists — the already-running hint (12.5), the cancellation
 * (12.7), the rejected cancellation (12.14), the failed creation (12.13) — has its German wording in
 * `src/common/error-mapping.ts`, and the coordinator takes it from there through `failureLogEntry`
 * so there is exactly one wording per case. What is left are the cases the table has no row for,
 * because none of them is a failure:
 *
 * - the first line of a Scrape_Run's log, which the Log_View of 12.2 opens on;
 * - a cancellation for an identifier the Posting_Store does not know, which the coordinator
 *   distinguishes from a run that merely is not running;
 * - the end-of-run summary of 7.4 and 12.10, which reports how a run that *did* happen turned out.
 *
 * The summary deliberately composes what the error mapping owns instead of restating it: the
 * Run_Outcome labels, the Platform_Status labels, the per-Platform line of 7.4, the incompleteness
 * hint and the sentence about rejected writes all come from there, and this file only adds the
 * runtime and the new/updated split that 12.10 asks for and that no error row carries.
 *
 * German for the user, stable English codes next to them — the split
 * `src/config/config.messages.ts` and `src/platform-config/platform-config.messages.ts` use.
 *
 * Requirements: 7.4, 12.1, 12.3, 12.10, 12.14, 16.8.
 */

import {
  failedWriteSummaryDe,
  isResultIncomplete,
  platformStatusLineDe,
  RESULT_INCOMPLETE_HINT_DE,
  RUN_OUTCOME_LABELS_DE,
} from '../common/error-mapping';
import type { Platform, PlatformStatus, RunOutcome } from '../prisma/prisma.types';

/** The first line of a Scrape_Run's log: the run exists and the retrieval is starting (12.1). */
export const runStartedMessageDe = (): string =>
  'Suchlauf gestartet. Der Fortschritt erscheint fortlaufend in diesem Log.';

/**
 * A cancellation for an identifier the Posting_Store does not know.
 *
 * Not a Log_Stream line: a message needs an existing Scrape_Run to belong to, and this is the case
 * where none exists. It is the German hint the run mutation of task 12.4 returns instead, and the
 * one `CancelRejection` of the coordinator that the error table leaves open.
 */
export const runUnknownMessageDe = (): string =>
  'Dieser Suchlauf ist nicht gespeichert. Bitte die Seite neu laden und einen neuen Suchlauf starten.';

/** What the summary reports about one Platform the Scrape_Run requested (7.4, 12.10). */
export interface RunSummaryPlatform {
  readonly platform: Platform;
  /** The one Platform_Status recorded for it in this Scrape_Run. */
  readonly platformStatus: PlatformStatus;
  /** Job_Posting of this Platform recorded for the first time in this Scrape_Run. */
  readonly newPostings: number;
  /** Job_Posting of this Platform that were already stored and were sighted again. */
  readonly updatedPostings: number;
}

/** Everything the end-of-run summary states (7.4, 12.10). */
export interface RunSummary {
  readonly runOutcome: RunOutcome;
  /** How long the Scrape_Run ran, in milliseconds, measured from its stored start time. */
  readonly runtimeMs: number;
  /** One entry per requested Platform, in `PLATFORMS` order. */
  readonly platforms: readonly RunSummaryPlatform[];
  /** Job_Posting whose single upsert the Posting_Store rejected across every Platform (9.9). */
  readonly failedWrites: number;
}

const MS_PER_SECOND = 1000;

const SECONDS_PER_MINUTE = 60;

/**
 * The runtime of a Scrape_Run in minutes and seconds, as 12.10 asks for it.
 *
 * Both parts are always printed, including a zero: "0 Min. 7 Sek." says that the run was that
 * short, whereas "7 Sek." would leave the reader to wonder whether the minutes were dropped or
 * unknown. A negative or non-finite input — two clock reads that crossed, or a missing start time —
 * is reported as zero rather than as a nonsensical duration.
 */
export const runtimeLabelDe = (runtimeMs: number): string => {
  const total =
    Number.isFinite(runtimeMs) && runtimeMs > 0 ? Math.floor(runtimeMs / MS_PER_SECOND) : 0;
  const minutes = Math.floor(total / SECONDS_PER_MINUTE);
  const seconds = total % SECONDS_PER_MINUTE;

  return `${String(minutes)} Min. ${String(seconds)} Sek.`;
};

/**
 * One line of the summary for one requested Platform (7.4, 12.10).
 *
 * The first sentence is the 7.4 line verbatim, built by the error mapping that owns the
 * Platform_Status labels and the "Treffer übernommen" wording. The second sentence is the part
 * 12.10 adds — how many of those are new and how many were sighted again — and it is omitted where
 * the Platform produced nothing: "Davon 0 neu und 0 aktualisiert." would only repeat the zero the
 * line before it already states.
 */
const platformSummaryLineDe = (platform: RunSummaryPlatform): string => {
  const takenOver = platform.newPostings + platform.updatedPostings;
  const line = platformStatusLineDe(platform.platform, platform.platformStatus, takenOver);

  return takenOver === 0
    ? line
    : `${line} Davon ${String(platform.newPostings)} neu und ` +
        `${String(platform.updatedPostings)} aktualisiert.`;
};

/**
 * The end-of-run summary of a Scrape_Run (7.4, 12.10).
 *
 * One message rather than one per statement, because 12.10 asks the Log_View to show *a* summary
 * when the run ends and a reader should not have to assemble it from five consecutive lines. Its
 * parts, in order: how the run ended and how long it took, one line per requested Platform with
 * that Platform's single Platform_Status and its new and updated counts, the incompleteness hint of
 * 7.4 where at least one Platform ended with something other than "completed", and the sentence
 * about rejected writes of 9.9 where there were any.
 *
 * Line breaks separate the parts: the per-Platform lines are a list, and a list run together into
 * one paragraph is what makes a four-Platform summary unreadable.
 */
export const runSummaryMessageDe = (summary: RunSummary): string => {
  const head =
    `Suchlauf ${RUN_OUTCOME_LABELS_DE[summary.runOutcome]}. ` +
    `Laufzeit: ${runtimeLabelDe(summary.runtimeMs)}.`;
  const lines = summary.platforms.map(platformSummaryLineDe);
  const incomplete = isResultIncomplete(
    summary.platforms.map((platform) => platform.platformStatus),
  )
    ? [RESULT_INCOMPLETE_HINT_DE]
    : [];
  const failed = failedWriteSummaryDe(summary.failedWrites);

  return [head, ...lines, ...incomplete, ...(failed === null ? [] : [failed])].join('\n');
};
