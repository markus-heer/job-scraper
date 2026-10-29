/**
 * The German Log_Stream lines of the Stepstone Platform_Adapter (12.3, 16.8).
 *
 * Why German text lives here and not in the error mapping of the API_Service: an
 * {@link AdapterLogEvent} carries `messageDe` by construction, because the Log_View shows the progress
 * of a running Scrape_Run line by line and only the adapter knows the page number and the number of
 * Job_Posting found on it. The *user-facing* wording of a Platform_Status — the summary sentence of
 * 7.4 — stays in the API_Service error mapping; the two are different texts for different surfaces,
 * and the sentences below deliberately match the Log_Stream column of the design's error table so that
 * a reader of the Log_View and a reader of the summary see the same cause.
 *
 * The English `code` of every event is the stable key tests assert on and the key the error mapping
 * reads. It is taken from the error classes of `../../adapter/errors.ts` wherever one exists, so the
 * two never drift.
 */

import type { PlatformStatus } from '@job-scraper/domain';

import type { AdapterError } from '../../adapter/errors.js';
import type { AdapterLogEvent, AdapterLogLevel } from '../../adapter/types.js';

/** How the Platform is named in German text. */
const PLATFORM_LABEL = 'Stepstone';

/** One read Result_Page: the progress line of 6.2 and 12.3, with pages read and postings found. */
export function pageFetchedEvent(
  pageNumber: number,
  postingCount: number,
  sourceUrl: string,
): AdapterLogEvent {
  return {
    level: 'INFO',
    code: 'platform.pageFetched',
    messageDe: `${PLATFORM_LABEL}: Seite ${String(pageNumber)} gelesen, ${String(postingCount)} Treffer gefunden.`,
    pageNumber,
    sourceUrl,
  };
}

/** The search matched nothing. Not a failure; the Web_App shows the "keine Treffer" hint of 2.8. */
export function emptyResultListEvent(pageNumber: number, sourceUrl: string): AdapterLogEvent {
  return {
    level: 'INFO',
    code: 'platform.noResults',
    messageDe: `${PLATFORM_LABEL}: keine Treffer für die aktuellen Suchkriterien.`,
    pageNumber,
    sourceUrl,
  };
}

/** The result list was read to its end before the page limit. */
export function resultListCompleteEvent(
  pagesFetched: number,
  postingCount: number,
): AdapterLogEvent {
  return {
    level: 'INFO',
    code: 'platform.resultListComplete',
    messageDe: `${PLATFORM_LABEL}: Ergebnisliste vollständig gelesen, ${String(pagesFetched)} Seiten mit ${String(postingCount)} Treffern.`,
    pageNumber: pagesFetched,
  };
}

/** The 10-page limit of 13.3 was reached while further Result_Page existed. */
export function pageLimitReachedEvent(pagesFetched: number): AdapterLogEvent {
  return {
    level: 'INFO',
    code: 'platform.pageLimit',
    messageDe: `${PLATFORM_LABEL}: Seitenlimit erreicht, es wurden ${String(pagesFetched)} Ergebnisseiten gelesen.`,
    pageNumber: pagesFetched,
  };
}

/** Level and German text per Platform_Status an ended Stepstone retrieval can report. */
const END_OF_RETRIEVAL: Partial<
  Record<PlatformStatus, { readonly level: AdapterLogLevel; readonly messageDe: string }>
> = {
  SIGN_IN_REQUIRED: {
    level: 'WARN',
    messageDe: `${PLATFORM_LABEL} zeigt Ergebnisse nur nach Anmeldung. Die Trefferliste ist für diese Plattform unvollständig.`,
  },
  PLATFORM_BLOCKED: {
    level: 'WARN',
    messageDe: `${PLATFORM_LABEL} hat den automatischen Abruf blockiert. Bitte später erneut versuchen.`,
  },
  PAGE_LAYOUT_UNKNOWN: {
    level: 'ERROR',
    messageDe: `Der Seitenaufbau von ${PLATFORM_LABEL} hat sich geändert; es konnten keine Treffer gelesen werden.`,
  },
  FETCH_RATE_LIMITED: {
    level: 'WARN',
    messageDe: `${PLATFORM_LABEL} hat die Abfragerate begrenzt. Der Abruf dieser Plattform wurde beendet.`,
  },
  PLATFORM_UNREACHABLE: {
    level: 'ERROR',
    messageDe: `${PLATFORM_LABEL} war nicht erreichbar. Bitte den Suchlauf später wiederholen.`,
  },
};

/**
 * The Log_Stream entry for the error that ended the retrieval of Stepstone.
 *
 * @param error The error carrying the Platform_Status, the stable code, the page number and the URL.
 * @returns The event. A Platform_Status without its own sentence — `FAILED` after the exhausted
 *   attempts of 13.8, and anything a later change adds — falls back to the German text of that table
 *   row, which names the page and states that the postings up to it were kept.
 */
export function endOfRetrievalEvent(error: AdapterError): AdapterLogEvent {
  const known = END_OF_RETRIEVAL[error.platformStatus];
  const page = error.pageNumber;
  const fallback = `${PLATFORM_LABEL} hat auf Seite ${String(page ?? 1)} nicht geantwortet. Treffer bis zu dieser Seite wurden gespeichert.`;

  return {
    level: known?.level ?? 'ERROR',
    code: error.code,
    messageDe: known?.messageDe ?? fallback,
    ...(page === undefined ? {} : { pageNumber: page }),
    ...(error.sourceUrl === undefined ? {} : { sourceUrl: error.sourceUrl }),
  };
}
