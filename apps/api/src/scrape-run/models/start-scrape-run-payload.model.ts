import { Field, ID, ObjectType } from '@nestjs/graphql';

import type { StartRunPayload } from '../scrape-run.service';

/**
 * What `startScrapeRun` answers with (12.1, 12.5, 12.13).
 *
 * A payload type rather than a GraphQL error, because all three outcomes are things the user is
 * expected to act on and the design says so explicitly: the Web_App shows a German sentence with
 * exactly one recommended next step (2.5) without inspecting `extensions`.
 *
 * The three outcomes are distinguished by the fields alone, so the Web_App needs no error handling
 * to tell them apart:
 *
 * - a Scrape_Run was created: `runId` is set, `alreadyRunning` is false and `hintDe` is null;
 * - one was already running (12.5): `runId` is the running run's, `alreadyRunning` is true and
 *   `hintDe` carries the hint, so the Log_View can be opened on the run that is in fact running;
 * - none could be created (12.13): `runId` is null and `hintDe` names the cause.
 *
 * `implements StartRunPayload` is the load-bearing part: the service owns the decision and this
 * class only publishes it, so a field added on one side fails `check-types` instead of silently
 * going missing from the schema.
 *
 * Requirements: 12.1, 12.5, 12.13.
 */
@ObjectType('StartScrapeRunPayload', {
  description: 'The answer to a request to start a Scrape_Run.',
})
export class StartScrapeRunPayloadModel implements StartRunPayload {
  @Field(() => ID, {
    nullable: true,
    description:
      'Identifier of the created Scrape_Run, or of the one that was already running. Null exactly when no Scrape_Run could be created (12.13).',
  })
  runId: string | null;

  @Field(() => Boolean, {
    description:
      'True when a Scrape_Run was already running, in which case no second one was created (12.5).',
  })
  alreadyRunning: boolean;

  @Field(() => String, {
    nullable: true,
    description:
      'German hint naming the cause and one recommended next step; null when the Scrape_Run started normally.',
  })
  hintDe: string | null;
}
