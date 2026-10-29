/**
 * Property 4 of the job-search-tool design: unresolvable mandatory fields produce a naming error
 * and no profile.
 *
 * The input shape is the one criterion 5.8 describes: a Default_Search_Profile with an arbitrary
 * subset of its keys removed, paired with a Platform_Override over an arbitrary subset of the drawn
 * Platform's supported fields. Together they range over every combination of "set by the override",
 * "set by the defaults only" and "set by neither", which is exactly the space in which the error
 * path lives.
 *
 * The oracle is the independent recomputation the design prescribes: a mandatory Criterion_Field is
 * unresolved iff neither source carries it, and the resolution is `ok: false` with exactly that set
 * iff the set is non-empty. The expectation is stated as an equivalence rather than as a one-way
 * implication, so a resolver that failed too eagerly — erroring on an unset *optional* field, say —
 * would be caught by the same property.
 *
 * `overriddenFields` is read instead of the override object itself, because a generated override
 * value can coincide with the default value; attributing by key keeps the oracle independent of the
 * values that happen to be drawn.
 *
 * **Validates: Requirements 4.8, 5.8**
 */

// Feature: job-search-tool, Property 4 - Unresolvable mandatory fields produce a naming error and no profile

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PLATFORM_CAPABILITIES } from '../src/search-profile/capabilities.js';
import { resolveSearchProfile } from '../src/search-profile/profile-resolver.js';
import type { CriterionField, SearchProfile } from '../src/search-profile/types.js';
import {
  partialSearchProfileArbitrary,
  platformWithOverrideArbitrary,
} from '../src/testing/arbitraries.js';

const PROPERTY_RUNS = { numRuns: 100 } as const;

/** The mandatory fields of a Platform that neither source supplies, in `mandatoryFields` order. */
function expectedMissingFields(
  mandatoryFields: readonly CriterionField[],
  overriddenFields: readonly CriterionField[],
  defaults: Partial<SearchProfile>,
): readonly CriterionField[] {
  const overridden = new Set(overriddenFields);

  return mandatoryFields.filter((field) => !overridden.has(field) && defaults[field] === undefined);
}

describe('Property 4: unresolvable mandatory fields produce a naming error and no profile', () => {
  it('returns no profile and exactly the unresolved mandatory fields, naming the Platform', () => {
    // Both branches of the equivalence have to actually occur, otherwise the property would pass
    // on a generator that never reaches the error path at all.
    let failedResolutions = 0;
    let successfulResolutions = 0;

    fc.assert(
      fc.property(
        platformWithOverrideArbitrary(),
        partialSearchProfileArbitrary(),
        (generated, defaults) => {
          const capability = PLATFORM_CAPABILITIES[generated.platform];
          const expectedMissing = expectedMissingFields(
            capability.mandatoryFields,
            generated.overriddenFields,
            defaults,
          );

          const resolution = resolveSearchProfile(
            generated.platform,
            defaults,
            generated.overrides,
          );

          if (expectedMissing.length > 0) {
            failedResolutions += 1;

            expect(resolution.ok).toBe(false);

            if (resolution.ok) {
              return;
            }

            // No Search_Profile is returned at all, not an empty or partial one (5.8).
            expect(resolution).not.toHaveProperty('profile');
            expect(resolution.error.platform).toBe(generated.platform);
            // The missing-field set equals the expected one exactly: same members, no duplicate,
            // nothing resolvable reported as missing.
            expect([...resolution.error.missingMandatoryFields].sort()).toEqual(
              [...expectedMissing].sort(),
            );
            expect(new Set(resolution.error.missingMandatoryFields).size).toBe(
              resolution.error.missingMandatoryFields.length,
            );

            return;
          }

          successfulResolutions += 1;

          expect(resolution.ok).toBe(true);

          if (!resolution.ok) {
            return;
          }

          // The converse direction: with every mandatory field resolvable there is a profile, and
          // it carries each of those fields.
          expect(resolution.profile.platform).toBe(generated.platform);

          const resolvedFields = resolution.profile.criteria.map((criterion) => criterion.field);

          for (const field of capability.mandatoryFields) {
            expect(resolvedFields).toContain(field);
          }
        },
      ),
      PROPERTY_RUNS,
    );

    expect(failedResolutions).toBeGreaterThan(0);
    expect(successfulResolutions).toBeGreaterThan(0);
  });
});
