/**
 * Reading one Criterion_Field out of an effective Search_Profile.
 *
 * {@link EffectiveSearchProfile} is a list rather than a record, because the Profile_Resolver has to
 * keep the resolution order of `capability.supportedFields` and a provenance per entry (5.4, 5.5). A
 * `resultListUrl` implementation, on the other hand, asks for one field at a time, so every adapter
 * would otherwise repeat the same `find` plus the same cast. It lives here once instead.
 *
 * A missing field is `undefined`, never an invented default: 5.7 lets the profile omit a Criterion_Field
 * the Platform does not support, and an optional supported field the Default_Search_Profile does not
 * carry is omitted too. The caller decides what that means — a mandatory field is a programming error
 * (the Profile_Resolver rejects such a profile, 5.8), an optional one simply drops out of the query.
 */

import type { CriterionField, EffectiveSearchProfile, SearchProfile } from '@job-scraper/domain';

/**
 * The resolved value of one Criterion_Field, or `undefined` where the profile carries none.
 *
 * The cast is the one place the list-shaped profile is narrowed back to the field type.
 * {@link EffectiveSearchProfile} types `criteria` as a union over every Criterion_Field, so TypeScript
 * cannot see that the entry whose `field` equals `field` holds that field's value — the Profile_Resolver
 * guarantees it by construction.
 */
export function criterionValue<K extends CriterionField>(
  profile: EffectiveSearchProfile,
  field: K,
): SearchProfile[K] | undefined {
  const criterion = profile.criteria.find((candidate) => candidate.field === field);

  return criterion === undefined ? undefined : (criterion.value as SearchProfile[K]);
}

/**
 * The resolved value of a Criterion_Field the Platform declares as mandatory.
 *
 * @param profile The effective Search_Profile of that Platform.
 * @param field The mandatory Criterion_Field.
 * @throws A `RangeError` where the value is absent, or blank for a string. Both are programming errors
 *   rather than runtime conditions: an activated Platform whose mandatory fields do not resolve carries
 *   Platform_Status `INCOMPLETE_CONFIGURATION` and is skipped before an adapter ever sees it (4.9, 4.10).
 */
export function requiredCriterionValue<K extends CriterionField>(
  profile: EffectiveSearchProfile,
  field: K,
): SearchProfile[K] {
  const value = criterionValue(profile, field);

  if (value === undefined || (typeof value === 'string' && value.trim().length === 0)) {
    throw new RangeError(
      `The effective Search_Profile of Platform ${profile.platform} carries no value for the mandatory Criterion_Field "${field}".`,
    );
  }

  return value;
}
