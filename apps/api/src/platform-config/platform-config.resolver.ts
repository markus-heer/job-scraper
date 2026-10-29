import { Inject } from '@nestjs/common';
import { Query, Resolver } from '@nestjs/graphql';

import { PlatformSearchCriteriaModel } from './models/platform-search-criteria.model';
import { PlatformConfigurationService } from './platform-config.service';
import { type PlatformCriteriaView, platformCriteriaViewsOf } from './platform-criteria-view';

/** The part of the configuration service this resolver reads. */
export type PlatformStates = Pick<PlatformConfigurationService, 'states'>;

/**
 * The read-only view of the search criteria (4.11, 4.12, 4.13).
 *
 * Thin like every other resolver here: the state was determined once at startup and is held by
 * `PlatformConfigurationService`, the rendering is the pure function in
 * `./platform-criteria-view.ts`, and this method is the one line that joins them.
 *
 * No argument and no pagination. The answer is one block per supported Platform — at most four, as
 * 4.1 bounds the Platform_Override — and it cannot change while the process runs: the
 * Default_Search_Profile, every Platform_Override and the activation flags are TypeScript constants
 * that take effect from the next start onward (3.9). That is also what makes the query read-only in
 * the strongest sense available in a schema: there is no mutation that writes any of it, and 4.13
 * asks the Web_App to refer the user to the Steering_Docs instead.
 *
 * Requirements: 4.11, 4.12, 4.13.
 */
@Resolver()
export class PlatformConfigResolver {
  /**
   * The service is injected by its class token explicitly, as everywhere else in this application:
   * naming the token keeps the import a value import and the dependency visible, instead of making
   * the wiring depend on emitted decorator metadata that a type-only import would drop.
   */
  constructor(@Inject(PlatformConfigurationService) private readonly platforms: PlatformStates) {}

  /** The effective Search_Profile of every supported Platform (4.11). */
  @Query(() => [PlatformSearchCriteriaModel], {
    name: 'searchCriteria',
    description:
      'The effective search criteria of every supported Platform, read-only. Per Platform the activation state, the configuration state, every supported Criterion_Field with the source its value came from, and the mandatory Criterion_Field that did not resolve.',
  })
  searchCriteria(): readonly PlatformCriteriaView[] {
    return platformCriteriaViewsOf(this.platforms.states());
  }
}
