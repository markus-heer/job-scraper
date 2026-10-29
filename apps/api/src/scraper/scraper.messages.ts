/**
 * The German Log_Stream texts of the Scraper_Service that no other component owns.
 *
 * Everything the design's error table lists — a sign-in wall, a rate limit, an incomplete
 * per-Platform configuration, the retrieval deadline, a rejected write — has its German wording in
 * `src/common/error-mapping.ts`, and the service takes it from there through `failureLogEntry`, so
 * there is exactly one sentence per case. Everything a Platform_Adapter observes while it is
 * running — a page read, a result list exhausted, a page limit reached — has its wording in that
 * adapter's own `messages.ts`, because only the adapter knows the page number and the count.
 *
 * What is left are the lines that report the *progress of the orchestration itself*, and those are
 * this file: which criteria a Platform is being queried with (3.8), that its retrieval has started,
 * what it produced (12.3), how many stored Job_Posting the sweep closed, and the one Platform that
 * is configured but has no Platform_Adapter yet.
 *
 * German for the user, stable English codes next to them — the split
 * `src/scrape-run/scrape-run.messages.ts` and `src/platform-config/platform-config.messages.ts`
 * already use. No message here prints a secret: the only values any of them carry are the resolved
 * Criterion_Field of the Search_Profile, which are source-code constants, and counters.
 *
 * Requirements: 3.8, 4.7, 12.3, 16.8.
 */

import {
  type EffectiveSearchProfile,
  formatEffectiveProfile,
  type Platform,
} from '@job-scraper/domain';

import { PLATFORM_LABELS_DE } from '../platform-config/platform-config.messages';

/** The counters of one finished Platform, as the completion line reports them (12.3). */
export interface PlatformCounters {
  readonly pagesFetched: number;
  readonly newPostings: number;
  readonly updatedPostings: number;
  /** Job_Posting the normalization discarded because a mandatory field was missing (6.5). */
  readonly discardedPostings: number;
  /** Job_Posting whose single upsert the Posting_Store rejected (9.9). */
  readonly failedWrites: number;
}

/**
 * The effective Search_Profile of one Platform at the start of a Scrape_Run (3.8).
 *
 * 3.8 asks for the value of every Criterion_Field, not just for the fact that criteria were
 * resolved, so the German sentence carries the rendering of `formatEffectiveProfile` behind it —
 * the same shape the startup line of 3.7 uses. The rendering keeps the field names and the
 * provenance tokens in English identifiers on purpose: it is a traceable value list embedded in a
 * German message, not message text (16.8).
 */
export const effectiveProfileMessageDe = (profile: EffectiveSearchProfile): string =>
  `${PLATFORM_LABELS_DE[profile.platform]} wird mit diesen Suchkriterien abgefragt ` +
  `(${String(profile.criteria.length)} Kriterien): ${formatEffectiveProfile(profile)}`;

/** The start of one Platform's retrieval (12.3). */
export const retrievalStartedMessageDe = (platform: Platform): string =>
  `${PLATFORM_LABELS_DE[platform]}: Abruf gestartet.`;

/**
 * The completion of one Platform with its counters (12.3).
 *
 * The two optional clauses are omitted at zero rather than printed as "0 verworfen": a line that
 * names a problem which did not occur reads as if it had.
 */
export const platformCountersMessageDe = (
  platform: Platform,
  counters: PlatformCounters,
): string => {
  const discarded =
    counters.discardedPostings === 0
      ? ''
      : ` ${String(counters.discardedPostings)} Treffer waren unvollständig und wurden verworfen.`;
  const failed =
    counters.failedWrites === 0
      ? ''
      : ` ${String(counters.failedWrites)} Treffer konnten nicht gespeichert werden.`;

  return (
    `${PLATFORM_LABELS_DE[platform]}: Abruf beendet, ${String(counters.pagesFetched)} ` +
    `Ergebnisseiten gelesen, ${String(counters.newPostings)} neue und ` +
    `${String(counters.updatedPostings)} aktualisierte Treffer.${discarded}${failed}`
  );
};

/**
 * The result of the gated "no longer listed" sweep of one Platform (9.5).
 *
 * Only written when the sweep actually changed something. A refused sweep — the normal outcome for
 * a Platform that did not complete or for a Scrape_Run that was cancelled (9.7) — is not an event
 * the user needs a line for; the Platform_Status in the summary already says why.
 */
export const platformSweptMessageDe = (platform: Platform, sweptCount: number): string =>
  `${PLATFORM_LABELS_DE[platform]}: ${String(sweptCount)} zuvor gespeicherte Treffer stehen ` +
  'nicht mehr in der Ergebnisliste und wurden als "nicht mehr gelistet" markiert.';

/**
 * An activated and completely configured Platform for which no Platform_Adapter is registered yet.
 *
 * Reported rather than silently omitted, because the Platform is activated in the source code and
 * the user would otherwise be left to wonder why it produces nothing. Its Platform_Status stays
 * `NOT_YET_RUN`, which is the one permitted value for a Platform that was not queried.
 */
export const platformWithoutAdapterMessageDe = (platform: Platform): string =>
  `Für ${PLATFORM_LABELS_DE[platform]} ist noch kein Abruf verfügbar; diese Plattform wurde ` +
  'übersprungen. Bitte die Treffer der übrigen Plattformen verwenden.';
