/**
 * Shared inputs for the per-Platform startup determination (4.6 - 4.10).
 *
 * The delivered `DEFAULT_SEARCH_PROFILE` is validated at startup and therefore always resolves
 * every mandatory Criterion_Field (3.5), so the incomplete case has to be driven by a deliberately
 * incomplete default. Building that default in one place keeps the three suites in this directory
 * talking about the same constants: the pure determination, the service that logs it, and the
 * per-Platform independence 4.9 promises.
 *
 * Not a test file: the name keeps it out of the Vitest discovery pattern.
 *
 * Requirements: 4.6, 4.7, 4.8, 4.9, 4.10, 5.8.
 */

import {
  type CriterionField,
  DEFAULT_SEARCH_PROFILE,
  type Platform,
  PLATFORM_CAPABILITIES,
  type SearchProfile,
} from '@job-scraper/domain';
import { Logger } from '@nestjs/common';
import { vi } from 'vitest';

import type {
  PlatformConfigurationInputs,
  PlatformConfigurationState,
} from '../platform-config.resolve';
import { PlatformConfigurationService } from '../platform-config.service';

/** Every Platform activated, which is the delivered state (4.6). */
export const ALL_ACTIVATED: Readonly<Record<Platform, boolean>> = {
  GLASSDOOR: true,
  JOBVECTOR: true,
  INDEED: true,
  STEPSTONE: true,
};

/** The delivered constants, with single parts replaced for the case under test. */
export const inputs = (
  overrides: Partial<PlatformConfigurationInputs> = {},
): PlatformConfigurationInputs => ({
  defaults: DEFAULT_SEARCH_PROFILE,
  activation: ALL_ACTIVATED,
  overrides: {},
  capabilities: PLATFORM_CAPABILITIES,
  ...overrides,
});

/**
 * The Default_Search_Profile without the named Criterion_Field.
 *
 * `delete` is not an option: every field of `SearchProfile` is `readonly`, so the reduced profile
 * is built rather than mutated.
 */
export const defaultsWithout = (...fields: readonly CriterionField[]): Partial<SearchProfile> =>
  Object.fromEntries(
    Object.entries(DEFAULT_SEARCH_PROFILE).filter(
      ([field]) => !fields.includes(field as CriterionField),
    ),
  ) as Partial<SearchProfile>;

/** The determined state of one Platform; throws rather than returning `undefined`. */
export const stateOf = (
  states: readonly PlatformConfigurationState[],
  platform: Platform,
): PlatformConfigurationState => {
  const state = states.find((candidate) => candidate.platform === platform);

  if (state === undefined) {
    throw new Error(`No state for ${platform}`);
  }

  return state;
};

/** The determined states by Platform_Status, for the "the rest stays served" assertions (4.9). */
export const platformsWithStatus = (
  states: readonly PlatformConfigurationState[],
  status: PlatformConfigurationState['platformStatus'],
): readonly Platform[] =>
  states.filter((state) => state.platformStatus === status).map((state) => state.platform);

/** Runs one startup and captures the German lines without letting them reach the console. */
export const startWith = (configuration: PlatformConfigurationInputs) => {
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const service = new PlatformConfigurationService(configuration);

  service.onModuleInit();

  const lines = (spy: typeof log): string[] => spy.mock.calls.map((call) => String(call[0]));

  return { service, logLines: lines(log), errorLines: lines(error) };
};
