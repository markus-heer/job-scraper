/**
 * German-language output of the per-Platform configuration check at startup.
 *
 * Requirement 4.9 asks for a German message naming the platform name and the missing field names,
 * and Requirement 4.10 repeats that the missing mandatory Criterion_Field have to be reported. The
 * user is the one who reads those lines in the Log_View, so the texts are German while the message
 * codes next to them stay stable English keys — the same split `src/config/config.messages.ts`
 * already uses for the configuration check.
 *
 * No builder in this file prints a Criterion_Field *value*. The configuration state is about which
 * fields resolved, not what they resolved to, so a value cannot leak into the Log_Stream through
 * one of these messages (14.9). The resolved values reach the log through
 * `formatEffectiveProfile`, which the Default_Search_Profile log line of 3.7 is responsible for.
 *
 * Requirements: 4.7, 4.9, 4.10, 14.9, 16.8.
 */

import type { CriterionField, Platform } from '@job-scraper/domain';

/**
 * How each Platform is spelled where the user sees it.
 *
 * The enum value is a screaming-snake identifier; "STEPSTONE" is not the platform name, it is the
 * key the Job_Tool files that platform under. The brand spelling belongs in exactly one place so
 * the Log_View and the read-only criteria view cannot disagree about it.
 */
export const PLATFORM_LABELS_DE: Readonly<Record<Platform, string>> = {
  GLASSDOOR: 'Glassdoor',
  JOBVECTOR: 'Jobvector',
  INDEED: 'Indeed',
  STEPSTONE: 'Stepstone',
};

/**
 * German labels of every Criterion_Field.
 *
 * `validateDefaultSearchProfile` carries its own labels for the three free-text fields it reports
 * on; this map covers all seven, because any mandatory field of any Platform can turn up in a
 * missing-fields list.
 */
export const CRITERION_FIELD_LABELS_DE: Readonly<Record<CriterionField, string>> = {
  jobTitle: 'Jobtitel',
  titleSynonyms: 'Titel-Synonyme',
  industry: 'Branche',
  searchLocation: 'Suchort',
  searchRadiusKm: 'Suchradius',
  employmentType: 'Anstellungsart',
  publicationPeriodDays: 'Veröffentlichungszeitraum',
};

/**
 * Renders a missing-fields list for the user (4.10).
 *
 * Each entry carries the German label and the identifier of the constant behind it, because the
 * two readers of the line need different halves: the user recognizes "Suchort", and the developer
 * who edits `DEFAULT_SEARCH_PROFILE` or a Platform_Override searches for `searchLocation`.
 */
export const criterionFieldListDe = (fields: readonly CriterionField[]): string =>
  fields.map((field) => `${CRITERION_FIELD_LABELS_DE[field]} (${field})`).join(', ');

/** A Platform marked as deactivated in the source code is not queried at all (4.6, 4.7). */
export const platformDisabledMessageDe = (platform: Platform): string =>
  `Plattform ${PLATFORM_LABELS_DE[platform]} ist im Quellcode deaktiviert und wird in einem Suchlauf nicht abgefragt.`;

/**
 * An activated Platform whose mandatory Criterion_Field do not resolve (4.9, 4.10).
 *
 * The first sentence is the wording pinned in the design's error table. The second one states the
 * consequence, so the user can tell this apart from a Platform that simply found nothing: the
 * remaining Platform keep being served (4.9) and this one is skipped in a Scrape_Run (4.10).
 */
export const platformIncompleteConfigurationMessageDe = (
  platform: Platform,
  missingMandatoryFields: readonly CriterionField[],
): string =>
  `${PLATFORM_LABELS_DE[platform]}: Konfiguration unvollständig, fehlende Felder: ` +
  `${criterionFieldListDe(missingMandatoryFields)}. Diese Plattform wird in einem Suchlauf übersprungen, ` +
  'die übrigen Plattformen werden weiterhin abgefragt.';

/** An activated Platform whose criteria resolved completely, ready for the next Scrape_Run. */
export const platformConfiguredMessageDe = (platform: Platform, criteriaCount: number): string =>
  `Plattform ${PLATFORM_LABELS_DE[platform]} ist vollständig konfiguriert (${criteriaCount} Suchkriterien) ` +
  'und wird in einem Suchlauf abgefragt.';
