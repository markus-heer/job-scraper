/**
 * How the startup determination maps a Platform onto a Platform_Status (4.6 - 4.10).
 *
 * The two mappings under test are the ones no other component can produce: a deactivated Platform
 * becomes `DISABLED` (4.7) and an activated Platform with unresolvable mandatory Criterion_Field
 * becomes `INCOMPLETE_CONFIGURATION` together with the names of those fields (4.9, 4.10). The third
 * case — activated and complete — has to stay reachable next to them, because 4.9 requires the
 * remaining Platform to keep being served.
 *
 * The delivered `DEFAULT_SEARCH_PROFILE` is validated at startup and therefore always resolves
 * every mandatory field (3.5), so the incomplete case is driven by a deliberately incomplete
 * default rather than by the production constant.
 *
 * Requirements: 4.6, 4.7, 4.8, 4.9, 4.10, 5.8.
 */

import { PLATFORM_CAPABILITIES } from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import { isScrapable, resolvePlatformConfigurations } from '../platform-config.resolve';
import { ALL_ACTIVATED, defaultsWithout, inputs, stateOf } from './platform-config.fixture';

/** The Default_Search_Profile with one mandatory Criterion_Field of every Platform removed. */
const withoutSearchLocation = () => defaultsWithout('searchLocation');

describe('resolvePlatformConfigurations', () => {
  it('determines exactly one state per Platform (4.8)', () => {
    const states = resolvePlatformConfigurations(inputs());

    expect(states.map((state) => state.platform)).toEqual([
      'GLASSDOOR',
      'JOBVECTOR',
      'INDEED',
      'STEPSTONE',
    ]);
  });

  it('maps a deactivated Platform onto DISABLED without any missing field (4.6, 4.7)', () => {
    const states = resolvePlatformConfigurations(
      inputs({ activation: { ...ALL_ACTIVATED, GLASSDOOR: false } }),
    );
    const glassdoor = stateOf(states, 'GLASSDOOR');

    expect(glassdoor.activated).toBe(false);
    expect(glassdoor.platformStatus).toBe('DISABLED');
    expect(glassdoor.missingMandatoryFields).toEqual([]);
    expect(isScrapable(glassdoor)).toBe(false);
  });

  it('keeps the resolved criteria of a deactivated Platform for the criteria view (4.11)', () => {
    const states = resolvePlatformConfigurations(
      inputs({ activation: { ...ALL_ACTIVATED, GLASSDOOR: false } }),
    );

    expect(stateOf(states, 'GLASSDOOR').effectiveProfile?.criteria.map((c) => c.field)).toEqual(
      PLATFORM_CAPABILITIES.GLASSDOOR.supportedFields,
    );
  });

  it('maps an unresolvable mandatory field onto INCOMPLETE_CONFIGURATION and names it (4.9, 4.10)', () => {
    const states = resolvePlatformConfigurations(inputs({ defaults: withoutSearchLocation() }));
    const stepstone = stateOf(states, 'STEPSTONE');

    expect(stepstone.activated).toBe(true);
    expect(stepstone.platformStatus).toBe('INCOMPLETE_CONFIGURATION');
    expect(stepstone.missingMandatoryFields).toEqual(['searchLocation']);
    expect(stepstone.effectiveProfile).toBeNull();
    expect(isScrapable(stepstone)).toBe(false);
  });

  it('keeps serving the remaining Platform when one is incompletely configured (4.9)', () => {
    // Jobvector declares `jobTitle` as its only mandatory Criterion_Field, so it is the one
    // Platform that still resolves once the default search location is gone.
    const states = resolvePlatformConfigurations(inputs({ defaults: withoutSearchLocation() }));

    expect(
      states
        .filter((state) => state.platformStatus === 'INCOMPLETE_CONFIGURATION')
        .map((state) => state.platform),
    ).toEqual(['GLASSDOOR', 'INDEED', 'STEPSTONE']);

    const jobvector = stateOf(states, 'JOBVECTOR');

    expect(jobvector.platformStatus).toBe('NOT_YET_RUN');
    expect(isScrapable(jobvector)).toBe(true);
  });

  it('reports a deactivated Platform as DISABLED even when its criteria do not resolve (4.7)', () => {
    const states = resolvePlatformConfigurations(
      inputs({
        defaults: withoutSearchLocation(),
        activation: { ...ALL_ACTIVATED, INDEED: false },
      }),
    );
    const indeed = stateOf(states, 'INDEED');

    expect(indeed.platformStatus).toBe('DISABLED');
    expect(indeed.missingMandatoryFields).toEqual(['searchLocation']);
  });

  it('gives a completely configured, activated Platform the status NOT_YET_RUN', () => {
    const states = resolvePlatformConfigurations(inputs());

    expect(states.every((state) => state.platformStatus === 'NOT_YET_RUN')).toBe(true);
    expect(states.every(isScrapable)).toBe(true);
  });

  it('produces the snapshot shape the Posting_Store persists per run and Platform (3.8)', () => {
    const state = stateOf(resolvePlatformConfigurations(inputs()), 'STEPSTONE');

    // The assignment is the assertion: `effectiveProfile` has to satisfy the typed JSON column
    // `ScrapeRunPlatformResult.effectiveProfile` without a cast, so the Scraper_Service can write
    // the state it read here straight into its result row.
    const snapshot: PrismaJson.EffectiveSearchProfileJson | null = state.effectiveProfile;

    expect(snapshot?.platform).toBe('STEPSTONE');
  });
});
