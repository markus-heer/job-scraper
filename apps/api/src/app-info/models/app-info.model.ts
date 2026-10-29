import { Field, Int, ObjectType } from '@nestjs/graphql';

import type { AppInfo } from '../app-info.service';

/**
 * What the Web_App states about the running Job_Tool (8.10, 14.8).
 *
 * The answer to `appInfo`, non-nullable in every field: all four values exist from the first start
 * on, because the configuration check of 1.15 refuses to start the API_Service without them and the
 * activation state is a boolean either way.
 *
 * `implements AppInfo` is the load-bearing part of this declaration, as on every other model here:
 * the service owns the values and this class publishes them, so a field added on one side fails
 * `pnpm check-types` instead of silently going missing from the schema.
 *
 * Requirements: 8.10, 8.11, 14.8.
 */
@ObjectType('AppInfo', {
  description: 'The state of the running Job_Tool, as the landing page of the Web_App states it.',
})
export class AppInfoModel implements AppInfo {
  @Field(() => Boolean, {
    description:
      'Whether the Relevance_Service is currently activated. While it is deactivated, no AI_Provider request is sent and every Job_Posting carries the Relevance_Verdict "not assessed".',
  })
  relevanceServiceActivated: boolean;

  @Field(() => String, {
    description: 'The Home_Address every commute determination starts from.',
  })
  homeAddress: string;

  @Field(() => Int, {
    description:
      'The Commute_Threshold in whole minutes. A Job_Posting with a Best_Commute_Time of at most this value counts as well reachable.',
  })
  commuteThresholdMinutes: number;

  @Field(() => String, {
    description: 'German notice naming the private purpose of use of the Job_Tool.',
  })
  privateUseNoticeDe: string;
}
