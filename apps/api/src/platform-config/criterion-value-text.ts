/**
 * The German rendering of a resolved Criterion_Field *value* (4.11).
 *
 * The read-only criteria view publishes each resolved value as one text, and this module is that
 * text. It exists as a file of its own for two reasons:
 *
 * - **The value is German, so the API_Service owns it.** The ownership table in
 *   `apps/web/src/i18n/de.ts` records `EffectiveCriterion.valueText` as the API_Service's, next to
 *   the Platform_Status labels and the commute line: a `SearchProfile` value is either a stored
 *   string the user wrote, a number that needs a unit, or a member of a closed vocabulary that needs
 *   a label — and the Web_App must not hold a second wording of the last of those.
 * - **`platform-config.messages.ts` must not print a value.** That module states which fields
 *   resolved and writes those sentences into the Log_Stream, and its own documentation pins that it
 *   prints no Criterion_Field value, so that a value cannot leak into the Log_Stream through one of
 *   its builders (14.9). The texts here are published by the `searchCriteria` query only and reach
 *   no log line, which is why they are not that module's and are kept apart from it.
 *
 * Two values would otherwise reach the user as something they cannot read: `employmentType` is a
 * screaming-snake enum literal — `PERMANENT` is English and not a word in a German interface — and
 * `searchRadiusKm` is a bare number whose unit lives in the field *name*, which is the one place the
 * user never sees. Both are answered here; the free-text fields are passed through unchanged,
 * because what the user reads for them is what a developer wrote into the constant.
 *
 * Requirements: 2.1, 4.11, 16.8.
 */

import type {
  CriterionField,
  EffectiveCriterion,
  EmploymentType,
  SearchProfile,
} from '@job-scraper/domain';

/**
 * German labels of the four employment types of a Search_Profile.
 *
 * The first German wording of that vocabulary in the Job_Tool: `EMPLOYMENT_TYPES` in
 * `@job-scraper/domain` is the value list, `STEPSTONE_CONTRACT_TYPES` in `@job-scraper/scrapers`
 * maps it onto one Platform's query parameter, and neither carries a label. Total over
 * `EmploymentType`, so a fifth employment type is a build error here until it has one.
 *
 * `ANY` is "beliebig" rather than "alle": the value does not ask a Platform for every contract type
 * one after another, it drops the filter, and "beliebig" is what an unfiltered criterion reads as.
 */
export const EMPLOYMENT_TYPE_LABELS_DE: Readonly<Record<EmploymentType, string>> = {
  PERMANENT: 'Festanstellung',
  TEMPORARY: 'befristete Anstellung',
  CONTRACT: 'freie Mitarbeit',
  ANY: 'beliebig',
};

/**
 * What stands in place of a list value that resolved to no entry at all.
 *
 * An empty text would reach the criteria view as a blank cell next to its label, which reads as a
 * view that failed to load rather than as a criterion nobody filled in.
 */
export const CRITERION_VALUE_EMPTY_DE = 'keine Angabe';

/**
 * A resolved criterion with its field and its value *paired*.
 *
 * `EffectiveCriterion` is declared with one type parameter that defaults to the whole
 * `CriterionField` union, so its `value` widens to `SearchProfile[CriterionField]` — a value type
 * that a check against `field` cannot narrow, because the two are independent in that declaration.
 * Distributing the union over the keys restores the pairing, and with it a `switch` that narrows the
 * value and a compiler error for a Criterion_Field nobody rendered.
 */
type PairedCriterion = {
  [K in CriterionField]: { readonly field: K; readonly value: SearchProfile[K] };
}[CriterionField];

/** `n` days as German text, singular where it is one. */
const dayCountDe = (days: number): string => (days === 1 ? '1 Tag' : `${String(days)} Tage`);

/**
 * One resolved Criterion_Field value as the one text the criteria view displays (4.11).
 *
 * Per field rather than per value shape, because the shape does not say what the value *means*: a
 * search radius and a publication period are both numbers and read as "50 km" and "30 Tage", and an
 * employment type and a job title are both strings while only one of them is a closed vocabulary.
 * The `switch` is exhaustive over `CriterionField` and has no `default`, so an eighth Criterion_Field
 * fails `pnpm check-types` here instead of reaching the user as a raw value.
 *
 * A list is joined with ", " rather than rendered as a JSON array, because the user reads it: the
 * title synonyms are a handful of job titles, and `["Projektmanagerin","Projektleiterin"]` states
 * the same thing less legibly. The separator is the one `formatEffectiveProfile` uses for the
 * traceable rendering in the log, so the two cannot disagree.
 *
 * @param criterion One resolved criterion as the Profile_Resolver returned it.
 */
export const criterionValueTextDe = (criterion: EffectiveCriterion): string => {
  // The one assertion in this module, and what makes it sound: the Profile_Resolver builds every
  // criterion by reading `profile[field]`, so the field and the value of a resolved criterion always
  // belong together. Only the *declaration* of `EffectiveCriterion` loses that, and the cast states
  // it again rather than re-deriving it with runtime type checks the resolver already ruled out.
  const paired = criterion as PairedCriterion;

  switch (paired.field) {
    case 'jobTitle':
    case 'industry':
    case 'searchLocation':
      return paired.value;

    case 'titleSynonyms':
      return paired.value.length === 0 ? CRITERION_VALUE_EMPTY_DE : paired.value.join(', ');

    case 'searchRadiusKm':
      return `${String(paired.value)} km`;

    case 'employmentType':
      return EMPLOYMENT_TYPE_LABELS_DE[paired.value];

    case 'publicationPeriodDays':
      return dayCountDe(paired.value);
  }
};
