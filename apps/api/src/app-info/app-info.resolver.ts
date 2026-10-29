import { Inject } from '@nestjs/common';
import { Query, Resolver } from '@nestjs/graphql';

import { type AppInfo, type AppInfoQuery, AppInfoService } from './app-info.service';
import { AppInfoModel } from './models/app-info.model';

/**
 * The one query the landing page of the Web_App asks before it shows anything (14.8).
 *
 * Thin by construction: the method forwards to `AppInfoService` and returns what it yields. The
 * German notice, the activation state and the two configured values all live behind that service,
 * because each of them is owned by a different component and none of them is a decision about a
 * GraphQL request.
 *
 * Requirements: 8.10, 14.8.
 */
@Resolver()
export class AppInfoResolver {
  /**
   * The service is injected by its class token explicitly, as everywhere else in this application:
   * naming the token keeps the import a value import and the dependency visible, instead of making
   * the wiring depend on emitted decorator metadata that a type-only import would drop.
   */
  constructor(@Inject(AppInfoService) private readonly info: AppInfoQuery) {}

  /** The state of the running Job_Tool (8.10, 14.8). */
  @Query(() => AppInfoModel, {
    name: 'appInfo',
    description:
      'The state of the running Job_Tool: whether the Relevance_Service is activated, the configured Home_Address and Commute_Threshold, and the German notice about the private purpose of use.',
  })
  appInfo(): AppInfo {
    return this.info.appInfo();
  }
}
