/**
 * Guard test for Requirement 4.5: the declared types of a Platform_Override must make a
 * Criterion_Field unsupported by its Platform an error of the type check, so that `pnpm check-types`
 * and `pnpm build` fail instead of the Job_Tool silently sending a criterion a Platform cannot
 * express.
 *
 * The negative assertions below are `@ts-expect-error` comments. They are checked, not merely
 * documented: `packages/domain/tsconfig.json` includes `__tests__`, so `pnpm check-types` reads this
 * file. A refactor that widens `PlatformOverrideMap` or drops the `mandatoryFields` constraint makes
 * the expected errors disappear, and an unused `@ts-expect-error` is itself an error (TS2578). The
 * runtime tests at the end pin the same rules over the real constants.
 */

import { describe, expect, it } from 'vitest';

import { type Platform, PLATFORMS } from '../src/enums.js';
import {
  PLATFORM_CAPABILITIES,
  type PlatformCapabilityMap,
  type PlatformOverrideMap,
} from '../src/search-profile/capabilities.js';
import { PLATFORM_OVERRIDES } from '../src/search-profile/constants.js';
import {
  type CriterionField,
  definePlatformCapability,
  type PlatformOverrideFor,
} from '../src/search-profile/types.js';

/** Compiles only for `true`, which is what turns a type-level claim into a checked assertion. */
type Expect<T extends true> = T;

/** Invariant type equality, so `any` or a widened union cannot pass as the expected type. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// --- Negative: an override may not set a Criterion_Field its Platform does not support (4.5) ---

const overrideWithUnsupportedField = {
  GLASSDOOR: {
    // @ts-expect-error 4.5: GLASSDOOR does not declare `employmentType` in its supportedFields.
    employmentType: 'PERMANENT',
  },
  JOBVECTOR: {
    // @ts-expect-error 4.5: JOBVECTOR does not declare `publicationPeriodDays` in its supportedFields.
    publicationPeriodDays: 30,
  },
} satisfies PlatformOverrideMap;

// --- Negative: a mandatory field outside supportedFields is rejected (4.2) ---

const capabilityWithUnsupportedMandatoryField = definePlatformCapability({
  platform: 'GLASSDOOR',
  supportedFields: ['jobTitle', 'searchLocation'],
  // @ts-expect-error 4.2: `industry` is mandatory here but absent from supportedFields.
  mandatoryFields: ['jobTitle', 'industry'],
});

// --- Positive: a supported Criterion_Field stays assignable ---

const overrideWithSupportedField = {
  GLASSDOOR: { searchRadiusKm: 25, searchLocation: 'Augsburg' },
  STEPSTONE: { employmentType: 'ANY' },
} satisfies PlatformOverrideMap;

const capabilityWithSupportedMandatoryFields = definePlatformCapability({
  platform: 'GLASSDOOR',
  supportedFields: ['jobTitle', 'searchLocation'],
  mandatoryFields: ['jobTitle', 'searchLocation'],
});

// --- The override type is exactly the partial over the supported fields, nothing wider ---
// Exported so that `noUnusedLocals` keeps quiet about declarations that exist for their type effect.

export type GlassdoorOverrideKeysAreTheSupportedFields = Expect<
  Equals<
    keyof PlatformOverrideFor<PlatformCapabilityMap['GLASSDOOR']>,
    'jobTitle' | 'titleSynonyms' | 'searchLocation' | 'searchRadiusKm'
  >
>;

export type StepstoneOverrideKeysAreTheSupportedFields = Expect<
  Equals<
    keyof PlatformOverrideFor<PlatformCapabilityMap['STEPSTONE']>,
    | 'jobTitle'
    | 'titleSynonyms'
    | 'searchLocation'
    | 'searchRadiusKm'
    | 'employmentType'
    | 'publicationPeriodDays'
  >
>;

/** The capability declaration keeps its literal tuple; without it the override type widens. */
export type GlassdoorSupportedFieldsStayLiteral = Expect<
  Equals<
    PlatformCapabilityMap['GLASSDOOR']['supportedFields'],
    readonly ['jobTitle', 'titleSynonyms', 'searchLocation', 'searchRadiusKm']
  >
>;

/** Every override value is optional, so an override sets only the fields it replaces (4.1). */
export type OverrideFieldsAreOptional = Expect<
  Equals<
    PlatformOverrideFor<PlatformCapabilityMap['JOBVECTOR']>,
    {
      readonly jobTitle?: string;
      readonly titleSynonyms?: readonly string[];
      readonly industry?: string;
      readonly searchLocation?: string;
      readonly searchRadiusKm?: number;
    }
  >
>;

describe('Platform_Override typing', () => {
  it('sets in each override only Criterion_Field the Platform supports (4.1, 4.5)', () => {
    for (const platform of PLATFORMS) {
      const override: Readonly<Partial<Record<CriterionField, unknown>>> =
        PLATFORM_OVERRIDES[platform] ?? {};
      const supported: readonly CriterionField[] = PLATFORM_CAPABILITIES[platform].supportedFields;

      for (const field of Object.keys(override) as CriterionField[]) {
        expect(supported).toContain(field);
      }
    }
  });

  it('declares at most one override per Platform and at most four in total (4.1)', () => {
    const declaredPlatforms = Object.keys(PLATFORM_OVERRIDES) as Platform[];

    expect(new Set(declaredPlatforms).size).toBe(declaredPlatforms.length);
    expect(declaredPlatforms.length).toBeLessThanOrEqual(PLATFORMS.length);
    expect(declaredPlatforms.every((platform) => PLATFORMS.includes(platform))).toBe(true);
  });

  it('keeps every mandatory field inside the supported fields of its Platform (4.2)', () => {
    for (const platform of PLATFORMS) {
      const capability = PLATFORM_CAPABILITIES[platform];
      const supported: readonly CriterionField[] = capability.supportedFields;

      expect(capability.mandatoryFields.length).toBeGreaterThan(0);
      for (const field of capability.mandatoryFields as readonly CriterionField[]) {
        expect(supported).toContain(field);
      }
    }
  });

  it('keeps the type-check fixtures referenced, so the expected errors stay asserted', () => {
    // The fixtures above exist for their compile-time effect. Reading them here keeps
    // `noUnusedLocals` satisfied and records what each one claims.
    expect(Object.keys(overrideWithUnsupportedField)).toEqual(['GLASSDOOR', 'JOBVECTOR']);
    expect(capabilityWithUnsupportedMandatoryField.mandatoryFields).toEqual([
      'jobTitle',
      'industry',
    ]);
    expect(overrideWithSupportedField.GLASSDOOR.searchRadiusKm).toBe(25);
    expect(capabilityWithSupportedMandatoryFields.mandatoryFields).toEqual([
      'jobTitle',
      'searchLocation',
    ]);
  });
});
