import {
  type CriterionField,
  type EffectiveSearchProfile,
  formatEffectiveProfile,
  type Platform,
} from '@job-scraper/domain';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import {
  platformConfiguredMessageDe,
  platformDisabledMessageDe,
  platformIncompleteConfigurationMessageDe,
} from './platform-config.messages';
import {
  isScrapable,
  type PlatformConfigurationInputs,
  type PlatformConfigurationState,
  resolvePlatformConfigurations,
  type ScrapablePlatformConfiguration,
} from './platform-config.resolve';

/** Injection token of the constants the determination reads; see `platform-config.module.ts`. */
export const PLATFORM_CONFIGURATION_INPUTS = Symbol('PLATFORM_CONFIGURATION_INPUTS');

/**
 * The per-Platform configuration state of this process (4.6 - 4.10).
 *
 * The Default_Search_Profile, the Platform_Override and the activation flags are TypeScript
 * constants: a developer edits them and restarts, and the changed values take effect from that
 * start onward (3.9). That is what makes a startup-scoped singleton the right holder — the state
 * cannot change while the process runs, so resolving once and handing the same answer to every
 * reader is not a cache, it is the whole truth.
 *
 * Two readers are already named by the requirements: the Scraper_Service skips a Platform with
 * Platform_Status `INCOMPLETE_CONFIGURATION` and reports that status together with the missing
 * field names in the run result (4.10), and the `searchCriteria` query behind the read-only
 * criteria view lists the resolved criteria of every supported Platform (4.11). Both read from
 * here rather than resolving again, so the view cannot disagree with what a Scrape_Run does.
 *
 * The resolution happens in the constructor, not in `onModuleInit`: it is pure, it cannot fail as a
 * whole and no reader may ever see an empty state. The lifecycle hook only writes the German lines
 * the user gets to see, which is the part that has to happen once per start rather than once per
 * injection.
 *
 * Unlike the Default_Search_Profile validation (3.6), an incomplete per-Platform configuration does
 * not stop the startup. It is a per-Platform defect with a per-Platform status, and 4.9 explicitly
 * requires the remaining Platform to keep being served.
 *
 * Requirements: 4.6, 4.7, 4.8, 4.9, 4.10, 5.8.
 */
@Injectable()
export class PlatformConfigurationService implements OnModuleInit {
  private readonly logger = new Logger(PlatformConfigurationService.name);

  private readonly statesByPlatform: ReadonlyMap<Platform, PlatformConfigurationState>;

  private readonly resolvedStates: readonly PlatformConfigurationState[];

  constructor(@Inject(PLATFORM_CONFIGURATION_INPUTS) inputs: PlatformConfigurationInputs) {
    this.resolvedStates = resolvePlatformConfigurations(inputs);
    this.statesByPlatform = new Map(this.resolvedStates.map((state) => [state.platform, state]));
  }

  /**
   * Reports the determined state once per start.
   *
   * German for the user, prefixed with the stable English code the Log_Stream will carry once it
   * exists (12.3) — the same shape `AppConfigService` uses for its rejected-value message. The
   * levels follow the design's error table: an incomplete configuration is an `ERROR` because a
   * Platform the user expects results from will produce none, while a deliberately deactivated
   * Platform is information.
   */
  onModuleInit(): void {
    for (const state of this.resolvedStates) {
      this.logState(state);
    }
  }

  /** Every Platform's state, in `PLATFORMS` order (4.11). */
  states(): readonly PlatformConfigurationState[] {
    return this.resolvedStates;
  }

  /**
   * The state of one Platform.
   *
   * Total over `Platform`: the determination covers all of `PLATFORMS`, so there is no Platform
   * without a state and no caller has to handle an absent one.
   */
  stateOf(platform: Platform): PlatformConfigurationState {
    const state = this.statesByPlatform.get(platform);

    if (state === undefined) {
      // Unreachable while `resolvePlatformConfigurations` covers `PLATFORMS`. Throwing beats
      // returning a fabricated state, which would let a Platform be queried without criteria.
      throw new Error(`No configuration state determined for platform ${platform}`);
    }

    return state;
  }

  /**
   * The Platform a Scrape_Run queries: activated and completely configured (4.7, 4.10).
   *
   * Every other Platform is skipped with the status this service determined, so the Scraper_Service
   * needs no activation check and no resolution of its own.
   */
  scrapablePlatforms(): readonly ScrapablePlatformConfiguration[] {
    return this.resolvedStates.filter(isScrapable);
  }

  /** Every activated Platform whose mandatory Criterion_Field did not resolve (4.9). */
  incompletePlatforms(): readonly PlatformConfigurationState[] {
    return this.resolvedStates.filter(
      (state) => state.platformStatus === 'INCOMPLETE_CONFIGURATION',
    );
  }

  /**
   * The resolved criteria of one Platform, or `null` where the resolution failed.
   *
   * This is the value the Scraper_Service persists as the effective Search_Profile of a Platform in
   * a Scrape_Run (3.8); the returned object is the snapshot shape the Posting_Store column expects.
   */
  effectiveProfileOf(platform: Platform): EffectiveSearchProfile | null {
    return this.stateOf(platform).effectiveProfile;
  }

  /** The missing mandatory Criterion_Field of one Platform; empty unless incomplete (4.10). */
  missingMandatoryFieldsOf(platform: Platform): readonly CriterionField[] {
    return this.stateOf(platform).missingMandatoryFields;
  }

  /** Writes the one line that belongs to a determined state. */
  private logState(state: PlatformConfigurationState): void {
    if (state.platformStatus === 'DISABLED') {
      this.logger.log(`platform.disabled: ${platformDisabledMessageDe(state.platform)}`);

      return;
    }

    if (state.platformStatus === 'INCOMPLETE_CONFIGURATION') {
      this.logger.error(
        `platform.incompleteConfiguration: ${platformIncompleteConfigurationMessageDe(
          state.platform,
          state.missingMandatoryFields,
        )}`,
      );

      return;
    }

    const profile = state.effectiveProfile;

    // The German sentence is what the user reads; the appended rendering is the traceable value
    // list, in English identifiers, that keeps the applied criteria reviewable (3.7, 16.8).
    this.logger.log(
      `platform.configured: ${platformConfiguredMessageDe(
        state.platform,
        profile?.criteria.length ?? 0,
      )}${profile === null ? '' : ` ${formatEffectiveProfile(profile)}`}`,
    );
  }
}
