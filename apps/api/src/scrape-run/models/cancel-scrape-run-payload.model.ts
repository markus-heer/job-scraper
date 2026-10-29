import { Field, ID, ObjectType } from '@nestjs/graphql';

import { RunOutcomeEnumRef } from '../../graphql/domain-enums';
import type { RunOutcome } from '../../prisma/prisma.types';
import type { CancelRunPayload } from '../scrape-run.service';

/**
 * What `cancelScrapeRun` answers with (12.7, 12.14).
 *
 * `rejectedReasonDe` is the discriminator: null means the running Scrape_Run was cancelled and
 * `runOutcome` is "cancelled by user" (12.7); a text means the cancellation was rejected, and
 * `runOutcome` is then the stored Run_Outcome of that Scrape_Run as 12.14 requires — null only
 * where none is stored, which is a run the Posting_Store does not know and a row a crashed process
 * left behind. A rejection is a payload and not a GraphQL error for the reason the design gives:
 * the user is expected to act on it, so it has to arrive as a German sentence (2.5).
 *
 * Requirements: 12.7, 12.14.
 */
@ObjectType('CancelScrapeRunPayload', {
  description: 'The answer to a request to cancel a Scrape_Run.',
})
export class CancelScrapeRunPayloadModel implements CancelRunPayload {
  @Field(() => ID, { description: 'Identifier of the Scrape_Run the cancellation was meant for.' })
  runId: string;

  @Field(() => RunOutcomeEnumRef, {
    nullable: true,
    description:
      'The Run_Outcome in force after the call: "cancelled by user" for a cancellation that took effect, otherwise the stored Run_Outcome of that Scrape_Run (12.14). Null where none is stored.',
  })
  runOutcome: RunOutcome | null;

  @Field(() => String, {
    nullable: true,
    description:
      'German reason why the cancellation was rejected, with one recommended next step. Null when the Scrape_Run was cancelled.',
  })
  rejectedReasonDe: string | null;
}
