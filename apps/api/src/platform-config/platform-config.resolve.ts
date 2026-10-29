/**
 * The per-Platform configuration state determined at API_Service startup (4.6 - 4.10).
 *
 * Requirement 4.8 asks the API_Service to determine, for every activated Platform, whether
 * Platform_Override and Default_Search_Profile together resolve a complete set of that Platform's
 * mandatory Criterion_Field. This module is that determination, as a pure function over the
 * constants: no Nest, no I/O, no clock, no `process.exit`. The service next to it adds the
 * lifecycle hook and the German log output, which keeps every state transition reachable from a
 * unit test.
 *
 * Two of the 14 Platform_Status values are produced here and nowhere else:
 *
 * - `DISABLED` for a Platform marked as deactivated in the source code (4.6, 4.7),
 * - `INCOMPLETE_CONFIGURATION` for an activated Platform with unresolvable mandatory fields (4.9).
 *
 * An activated Platform that resolves completely carries `NOT_YET_RUN` — the Platform_Status of a
 * Platform that is ready but has not been queried in this process yet. No status value is invented:
 * `PLATFORM_STATUSES` in `@job-scraper/domain` stays the only vocabulary.
 *
 * Requirements: 4.6, 4.7, 4.8, 4.9, 4.10, 5.8.
 */

import {
  type CriterionField,
  type EffectiveSearchProfile,
  type Platform,
  type PlatformCapabilityMap,
  type PlatformOverrideMap,
  PLATFORMS,
  type PlatformStatus,
  resolveSearchProfile,
  type SearchProfile,
} from '@job-scraper/domain';

/** The three Platform_Status values a startup resolution can produce. */
export type StartupPlatformStatus = Extract<
  PlatformStatus,
  'DISABLED' | 'INCOMPLETE_CONFIGURATION' | 'NOT_YET_RUN'
>;

/**
 * What the API_Service knows about one Platform before the first Scrape_Run.
 *
 * `effectiveProfile` is filled whenever the resolution succeeded, including for a deactivated
 * Platform: the read-only criteria view shows the resolved criteria of every supported Platform
 * (4.11), so the profile is needed even where no request will ever be sent. `platformStatus` is
 * what decides whether a Scrape_Run queries the Platform, and that decision is independent of
 * whether a profile exists.
 *
 * The shape of `effectiveProfile` is the one the Posting_Store persists per Scrape_Run and Platform
 * (`PrismaJson.EffectiveSearchProfileJson`), and `missingMandatoryFields` is the
 * `ScrapeRunPlatformResult.missingMandatoryFields` column, so the Scraper_Service can copy both
 * into its result row without a translation step (4.10).
 */
export interface PlatformConfigurationState {
  readonly platform: Platform;
  /** Whether the source code marks this Platform as activated (4.6). */
  readonly activated: boolean;
  readonly platformStatus: StartupPlatformStatus;
  /** The mandatory Criterion_Field neither source resolved; empty unless incomplete (4.10, 5.8). */
  readonly missingMandatoryFields: readonly CriterionField[];
  /** The resolved criteria, or `null` where the resolution failed. */
  readonly effectiveProfile: EffectiveSearchProfile | null;
}

/** A Platform a Scrape_Run may query: activated, complete and therefore carrying a profile. */
export interface ScrapablePlatformConfiguration extends PlatformConfigurationState {
  readonly activated: true;
  readonly platformStatus: 'NOT_YET_RUN';
  readonly effectiveProfile: EffectiveSearchProfile;
}

/**
 * Everything the determination reads.
 *
 * Bundled into one object so the service takes a single constructor argument and a test can swap
 * the whole set of constants for a case the delivered constants do not contain — an unresolvable
 * mandatory field, for instance, which the real `DEFAULT_SEARCH_PROFILE` is validated against at
 * startup and therefore never has (3.5).
 */
export interface PlatformConfigurationInputs {
  /**
   * The Default_Search_Profile. `Partial` for the same reason the Profile_Resolver takes it that
   * way: criterion 5.8 covers the case where the default itself carries no value for a mandatory
   * Criterion_Field, and a total type would make that case unreachable.
   */
  readonly defaults: Partial<SearchProfile>;
  /** Activation per Platform (4.6). */
  readonly activation: Readonly<Record<Platform, boolean>>;
  /** Every Platform_Override (4.1). */
  readonly overrides: PlatformOverrideMap;
  /** The per-Platform capability declaration (4.2). */
  readonly capabilities: PlatformCapabilityMap;
}

/**
 * Determines the configuration state of exactly one Platform.
 *
 * The resolution runs even for a deactivated Platform, so the criteria view has something to show
 * (4.11), but its outcome cannot change the Platform_Status: 4.7 pins a deactivated Platform to
 * `DISABLED` unconditionally. A deactivated Platform with unresolvable mandatory fields therefore
 * reports `DISABLED` and still carries the missing field names, which is the honest answer to both
 * questions — it is off, and it would not run as configured either.
 */
function resolveOne(
  platform: Platform,
  inputs: PlatformConfigurationInputs,
): PlatformConfigurationState {
  const activated = inputs.activation[platform];
  const resolution = resolveSearchProfile(
    platform,
    inputs.defaults,
    inputs.overrides,
    inputs.capabilities,
  );

  const missingMandatoryFields = resolution.ok ? [] : resolution.error.missingMandatoryFields;
  const effectiveProfile = resolution.ok ? resolution.profile : null;

  const platformStatus: StartupPlatformStatus = !activated
    ? 'DISABLED'
    : resolution.ok
      ? 'NOT_YET_RUN'
      : 'INCOMPLETE_CONFIGURATION';

  return { platform, activated, platformStatus, missingMandatoryFields, effectiveProfile };
}

/**
 * Determines the configuration state of every Platform (4.8).
 *
 * One failing Platform never stops the others: the loop runs over all of `PLATFORMS` and each
 * Platform's state is computed from its own resolution only, which is what lets the API_Service
 * keep serving the remaining Platform after an incomplete configuration (4.9).
 *
 * The result is ordered by `PLATFORMS`, so the Log_View and the criteria view list the Platform in
 * the same order on every start.
 *
 * @param inputs The constants the determination reads.
 * @returns One state per Platform, in `PLATFORMS` order.
 */
export function resolvePlatformConfigurations(
  inputs: PlatformConfigurationInputs,
): readonly PlatformConfigurationState[] {
  return PLATFORMS.map((platform) => resolveOne(platform, inputs));
}

/** Narrows a state to the Platform a Scrape_Run may query (4.7, 4.10). */
export function isScrapable(
  state: PlatformConfigurationState,
): state is ScrapablePlatformConfiguration {
  return (
    state.activated && state.platformStatus === 'NOT_YET_RUN' && state.effectiveProfile !== null
  );
}
