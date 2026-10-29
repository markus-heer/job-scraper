import { Inject, Injectable } from '@nestjs/common';

import { AppConfigService } from '../config/config.service';
import { RelevanceService } from '../relevance/relevance.service';
import { PRIVATE_USE_NOTICE_DE } from './app-info.messages';

/** The part of the configuration this service reads (8.10). */
export type AppInfoConfig = Pick<AppConfigService, 'homeAddress' | 'commuteThresholdMinutes'>;

/** The part of the Relevance_Service this service reads: whether it is activated (15.9, 15.10). */
export type RelevanceActivation = Pick<RelevanceService, 'activated'>;

/** The part of this service the resolver calls. See `./app-info.resolver.ts`. */
export type AppInfoQuery = Pick<AppInfoService, 'appInfo'>;

/** What the Web_App states about the running Job_Tool (8.10, 14.8). */
export interface AppInfo {
  /** Whether the Relevance_Service is currently activated (14.8). */
  readonly relevanceServiceActivated: boolean;
  /** The Home_Address every commute determination starts from (8.10). */
  readonly homeAddress: string;
  /** The Commute_Threshold in force, in whole minutes (8.10). */
  readonly commuteThresholdMinutes: number;
  /** The German private-use notice of 14.8. */
  readonly privateUseNoticeDe: string;
}

/**
 * The four facts the Web_App states about the running Job_Tool (8.10, 8.11, 14.8).
 *
 * One query over two sources, and both are read per request rather than captured once:
 * `AppConfigService` knows which of the environment file and the last accepted value won (8.10,
 * 8.14), and `RelevanceService` knows whether the deactivation switch bound the AI_Provider or the
 * no-op (15.9, 15.10). Neither can change while the process runs, so reading them again costs
 * nothing and keeps this service free of a second copy of either value.
 *
 * Why the Commute_Threshold is published at all: it is the number the reachability of 8.3 and the
 * filter of 8.11 are read against, and the Web_App renders the hint "gut erreichbar" next to a
 * Job_Posting. Without the threshold it would have to guess which postings carry it, or the
 * API_Service would have to publish a second derived field per posting.
 *
 * No credential is published and none can be: the three values above are a boolean, an address the
 * user configured and a number, and the German sentence takes no input at all (14.9).
 *
 * Requirements: 8.10, 8.11, 14.8, 14.9.
 */
@Injectable()
export class AppInfoService {
  constructor(
    @Inject(AppConfigService) private readonly config: AppInfoConfig,
    @Inject(RelevanceService) private readonly relevance: RelevanceActivation,
  ) {}

  /** The state of the running Job_Tool, as the landing page of 14.8 states it. */
  appInfo(): AppInfo {
    return {
      relevanceServiceActivated: this.relevance.activated,
      homeAddress: this.config.homeAddress,
      commuteThresholdMinutes: this.config.commuteThresholdMinutes,
      privateUseNoticeDe: PRIVATE_USE_NOTICE_DE,
    };
  }
}
