import { describe, expect, it } from 'vitest';

import { PLATFORM_CAPABILITIES } from '../src/search-profile/capabilities.js';
import { DEFAULT_SEARCH_PROFILE } from '../src/search-profile/constants.js';
import {
  effectiveProfilesEqual,
  type EffectiveSearchProfile,
  formatEffectiveProfile,
  resolveSearchProfile,
} from '../src/search-profile/profile-resolver.js';
import type { SearchProfile } from '../src/search-profile/types.js';

/** The resolution of a Platform, or a failure of the assertion that it succeeded. */
function resolveOrThrow(...args: Parameters<typeof resolveSearchProfile>): EffectiveSearchProfile {
  const resolution = resolveSearchProfile(...args);

  if (!resolution.ok) {
    throw new Error(
      `expected a resolved profile, missing: ${resolution.error.missingMandatoryFields.join(', ')}`,
    );
  }

  return resolution.profile;
}

describe('resolveSearchProfile', () => {
  it('takes the Platform_Override value where the override sets a field (5.2)', () => {
    const profile = resolveOrThrow('STEPSTONE', DEFAULT_SEARCH_PROFILE, {
      STEPSTONE: { searchRadiusKm: 30 },
    });

    expect(profile.criteria).toContainEqual({
      field: 'searchRadiusKm',
      value: 30,
      provenance: 'OVERRIDE',
    });
  });

  it('takes the Default_Search_Profile value where the override leaves a field unset (5.3)', () => {
    const profile = resolveOrThrow('STEPSTONE', DEFAULT_SEARCH_PROFILE, {
      STEPSTONE: { searchRadiusKm: 30 },
    });

    expect(profile.criteria).toContainEqual({
      field: 'jobTitle',
      value: DEFAULT_SEARCH_PROFILE.jobTitle,
      provenance: 'DEFAULT',
    });
  });

  it('emits one criterion per supported field, in supportedFields order (5.4, 5.5, 5.7)', () => {
    const profile = resolveOrThrow('GLASSDOOR', DEFAULT_SEARCH_PROFILE, {});

    expect(profile.criteria.map((criterion) => criterion.field)).toEqual([
      ...PLATFORM_CAPABILITIES.GLASSDOOR.supportedFields,
    ]);
  });

  it('resolves from the Default_Search_Profile only where no Platform_Override exists (4.4)', () => {
    const profile = resolveOrThrow('INDEED', DEFAULT_SEARCH_PROFILE, {});

    expect(profile.criteria.every((criterion) => criterion.provenance === 'DEFAULT')).toBe(true);
  });

  it('returns an error naming the Platform and every missing mandatory field (5.8)', () => {
    const withoutMandatory: Partial<SearchProfile> = {
      titleSynonyms: DEFAULT_SEARCH_PROFILE.titleSynonyms,
      industry: DEFAULT_SEARCH_PROFILE.industry,
      searchRadiusKm: DEFAULT_SEARCH_PROFILE.searchRadiusKm,
      employmentType: DEFAULT_SEARCH_PROFILE.employmentType,
      publicationPeriodDays: DEFAULT_SEARCH_PROFILE.publicationPeriodDays,
    };

    const resolution = resolveSearchProfile('STEPSTONE', withoutMandatory, {});

    expect(resolution).toEqual({
      ok: false,
      error: { platform: 'STEPSTONE', missingMandatoryFields: ['jobTitle', 'searchLocation'] },
    });
  });

  it('keeps resolving when an unset field is supported but not mandatory (5.8)', () => {
    const withoutEmploymentType: Partial<SearchProfile> = {
      jobTitle: DEFAULT_SEARCH_PROFILE.jobTitle,
      titleSynonyms: DEFAULT_SEARCH_PROFILE.titleSynonyms,
      industry: DEFAULT_SEARCH_PROFILE.industry,
      searchLocation: DEFAULT_SEARCH_PROFILE.searchLocation,
      searchRadiusKm: DEFAULT_SEARCH_PROFILE.searchRadiusKm,
      publicationPeriodDays: DEFAULT_SEARCH_PROFILE.publicationPeriodDays,
    };

    const profile = resolveOrThrow('STEPSTONE', withoutEmploymentType, {});

    expect(profile.criteria.map((criterion) => criterion.field)).not.toContain('employmentType');
  });
});

describe('effectiveProfilesEqual', () => {
  it('holds for a repeated resolution of the same inputs (5.5)', () => {
    const first = resolveOrThrow('JOBVECTOR', DEFAULT_SEARCH_PROFILE, {
      JOBVECTOR: { searchLocation: 'München' },
    });
    const second = resolveOrThrow('JOBVECTOR', DEFAULT_SEARCH_PROFILE, {
      JOBVECTOR: { searchLocation: 'München' },
    });

    expect(effectiveProfilesEqual(first, second)).toBe(true);
  });

  it('distinguishes a reordered synonym list from the resolved one (5.5)', () => {
    const profile = resolveOrThrow('JOBVECTOR', DEFAULT_SEARCH_PROFILE, {});
    const reordered: EffectiveSearchProfile = {
      platform: profile.platform,
      criteria: profile.criteria.map((criterion) =>
        criterion.field === 'titleSynonyms'
          ? { ...criterion, value: [...DEFAULT_SEARCH_PROFILE.titleSynonyms].reverse() }
          : criterion,
      ),
    };

    expect(effectiveProfilesEqual(profile, reordered)).toBe(false);
  });
});

describe('formatEffectiveProfile', () => {
  it('renders every criterion with its value and provenance in resolution order (3.8)', () => {
    const profile = resolveOrThrow('GLASSDOOR', DEFAULT_SEARCH_PROFILE, {
      GLASSDOOR: { searchRadiusKm: 10 },
    });

    expect(formatEffectiveProfile(profile)).toBe(
      'GLASSDOOR: jobTitle="Projektmanagerin" (DEFAULT), ' +
        'titleSynonyms=["Projektmanager","Project Manager","Projektleiterin","Projektleiter",' +
        '"Project Lead","Teilprojektleiterin"] (DEFAULT), ' +
        'searchLocation="München" (DEFAULT), searchRadiusKm=10 (OVERRIDE)',
    );
  });
});
