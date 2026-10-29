/**
 * The Search_Profile types and the Platform capability declaration.
 *
 * Requirement 4.5 demands that a Platform_Override which sets a Criterion_Field unsupported by its
 * Platform is reported as an error by the type check and keeps the build from succeeding. That is
 * achieved here by letting each Platform declare its supported fields as a `const` tuple and
 * deriving the override type from that tuple, rather than by a runtime check.
 */

import type { Platform } from '../enums.js';

/** The employment types a Search_Profile can ask a Platform for. */
export const EMPLOYMENT_TYPES = ['PERMANENT', 'TEMPORARY', 'CONTRACT', 'ANY'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/** The full set of search criteria. Every Criterion_Field is a key of this interface. */
export interface SearchProfile {
  readonly jobTitle: string;
  readonly titleSynonyms: readonly string[];
  readonly industry: string;
  readonly searchLocation: string;
  readonly searchRadiusKm: number;
  readonly employmentType: EmploymentType;
  readonly publicationPeriodDays: number;
}

/** A single field of a Search_Profile. */
export type CriterionField = keyof SearchProfile;

/**
 * What exactly one Platform can express in its result list query (4.2).
 *
 * The two type parameters stay open so that a concrete declaration keeps its literal tuples; the
 * defaults make the unparameterized `PlatformCapability` usable as a constraint and as the element
 * type of a capability map.
 */
export interface PlatformCapability<
  TSupported extends readonly CriterionField[] = readonly CriterionField[],
  TMandatory extends readonly TSupported[number][] = readonly TSupported[number][],
> {
  readonly platform: Platform;
  /** Criterion_Field this Platform can express in its result list query (4.2). */
  readonly supportedFields: TSupported;
  /** Subset of supportedFields the Platform requires to produce a result list (4.2). */
  readonly mandatoryFields: TMandatory;
}

/**
 * Identity helper that preserves the literal tuple types of supportedFields and mandatoryFields.
 * The `const` type parameters make `['jobTitle', 'searchLocation']` stay a tuple of literals instead
 * of widening to `CriterionField[]`, which is what makes the override type below precise.
 * `TMandatory extends readonly TSupported[number][]` already rejects a mandatory field that is not
 * supported.
 */
export function definePlatformCapability<
  const TSupported extends readonly CriterionField[],
  const TMandatory extends readonly TSupported[number][],
>(capability: {
  platform: Platform;
  supportedFields: TSupported;
  mandatoryFields: TMandatory;
}): PlatformCapability<TSupported, TMandatory> {
  return capability;
}

/** A Platform_Override may set only Criterion_Field that its Platform supports (4.1, 4.5). */
export type PlatformOverrideFor<TCapability extends PlatformCapability> = Partial<
  Pick<SearchProfile, TCapability['supportedFields'][number]>
>;
