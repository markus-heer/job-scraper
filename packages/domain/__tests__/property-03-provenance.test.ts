/**
 * Property 3 of the Profile_Resolver: every resolved value carries a correct provenance.
 *
 * FOR ALL Platform and FOR ALL valid combinations of Default_Search_Profile and Platform_Override,
 * each Criterion_Field of the result is value-equal to the Platform_Override value where the
 * override sets that field and carries provenance `OVERRIDE` (4.3, 5.2), and is value-equal to the
 * Default_Search_Profile value where the override leaves it unset and carries provenance `DEFAULT`
 * (3.4, 4.4, 5.3). Taken together over all generated inputs this is the provenance property 5.6.
 *
 * Two points about the oracle:
 *
 * - The expected source is read from `overriddenFields`, not by inspecting the override object and
 *   not by comparing values. A generated override value may coincide with the generated default
 *   value, in which case value equality alone cannot tell the two sources apart; the generator's
 *   report can. This is also why 5.6 is only ever testable as an attribution statement: where both
 *   sources carry the same value, the resolved value is value-equal to both by arithmetic, and the
 *   provenance is the only thing left that can be wrong.
 * - The case "no Platform_Override is defined for this Platform" (3.4, 4.4) is drawn inside the
 *   same property rather than split into a second one: a drawn boolean decides whether the
 *   generated override is registered in the override map at all, and when it is not, the expected
 *   overridden set is empty, so every criterion must come from the Default_Search_Profile.
 *
 * The Default_Search_Profile is generated complete, so the resolution always succeeds; the error
 * path of 5.8 belongs to Property 4.
 */

// Feature: job-search-tool, Property 3 - Every resolved value carries a correct provenance

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { PlatformOverrideMap } from '../src/search-profile/capabilities.js';
import { resolveSearchProfile } from '../src/search-profile/profile-resolver.js';
import type { CriterionField, SearchProfile } from '../src/search-profile/types.js';
import {
  platformWithOverrideArbitrary,
  searchProfileArbitrary,
} from '../src/testing/arbitraries.js';

/** At least 100 iterations per property, as the design prescribes. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

type CriterionValue = SearchProfile[CriterionField];

/** Narrowing helper for the only list-valued Criterion_Field, `titleSynonyms`. */
function isStringList(value: CriterionValue): value is readonly string[] {
  return Array.isArray(value);
}

/**
 * Value-equality of a resolved value against the value its expected source carries.
 *
 * Lists compare element by element and in order, because 5.6 defines value-equality to include the
 * order of list elements. An absent expected value is never equal: it means the oracle expected a
 * source that carries nothing for that Criterion_Field, which the resolver must not have emitted.
 */
function criterionValuesEqual(
  resolved: CriterionValue,
  expected: CriterionValue | undefined,
): boolean {
  if (expected === undefined) {
    return false;
  }

  if (isStringList(resolved) || isStringList(expected)) {
    if (!isStringList(resolved) || !isStringList(expected)) {
      return false;
    }

    return (
      resolved.length === expected.length &&
      resolved.every((element, index) => element === expected[index])
    );
  }

  return resolved === expected;
}

describe('Property 3: every resolved value carries a correct provenance', () => {
  it('attributes each criterion to the Platform_Override where it sets the field and to the Default_Search_Profile otherwise (3.4, 4.3, 4.4, 5.2, 5.3, 5.6)', () => {
    fc.assert(
      fc.property(
        platformWithOverrideArbitrary(),
        searchProfileArbitrary(),
        fc.boolean(),
        (generated, defaults, overrideIsDefined) => {
          const overrides: PlatformOverrideMap = overrideIsDefined ? generated.overrides : {};
          // In `supportedFields` order, so it is directly comparable with the criteria order.
          const overriddenFields: readonly CriterionField[] = overrideIsDefined
            ? generated.overriddenFields
            : [];
          const overriddenFieldSet = new Set<CriterionField>(overriddenFields);

          const resolution = resolveSearchProfile(generated.platform, defaults, overrides);

          expect(resolution.ok).toBe(true);

          if (!resolution.ok) {
            return;
          }

          for (const criterion of resolution.profile.criteria) {
            const fromOverride = overriddenFieldSet.has(criterion.field);
            const expectedValue = fromOverride
              ? generated.override[criterion.field]
              : defaults[criterion.field];

            expect({
              field: criterion.field,
              provenance: criterion.provenance,
              valueMatchesExpectedSource: criterionValuesEqual(criterion.value, expectedValue),
            }).toEqual({
              field: criterion.field,
              provenance: fromOverride ? 'OVERRIDE' : 'DEFAULT',
              valueMatchesExpectedSource: true,
            });
          }

          // No override the Platform_Override set is silently dropped, and no criterion claims an
          // override that was never defined: where no override is registered this set is empty, so
          // every criterion is attributed to the Default_Search_Profile (3.4, 4.4).
          expect(
            resolution.profile.criteria
              .filter((criterion) => criterion.provenance === 'OVERRIDE')
              .map((criterion) => criterion.field),
          ).toEqual([...overriddenFields]);
        },
      ),
      PROPERTY_RUNS,
    );
  });
});
