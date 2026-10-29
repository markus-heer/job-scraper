/**
 * Property 1 of the job-search-tool design: the Profile_Resolver is total over the Criterion_Field
 * a Platform declares as supported, and it never emits a Criterion_Field outside that declaration.
 *
 * The Default_Search_Profile generated here is always complete, which is what separates this
 * property from Property 4: with a value available for every Criterion_Field no mandatory field can
 * stay unresolved, so every resolution has to succeed and has to carry exactly one entry per
 * supported field. The incomplete-profile case and its error path belong to Property 4.
 *
 * The defaults are generated independently of the override values, so each run exercises a Platform
 * whose supported fields are a strict subset of the seven Criterion_Field (GLASSDOOR supports four
 * of them, JOBVECTOR five). That makes the support half of the oracle load-bearing: the three
 * values the Default_Search_Profile carries for unsupported fields must not leak into the result.
 */

// Feature: job-search-tool, Property 1 - Profile resolution is total over the supported fields

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PLATFORM_CAPABILITIES } from '../src/search-profile/capabilities.js';
import { resolveSearchProfile } from '../src/search-profile/profile-resolver.js';
import type { CriterionField } from '../src/search-profile/types.js';
import {
  platformWithOverrideArbitrary,
  searchProfileArbitrary,
} from '../src/testing/arbitraries.js';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

describe('Property 1: Profile resolution is total over the supported fields', () => {
  /**
   * **Validates: Requirements 5.1, 5.4, 5.7**
   *
   * For all Platform, for all valid Default_Search_Profile and for all valid Platform_Override, a
   * successful resolution returns an effective Search_Profile whose field set equals that Platform's
   * `supportedFields` exactly, with exactly one value per field and no field the Platform does not
   * support.
   */
  it('returns exactly one value per supported Criterion_Field and no unsupported field', () => {
    fc.assert(
      fc.property(
        platformWithOverrideArbitrary(),
        searchProfileArbitrary(),
        (generated, defaults) => {
          const resolution = resolveSearchProfile(
            generated.platform,
            defaults,
            generated.overrides,
          );

          // 5.1: a complete Default_Search_Profile leaves no mandatory Criterion_Field unresolved,
          // so the resolution returns exactly one effective Search_Profile and never the error.
          if (!resolution.ok) {
            throw new Error(
              `expected a resolved profile for ${generated.platform}, missing: ` +
                resolution.error.missingMandatoryFields.join(', '),
            );
          }

          const supportedFields: readonly CriterionField[] =
            PLATFORM_CAPABILITIES[generated.platform].supportedFields;
          const resolvedFields = resolution.profile.criteria.map((criterion) => criterion.field);

          expect(resolution.profile.platform).toBe(generated.platform);

          // 5.4 and 5.7 together: the field set is the supported set, neither short of it nor
          // beyond it.
          expect(new Set(resolvedFields)).toEqual(new Set(supportedFields));

          // Exactly one value per field: the entry count equals the size of the supported set, so
          // no Criterion_Field is emitted twice.
          expect(resolvedFields.length).toBe(new Set(supportedFields).size);

          // A field present with no value would satisfy the set comparison while carrying nothing,
          // so totality is only established once every entry is known to hold a value.
          for (const criterion of resolution.profile.criteria) {
            expect(criterion.value).toBeDefined();
          }
        },
      ),
      PROPERTY_RUNS,
    );
  });
});
