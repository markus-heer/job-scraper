/**
 * The Profile_Resolver (5.1 - 5.8).
 *
 * A pure function with no Nest dependency, no I/O and no clock access. Every input the resolution
 * depends on is a parameter, which is what makes the FOR ALL criteria 5.4 - 5.7 drivable by
 * fast-check directly and keeps a past Scrape_Run reproducible from its stored snapshot.
 */

import type { Platform } from '../enums.js';
import {
  PLATFORM_CAPABILITIES,
  type PlatformCapabilityMap,
  type PlatformOverrideMap,
} from './capabilities.js';
import type { CriterionField, SearchProfile } from './types.js';

/** Where a resolved criterion value came from (5.2, 5.3, 5.6). */
export type FieldProvenance = 'DEFAULT' | 'OVERRIDE';

/** One resolved Criterion_Field with its value and the source that supplied it. */
export interface EffectiveCriterion<K extends CriterionField = CriterionField> {
  readonly field: K;
  readonly value: SearchProfile[K];
  readonly provenance: FieldProvenance;
}

export interface EffectiveSearchProfile {
  readonly platform: Platform;
  /** Exactly one entry per Criterion_Field supported by this Platform (5.4, 5.7). */
  readonly criteria: readonly EffectiveCriterion[];
}

export interface ProfileResolutionError {
  readonly platform: Platform;
  readonly missingMandatoryFields: readonly CriterionField[];
}

export type ProfileResolution =
  | { readonly ok: true; readonly profile: EffectiveSearchProfile }
  | { readonly ok: false; readonly error: ProfileResolutionError };

/**
 * Resolves the Default_Search_Profile and the optional Platform_Override of one Platform into
 * exactly one effective Search_Profile (5.1).
 *
 * Per Criterion_Field supported by the Platform: the Platform_Override value wins where the override
 * sets that field (5.2, provenance `OVERRIDE`), otherwise the Default_Search_Profile value is taken
 * (5.3, provenance `DEFAULT`). A Criterion_Field the Platform does not support never appears in the
 * result (5.7), and the criteria are emitted in `capability.supportedFields` order, which makes the
 * returned value deterministic down to list order and therefore comparable by value (5.5).
 *
 * A supported but optional Criterion_Field that neither source carries is omitted rather than
 * invented: there is no value to emit. A supported *mandatory* Criterion_Field in that situation is
 * fatal for the Platform, so the resolution returns no Search_Profile and an error naming the
 * Platform and every missing Criterion_Field instead (5.8). Resolving with a complete
 * Default_Search_Profile therefore yields one entry per supported field (5.4).
 *
 * `defaults` is `Partial<SearchProfile>` rather than `SearchProfile` on purpose: criterion 5.8
 * describes the case in which the Default_Search_Profile itself carries no value for a mandatory
 * Criterion_Field, and a total type would make that case unreachable and the error path untestable.
 *
 * @param platform The Platform whose criteria are resolved.
 * @param defaults The Default_Search_Profile, possibly incomplete.
 * @param overrides Every Platform_Override; the one of `platform` is used, if any (4.3, 4.4).
 * @param capabilities The per-Platform capability declaration; injectable for tests.
 * @returns The effective Search_Profile, or the error naming the unresolved mandatory fields.
 */
export function resolveSearchProfile(
  platform: Platform,
  defaults: Partial<SearchProfile>,
  overrides: PlatformOverrideMap,
  capabilities: PlatformCapabilityMap = PLATFORM_CAPABILITIES,
): ProfileResolution {
  const capability = capabilities[platform];
  // Widening the per-Platform override to the partial profile keeps the loop below readable: the
  // capability declaration already guaranteed at compile time that the override sets supported
  // fields only (4.5), so nothing is lost by reading it through the wider type here.
  const override: Partial<SearchProfile> = overrides[platform] ?? {};
  const mandatoryFields = new Set<CriterionField>(capability.mandatoryFields);

  const criteria: EffectiveCriterion[] = [];
  const missingMandatoryFields: CriterionField[] = [];

  for (const field of capability.supportedFields) {
    const overrideValue = override[field];

    if (overrideValue !== undefined) {
      criteria.push({ field, value: overrideValue, provenance: 'OVERRIDE' });
      continue;
    }

    const defaultValue = defaults[field];

    if (defaultValue !== undefined) {
      criteria.push({ field, value: defaultValue, provenance: 'DEFAULT' });
      continue;
    }

    if (mandatoryFields.has(field)) {
      missingMandatoryFields.push(field);
    }
  }

  if (missingMandatoryFields.length > 0) {
    return { ok: false, error: { platform, missingMandatoryFields } };
  }

  return { ok: true, profile: { platform, criteria } };
}

/** Narrowing helper for the only list-valued Criterion_Field, `titleSynonyms`. */
function isStringList(value: SearchProfile[CriterionField]): value is readonly string[] {
  return Array.isArray(value);
}

/** Value-equality of two criterion values; lists compare element by element, in order (5.5). */
function criterionValuesEqual(
  a: SearchProfile[CriterionField],
  b: SearchProfile[CriterionField],
): boolean {
  if (isStringList(a) || isStringList(b)) {
    if (!isStringList(a) || !isStringList(b)) {
      return false;
    }

    return a.length === b.length && a.every((element, index) => element === b[index]);
  }

  return a === b;
}

/**
 * Value-equality used by 5.5: the same Platform, the same Criterion_Field names in the same order,
 * the same value per Criterion_Field and the same provenance per Criterion_Field.
 *
 * Order is part of the comparison because the resolver emits criteria in `supportedFields` order, so
 * two results that differ in order are a determinism defect rather than an accepted variation.
 */
export function effectiveProfilesEqual(
  a: EffectiveSearchProfile,
  b: EffectiveSearchProfile,
): boolean {
  if (a.platform !== b.platform || a.criteria.length !== b.criteria.length) {
    return false;
  }

  return a.criteria.every((criterion, index) => {
    const other = b.criteria[index];

    return (
      other !== undefined &&
      criterion.field === other.field &&
      criterion.provenance === other.provenance &&
      criterionValuesEqual(criterion.value, other.value)
    );
  });
}

/**
 * Stable, human-readable rendering of an effective Search_Profile for the Log_Stream (3.7, 3.8).
 *
 * Produces one line that names the Platform and then every Criterion_Field with its value and its
 * provenance, in resolution order, for example:
 *
 * `STEPSTONE: jobTitle="Projektmanagerin" (DEFAULT), searchRadiusKm=30 (OVERRIDE)`
 *
 * Criterion_Field names and the provenance tokens stay English identifiers: this is the traceable
 * value rendering that a German Log_Stream message embeds, not the message text itself (16.8). The
 * values are JSON-encoded so that a string with a comma, a quote or a trailing space, and a synonym
 * list of any length, stay unambiguous.
 */
export function formatEffectiveProfile(profile: EffectiveSearchProfile): string {
  const criteria = profile.criteria
    .map(
      (criterion) =>
        `${criterion.field}=${JSON.stringify(criterion.value)} (${criterion.provenance})`,
    )
    .join(', ');

  return `${profile.platform}: ${criteria}`;
}
