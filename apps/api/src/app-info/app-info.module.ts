import { Module } from '@nestjs/common';

import { RelevanceModule } from '../relevance/relevance.module';
import { AppInfoResolver } from './app-info.resolver';
import { AppInfoService } from './app-info.service';

/**
 * The `appInfo` query of the landing page (14.8).
 *
 * A module of its own, because the query spans two components and belongs to neither: the
 * Commute_Threshold and the Home_Address are `AppConfigService`'s, and whether the Relevance_Service
 * is activated is `RelevanceService`'s. Putting the resolver in `ConfigModule` would make the global
 * configuration module import the Relevance_Service, and putting it in `RelevanceModule` would put a
 * statement about the whole Job_Tool inside the component that assesses one Job_Posting.
 *
 * `RelevanceModule` is imported for the activation state it exports. `ConfigModule` is not: it is
 * global, and `AppConfigService` is taken through its class token.
 *
 * Nothing is exported: a resolver is a leaf of the object graph, and the service exists for this one
 * query.
 */
@Module({
  imports: [RelevanceModule],
  providers: [AppInfoService, AppInfoResolver],
})
export class AppInfoModule {}
