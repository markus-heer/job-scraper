import {
  DEFAULT_SEARCH_PROFILE,
  PLATFORM_ACTIVATION,
  PLATFORM_CAPABILITIES,
  PLATFORM_OVERRIDES,
} from '@job-scraper/domain';
import { Global, Module } from '@nestjs/common';

import type { PlatformConfigurationInputs } from './platform-config.resolve';
import { PlatformConfigResolver } from './platform-config.resolver';
import {
  PLATFORM_CONFIGURATION_INPUTS,
  PlatformConfigurationService,
} from './platform-config.service';

/**
 * The constants the running Job_Tool determines its per-Platform state from (3.1, 4.1, 4.2, 4.6).
 *
 * Exported so a test can assert the production wiring reads the delivered constants, rather than
 * re-listing them and then asserting against its own copy.
 */
export const DOMAIN_PLATFORM_CONFIGURATION_INPUTS: PlatformConfigurationInputs = {
  defaults: DEFAULT_SEARCH_PROFILE,
  activation: PLATFORM_ACTIVATION,
  overrides: PLATFORM_OVERRIDES,
  capabilities: PLATFORM_CAPABILITIES,
};

/**
 * The per-Platform configuration state determined at startup (4.8).
 *
 * `@Global` for the same reason as `ConfigModule` and `PrismaModule`: the state is startup
 * infrastructure with exactly one correct instance. The Scraper_Service reads which Platform to
 * query (4.10) and the `searchCriteria` resolver reads what to display (4.11); a second instance
 * would mean a second resolution, and a Scrape_Run that silently disagrees with the criteria view
 * is the one failure mode this module exists to prevent.
 *
 * The constants arrive through a provider rather than being imported by the service, so a unit test
 * can construct the service over a profile the delivered constants do not contain — an
 * unresolvable mandatory Criterion_Field, which `DEFAULT_SEARCH_PROFILE` is validated against at
 * startup and therefore never has (3.5).
 *
 * `PlatformConfigResolver` publishes that state as the `searchCriteria` query of 4.11 and is not
 * exported: a resolver is a leaf of the object graph. It lives here rather than in a module of its
 * own because the state it reads is this module's and the query adds nothing but the published
 * shape.
 */
@Global()
@Module({
  providers: [
    {
      provide: PLATFORM_CONFIGURATION_INPUTS,
      useValue: DOMAIN_PLATFORM_CONFIGURATION_INPUTS,
    },
    PlatformConfigurationService,
    PlatformConfigResolver,
  ],
  exports: [PlatformConfigurationService],
})
export class PlatformConfigModule {}
