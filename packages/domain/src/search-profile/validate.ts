/**
 * Validation of the Default_Search_Profile constant (3.5, 3.6).
 *
 * The API_Service calls `validateDefaultSearchProfile` in a lifecycle hook that runs before the HTTP
 * listener is bound; on any issue it prints every affected Criterion_Field with its permitted range
 * and exits with a non-zero code (3.6). This module therefore stays a pure function over the profile
 * value: no console access, no process exit, no clock, so every range violation is reachable from a
 * unit test.
 *
 * Per Requirement 16.8 the identifiers, the comments and the `code` of an issue are English, while
 * `messageDe` carries the German text that reaches the user through the console.
 */

import type { CriterionField, SearchProfile } from './types.js';

/** One violated range, one issue. */
export interface ProfileValidationIssue {
  readonly field: CriterionField;
  /** German text for the console, naming the permitted value range (3.6). */
  readonly messageDe: string;
  /** English, stable key for tests and the Log_Stream. */
  readonly code: string;
}

/**
 * The ranges criteria 3.1, 3.2 and 3.5 permit.
 *
 * Exported so that a caller which renders its own message — the startup hook, the read-only criteria
 * view — names the same bounds this validator enforces instead of repeating the literals.
 */
export const PROFILE_VALIDATION_LIMITS = {
  /** Maximum characters of job title, industry and search location (3.5). */
  textMaxLength: 100,
  /** Minimum title synonyms in the Default_Search_Profile (3.2). */
  synonymMinCount: 4,
  /** Maximum title synonyms in the Default_Search_Profile (3.2). */
  synonymMaxCount: 20,
  /** Minimum characters of a single title synonym (3.2). */
  synonymMinLength: 2,
  /** Maximum characters of a single title synonym (3.2). */
  synonymMaxLength: 100,
  /** Minimum search radius in kilometres (3.5). */
  searchRadiusKmMin: 1,
  /** Maximum search radius in kilometres (3.5). */
  searchRadiusKmMax: 200,
  /** Minimum publication period in days. */
  publicationPeriodDaysMin: 1,
  /** Maximum publication period in days. */
  publicationPeriodDaysMax: 365,
} as const;

/** German labels for the Criterion_Field this validator reports on (16.8). */
const FIELD_LABELS_DE: Readonly<Record<'jobTitle' | 'industry' | 'searchLocation', string>> = {
  jobTitle: 'Jobtitel',
  industry: 'Branche',
  searchLocation: 'Suchort',
};

/**
 * Checks one of the three free-text Criterion_Field: non-empty and at most 100 characters (3.5).
 *
 * "Non-empty" is measured on the trimmed value, so a value consisting of whitespace only is a
 * violation rather than a usable search term. The maximum is measured on the value as written,
 * because that is the string an adapter puts into its query.
 *
 * @param field The Criterion_Field being checked.
 * @param value The value of that Criterion_Field.
 * @returns The issue, or `null` when the value is in range.
 */
function validateText(
  field: 'jobTitle' | 'industry' | 'searchLocation',
  value: string,
): ProfileValidationIssue | null {
  const { textMaxLength } = PROFILE_VALIDATION_LIMITS;

  if (value.trim().length > 0 && value.length <= textMaxLength) {
    return null;
  }

  return {
    field,
    messageDe:
      `${FIELD_LABELS_DE[field]} muss angegeben sein und darf höchstens ` +
      `${textMaxLength} Zeichen lang sein.`,
    code: `profile.${field}Invalid`,
  };
}

/**
 * Checks one of the two whole-number Criterion_Field against its inclusive range.
 *
 * `Number.isInteger` also rejects `NaN` and `Infinity`, which a hand-edited constant can carry past
 * the type check as a `number`.
 *
 * @param field The Criterion_Field being checked.
 * @param value The value of that Criterion_Field.
 * @param range The inclusive bounds and the German message naming them.
 * @returns The issue, or `null` when the value is in range.
 */
function validateInteger(
  field: 'searchRadiusKm' | 'publicationPeriodDays',
  value: number,
  range: { readonly min: number; readonly max: number; readonly messageDe: string },
): ProfileValidationIssue | null {
  if (Number.isInteger(value) && value >= range.min && value <= range.max) {
    return null;
  }

  return { field, messageDe: range.messageDe, code: `profile.${field}Invalid` };
}

/**
 * Checks the title synonym list: 4 to 20 entries of 2 to 100 characters each (3.2).
 *
 * The count and the entries are independent violations, and every offending entry gets its own
 * issue naming its position, so a developer who broke three synonyms sees all three instead of
 * fixing them one restart at a time.
 *
 * @param synonyms The title synonyms of the profile.
 * @returns One issue per violation, the count issue first.
 */
function validateSynonyms(synonyms: readonly string[]): ProfileValidationIssue[] {
  const { synonymMinCount, synonymMaxCount, synonymMinLength, synonymMaxLength } =
    PROFILE_VALIDATION_LIMITS;
  const issues: ProfileValidationIssue[] = [];

  if (synonyms.length < synonymMinCount || synonyms.length > synonymMaxCount) {
    issues.push({
      field: 'titleSynonyms',
      messageDe:
        `Es müssen ${synonymMinCount} bis ${synonymMaxCount} Titel-Synonyme angegeben sein ` +
        `(aktuell: ${synonyms.length}).`,
      code: 'profile.titleSynonymsCountInvalid',
    });
  }

  synonyms.forEach((synonym, index) => {
    if (synonym.trim().length >= synonymMinLength && synonym.length <= synonymMaxLength) {
      return;
    }

    issues.push({
      field: 'titleSynonyms',
      messageDe:
        `Das Titel-Synonym an Position ${index + 1} muss ${synonymMinLength} bis ` +
        `${synonymMaxLength} Zeichen lang sein.`,
      code: 'profile.titleSynonymInvalid',
    });
  });

  return issues;
}

/**
 * Validates the Default_Search_Profile against the mandatory fields and value ranges of 3.1, 3.2 and
 * 3.5.
 *
 * Returns one issue per violation rather than stopping at the first one, so the startup message
 * names every affected Criterion_Field at once (3.6). The issues come in the declaration order of
 * `SearchProfile`, which makes the printed output stable across runs.
 *
 * The presence of every Criterion_Field is already guaranteed by the `SearchProfile` type, and
 * `employmentType` is a closed union the type check covers, so neither needs a runtime check here;
 * what remains are the value ranges a type cannot express.
 *
 * @param profile The Default_Search_Profile constant.
 * @returns Every violated range, empty when the profile is valid.
 */
export function validateDefaultSearchProfile(
  profile: SearchProfile,
): readonly ProfileValidationIssue[] {
  const {
    searchRadiusKmMin,
    searchRadiusKmMax,
    publicationPeriodDaysMin,
    publicationPeriodDaysMax,
  } = PROFILE_VALIDATION_LIMITS;

  const issues: (ProfileValidationIssue | null)[] = [
    validateText('jobTitle', profile.jobTitle),
    ...validateSynonyms(profile.titleSynonyms),
    validateText('industry', profile.industry),
    validateText('searchLocation', profile.searchLocation),
    validateInteger('searchRadiusKm', profile.searchRadiusKm, {
      min: searchRadiusKmMin,
      max: searchRadiusKmMax,
      messageDe:
        `Der Suchradius muss eine ganze Zahl zwischen ${searchRadiusKmMin} und ` +
        `${searchRadiusKmMax} Kilometern sein.`,
    }),
    validateInteger('publicationPeriodDays', profile.publicationPeriodDays, {
      min: publicationPeriodDaysMin,
      max: publicationPeriodDaysMax,
      messageDe:
        `Der Veröffentlichungszeitraum muss eine ganze Zahl zwischen ${publicationPeriodDaysMin} ` +
        `und ${publicationPeriodDaysMax} Tagen sein.`,
    }),
  ];

  return issues.filter((issue): issue is ProfileValidationIssue => issue !== null);
}
