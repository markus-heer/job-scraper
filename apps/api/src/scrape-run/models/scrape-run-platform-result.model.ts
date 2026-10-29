import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

import { PlatformEnumRef, PlatformStatusEnumRef } from '../../graphql/domain-enums';
import type { Platform, PlatformStatus, ScrapeRunPlatformResult } from '../../prisma/prisma.types';

/** The columns of a result row that stay inside the API_Service. */
type InternalResultColumn = 'runId' | 'effectiveProfile';

/**
 * What one Platform produced in one Scrape_Run (7.4, 4.10, 12.3).
 *
 * Exactly one row per requested Platform, which is what 7.4 guarantees, and the published surface is
 * that row minus two columns:
 *
 * - `runId` is the edge this type hangs from. A client that holds a `ScrapeRun` already knows it.
 * - `effectiveProfile` is the criteria snapshot of 3.8, a JSON column kept so a past Scrape_Run
 *   stays reproducible. Publishing it would need a JSON scalar in a schema that has none, and the
 *   criteria the user is shown are the *current* ones, which `searchCriteria` answers with (4.11).
 *
 * `missingMandatoryFields` is published, because 4.10 asks the Platform_Status
 * "incomplete configuration" to be reported together with the missing field names — the field names
 * are English Criterion_Field identifiers and the Web_App renders them next to the German status
 * label.
 *
 * `implements Omit<ScrapeRunPlatformResult, InternalResultColumn>` is the load-bearing part of this
 * declaration, as on every other model here: a renamed or retyped column in `schema.prisma` fails
 * `pnpm check-types` instead of turning into a `null` in the Web_App.
 *
 * Requirements: 4.10, 7.4, 12.3.
 */
@ObjectType('ScrapeRunPlatformResult', {
  description: 'What one Platform produced in one Scrape_Run.',
})
export class ScrapeRunPlatformResultModel implements Omit<
  ScrapeRunPlatformResult,
  InternalResultColumn
> {
  @Field(() => ID, { description: 'Identifier of the result row.' })
  id: string;

  @Field(() => PlatformEnumRef, { description: 'The Platform this row is about.' })
  platform: Platform;

  @Field(() => PlatformStatusEnumRef, {
    description: 'How the retrieval of this Platform ended in this Scrape_Run (7.4).',
  })
  platformStatus: PlatformStatus;

  @Field(() => Int, { description: 'Result list pages retrieved from this Platform (13.5).' })
  pagesFetched: number;

  @Field(() => Int, {
    description: 'Job_Posting recorded for the first time from this Platform in this Scrape_Run.',
  })
  newPostings: number;

  @Field(() => Int, {
    description: 'Job_Posting of this Platform that were already stored and were sighted again.',
  })
  updatedPostings: number;

  @Field(() => Boolean, {
    description:
      'True where the retrieval of this Platform ended before its result list was read to the end, so the stored postings are a Partial_Result (7.7).',
  })
  partialResult: boolean;

  @Field(() => [String], {
    description:
      'The mandatory Criterion_Field that neither the Default_Search_Profile nor the Platform_Override resolved. Empty unless the Platform_Status is "incomplete configuration" (4.10).',
  })
  missingMandatoryFields: string[];
}
