/**
 * The read-only criteria view of 4.11 to 4.13, as a pure function over the determined state.
 *
 * The API_Service resolves the Default_Search_Profile and the Platform_Override of every Platform
 * once at startup, in `./platform-config.resolve.ts`, and `PlatformConfigurationService` holds that
 * answer for the whole process. This module turns it into what the `searchCriteria` query publishes,
 * and it does exactly two things the stored state does not already say:
 *
 * - **It renders each resolved value as one German text.** A Criterion_Field value is a string, a
 *   number or a list of strings, and a GraphQL field has one type. The alternative would be a JSON
 *   scalar or one nullable field per value shape, and both would push the rendering decision into
 *   the Web_App — which is the component 4.13 forbids to offer an editable control, so it has
 *   nothing to gain from the structure. The wording is `./criterion-value-text.ts`, which is also
 *   why `employmentType` arrives as "Festanstellung" and `searchRadiusKm` as "50 km" rather than as
 *   the enum literal and the bare number the constants hold.
 * - **It states the Platform_Status in German.** The same arrangement as
 *   `ScrapeRunPlatformResult.platformStatusLabelDe`: the label of a 14-value closed vocabulary and
 *   the sentence that explains a configuration state both belong to the API_Service, and
 *   `apps/web/src/i18n/de.ts` holds no copy of either.
 * - **It keeps every Platform.** 4.11 scopes the view to "every supported Platform", and 19.1 shows
 *   a deactivated Platform and one with an incomplete configuration with their status. So the view
 *   is one block per `Platform`, not one per Platform a Scrape_Run would query.
 *
 * What it deliberately does not do is resolve anything. A second resolution is the one way the
 * criteria view could disagree with what a Scrape_Run applies, and the service exists to prevent
 * that.
 *
 * Requirements: 4.7, 4.9, 4.10, 4.11, 4.12, 4.13.
 */

import type {
  CriterionField,
  EffectiveCriterion,
  FieldProvenance,
  Platform,
} from '@job-scraper/domain';

import { PLATFORM_STATUS_LABELS_DE } from '../common/error-mapping';
import { criterionValueTextDe } from './criterion-value-text';
import {
  platformDisabledMessageDe,
  platformIncompleteConfigurationMessageDe,
} from './platform-config.messages';
import type { PlatformConfigurationState, StartupPlatformStatus } from './platform-config.resolve';

/** One resolved Criterion_Field as the criteria view publishes it (4.11, 4.12). */
export interface CriterionView {
  /** The Criterion_Field name, an English identifier the Web_App labels in German. */
  readonly field: CriterionField;
  /** The resolved value as one German text; see `./criterion-value-text.ts`. */
  readonly valueText: string;
  /** Which of the two sources supplied the value (4.12). */
  readonly provenance: FieldProvenance;
}

/** The effective Search_Profile of one Platform with its configuration state (4.11, 4.12). */
export interface PlatformCriteriaView {
  readonly platform: Platform;
  /** Whether the source code marks this Platform as activated (4.6, 4.7). */
  readonly activated: boolean;
  readonly platformStatus: StartupPlatformStatus;
  /** The Platform_Status as German text, for a reader that prints it (4.7, 4.9). */
  readonly platformStatusLabelDe: string;
  /**
   * Why this Platform is in that state, as one German sentence; `null` where it is simply ready.
   *
   * The two sentences a configuration state needs are already written and already read by the user
   * in the Log_View: the deactivation of 4.7 and the incomplete configuration of 4.9, the latter
   * naming the missing field names. They are published here so the criteria view says the same
   * thing the Log_Stream said, rather than a second wording of it.
   *
   * One sentence per Platform_Status, which is why a deactivated Platform with unresolvable
   * mandatory fields explains its deactivation: that is the state it is in, and `platformStatus`
   * pins it to `DISABLED` unconditionally (4.7). Its missing field names are still published in
   * `missingMandatoryFields`.
   */
  readonly configurationHintDe: string | null;
  /**
   * Exactly one entry per Criterion_Field this Platform supports, in the declared order.
   *
   * Empty where the resolution failed: a Platform whose mandatory fields did not resolve carries no
   * effective Search_Profile at all, and the field names it is missing are the answer instead (4.9,
   * 4.10).
   */
  readonly criteria: readonly CriterionView[];
  /** The mandatory Criterion_Field neither source resolved; empty unless incomplete (4.10). */
  readonly missingMandatoryFields: readonly CriterionField[];
}

/** One resolved criterion as the view publishes it. */
const criterionViewOf = (criterion: EffectiveCriterion): CriterionView => ({
  field: criterion.field,
  valueText: criterionValueTextDe(criterion),
  provenance: criterion.provenance,
});

/**
 * The German sentence that explains one configuration state, or `null` for a Platform that is ready.
 *
 * Total over the three Platform_Status a startup determination can produce, so a fourth one cannot
 * be added without deciding what it says to the user. `NOT_YET_RUN` deliberately says nothing: the
 * Platform is configured and will be queried, and the criteria next to it are the whole answer.
 */
const configurationHintDeOf = (state: PlatformConfigurationState): string | null => {
  switch (state.platformStatus) {
    case 'DISABLED':
      return platformDisabledMessageDe(state.platform);

    case 'INCOMPLETE_CONFIGURATION':
      return platformIncompleteConfigurationMessageDe(state.platform, state.missingMandatoryFields);

    case 'NOT_YET_RUN':
      return null;
  }
};

/**
 * The criteria view of one Platform (4.11, 4.12).
 *
 * @param state The configuration state the API_Service determined at startup.
 */
export const platformCriteriaViewOf = (
  state: PlatformConfigurationState,
): PlatformCriteriaView => ({
  platform: state.platform,
  activated: state.activated,
  platformStatus: state.platformStatus,
  platformStatusLabelDe: PLATFORM_STATUS_LABELS_DE[state.platformStatus],
  configurationHintDe: configurationHintDeOf(state),
  criteria: (state.effectiveProfile?.criteria ?? []).map(criterionViewOf),
  missingMandatoryFields: state.missingMandatoryFields,
});

/**
 * The criteria view of every Platform, in the order the determination produced (4.11).
 *
 * That order is `PLATFORMS`, so the view lists the Platform the same way on every start and the
 * Web_App needs no sort of its own.
 *
 * @param states Every Platform's configuration state, from `PlatformConfigurationService.states()`.
 */
export const platformCriteriaViewsOf = (
  states: readonly PlatformConfigurationState[],
): readonly PlatformCriteriaView[] => states.map(platformCriteriaViewOf);
