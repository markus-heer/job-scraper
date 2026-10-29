/**
 * Property 2 of the job-search-tool design: Profile_Resolver determinism and idempotence (5.5).
 *
 * Criterion 5.5 is a FOR ALL statement over every Platform and every valid combination of
 * Default_Search_Profile and Platform_Override, so it is checked by generation rather than by
 * example: for each drawn input the resolver is called 2 to 5 times and every result has to be
 * value-equal to the result of the first call, where value-equality means the same Criterion_Field
 * names in the same order, the same value per Criterion_Field and the same order of list elements.
 *
 * The oracle is `effectiveProfilesEqual`, which is exactly that comparison including the element
 * order of `titleSynonyms`. That the oracle is not trivially true is covered by the example test in
 * `profile-resolver.test.ts`, which asserts it rejects a profile whose synonym list is reordered.
 *
 * **Validates: Requirements 5.5**
 */

// Feature: job-search-tool, Property 2 - Profile resolution is deterministic and idempotent

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  effectiveProfilesEqual,
  resolveSearchProfile,
} from '../src/search-profile/profile-resolver.js';
import {
  platformWithOverrideArbitrary,
  searchProfileArbitrary,
} from '../src/testing/arbitraries.js';

describe('Property 2: Profile resolution is deterministic and idempotent', () => {
  it('returns value-equal results for repeated resolutions of the same inputs (5.5)', () => {
    fc.assert(
      fc.property(
        platformWithOverrideArbitrary(),
        searchProfileArbitrary(),
        fc.integer({ min: 2, max: 5 }),
        ({ platform, overrides }, defaults, repetitions) => {
          const first = resolveSearchProfile(platform, defaults, overrides);

          // The generated Default_Search_Profile is complete, so no mandatory Criterion_Field can
          // be unresolved and the 5.8 error path is out of scope for this property.
          expect(first.ok).toBe(true);

          if (!first.ok) {
            return;
          }

          for (let repetition = 2; repetition <= repetitions; repetition += 1) {
            const nth = resolveSearchProfile(platform, defaults, overrides);

            expect(nth.ok).toBe(true);

            if (!nth.ok) {
              return;
            }

            expect(effectiveProfilesEqual(first.profile, nth.profile)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
