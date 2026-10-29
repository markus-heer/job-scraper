import { de } from '../../i18n/de';

/**
 * The German label of one Criterion_Field, by its English identifier (4.11).
 *
 * The schema publishes `EffectiveCriterion.field` and `missingMandatoryFields` as `String` rather
 * than as an enum, because `CriterionField` is `keyof SearchProfile` in `@job-scraper/domain` and
 * has no value list a GraphQL enum could be registered from. So what arrives in the browser is a
 * plain string, and the lookup has to answer for a string that is not one of the seven.
 *
 * It answers with the identifier itself. The alternative — a dash, or leaving the row out — would
 * hide a criterion that the Scrape_Run really applies, which is the one thing this read-only view
 * must not do: an API_Service one version ahead of the Web_App would quietly show fewer criteria
 * than are in force. An untranslated `publicationPeriodDays` is worse German and better information.
 *
 * Requirements: 4.10, 4.11.
 */
export function criterionFieldLabelOf(field: string): string {
  const labels: Readonly<Record<string, string | undefined>> = de.vocabulary.criterionField;

  return labels[field] ?? field;
}
