/**
 * German-language output of the Default_Search_Profile check.
 *
 * Criterion 3.6 asks for a German error message that names every affected Criterion_Field together
 * with its permitted value range. The ranges themselves are owned by `validateDefaultSearchProfile`
 * in `@job-scraper/domain`, which already phrases them in German inside `ProfileValidationIssue`;
 * this file adds what a console reader needs around them — the field name, a German label for it,
 * and where the offending constant lives.
 *
 * Kept apart from the startup path for the same reason as `config.messages.ts`: the wording stays
 * reviewable in one place, and the lifecycle hook stays free of presentation concerns.
 *
 * Requirements: 3.5, 3.6, 16.8.
 */

import type { CriterionField, ProfileValidationIssue, SearchProfile } from '@job-scraper/domain';

/**
 * German labels for every Criterion_Field.
 *
 * Total over `CriterionField` on purpose: a new field in `SearchProfile` then fails the type check
 * here instead of reaching the console as a bare English identifier.
 */
export const CRITERION_FIELD_LABELS_DE: Readonly<Record<CriterionField, string>> = {
  jobTitle: 'Jobtitel',
  titleSynonyms: 'Titel-Synonyme',
  industry: 'Branche',
  searchLocation: 'Suchort',
  searchRadiusKm: 'Suchradius',
  employmentType: 'Beschäftigungsart',
  publicationPeriodDays: 'Veröffentlichungszeitraum',
};

/** Path of the file a developer has to edit to fix an invalid Default_Search_Profile (3.1). */
const PROFILE_SOURCE_PATH = 'packages/domain/src/search-profile/constants.ts';

/** Closing line of the fatal message, worded as in the configuration check. */
const NOT_STARTED_LINE_DE = 'Der API_Service wurde nicht gestartet.';

/**
 * Names every affected Criterion_Field with its permitted value range (3.6).
 *
 * Every issue gets its own line rather than a single summary, because
 * `validateDefaultSearchProfile` reports one issue per violation — a developer who broke three
 * synonyms sees all three and fixes them in one pass instead of one restart at a time.
 *
 * @param issues The issues reported for the Default_Search_Profile, at least one.
 * @returns The console lines, in issue order.
 */
export const invalidDefaultProfileMessageDe = (
  issues: readonly ProfileValidationIssue[],
): readonly string[] => [
  'Standard-Suchprofil ungültig: Die folgenden Suchkriterien liegen außerhalb des zulässigen Bereichs:',
  ...issues.map(
    (issue) => `  - ${CRITERION_FIELD_LABELS_DE[issue.field]} (${issue.field}): ${issue.messageDe}`,
  ),
  `Bitte das Standard-Suchprofil in ${PROFILE_SOURCE_PATH} korrigieren und den API_Service neu starten.`,
  NOT_STARTED_LINE_DE,
];

/**
 * The Default_Search_Profile with the value of every Criterion_Field, as one line (3.7).
 *
 * A Search_Profile holds search terms a developer wrote into a source file, so unlike the
 * configuration it carries nothing that needs masking (14.9) and can be printed in full.
 *
 * @param profile The validated Default_Search_Profile.
 * @returns One line naming every Criterion_Field and its value.
 */
export const defaultProfileSummaryDe = (profile: SearchProfile): string =>
  [
    `${CRITERION_FIELD_LABELS_DE.jobTitle}: ${profile.jobTitle}`,
    `${CRITERION_FIELD_LABELS_DE.titleSynonyms}: ${profile.titleSynonyms.join(', ')}`,
    `${CRITERION_FIELD_LABELS_DE.industry}: ${profile.industry}`,
    `${CRITERION_FIELD_LABELS_DE.searchLocation}: ${profile.searchLocation}`,
    `${CRITERION_FIELD_LABELS_DE.searchRadiusKm}: ${profile.searchRadiusKm} km`,
    `${CRITERION_FIELD_LABELS_DE.employmentType}: ${profile.employmentType}`,
    `${CRITERION_FIELD_LABELS_DE.publicationPeriodDays}: ${profile.publicationPeriodDays} Tage`,
  ].join('; ');
