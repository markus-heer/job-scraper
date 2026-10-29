import { Field, ID, ObjectType } from '@nestjs/graphql';

import { RunOutcomeEnumRef, RunStatusEnumRef } from '../../graphql/domain-enums';
import type { RunOutcome, RunStatus, ScrapeRun } from '../../prisma/prisma.types';

/**
 * One stored Scrape_Run as the Web_App receives it (11.1, 12.1, 12.5, 12.9).
 *
 * The answer to `scrapeRuns` and to `activeScrapeRun`, and the target of the
 * `JobPosting.firstSeenRun` edge. Every column of the stored row is published — `implements
 * ScrapeRun` makes the compiler check exactly that — because a Scrape_Run has no internal columns:
 * 11.1 names the identifier, the start time, the end time and the Run_Outcome as the stored state,
 * and the two remaining columns are the ones that tell the user why a run looks the way it does.
 *
 * `status` next to `runOutcome` is not redundant. A running Scrape_Run carries no Run_Outcome at all
 * — that is what `null` means here — so the status is what distinguishes "still running" from a
 * finished run whose outcome is somehow missing. `closedByRecovery` is the honest label of a run no
 * process ever finished: the stale-run recovery closed it at a later start, and 11.7 keeps it away
 * from the "neu" marking for exactly that reason.
 *
 * `platformResults` is the only resolved field and is not declared here: it is an edge rather than a
 * column, and it is loaded per request through DataLoader in `../scrape-run-read.resolver.ts`.
 *
 * Distinct from `ScrapeRunSummaryModel`, which the posting overview reads. The two overlap in four
 * fields and differ in what they are for — see the comment there.
 *
 * Requirements: 11.1, 11.7, 12.1, 12.5, 12.9.
 */
@ObjectType('ScrapeRun', {
  description: 'One Scrape_Run as the Job_Tool stored it.',
})
export class ScrapeRunModel implements ScrapeRun {
  @Field(() => ID, { description: 'Identifier of the Scrape_Run (11.1).' })
  id: string;

  @Field(() => Date, { description: 'When the Scrape_Run started (11.1).' })
  startedAt: Date;

  @Field(() => Date, {
    nullable: true,
    description: 'When the Scrape_Run ended, or null while it is still running (11.1).',
  })
  finishedAt: Date | null;

  @Field(() => RunStatusEnumRef, {
    description: 'Whether the Scrape_Run is still running or has finished.',
  })
  status: RunStatus;

  @Field(() => RunOutcomeEnumRef, {
    nullable: true,
    description: 'How the Scrape_Run ended, or null while it is still running (11.1).',
  })
  runOutcome: RunOutcome | null;

  @Field(() => Boolean, {
    description:
      'True where this Scrape_Run was closed by the recovery at a later start of the API_Service rather than by the process that ran it. Such a run is never the reference run of the "neu" marking (11.7).',
  })
  closedByRecovery: boolean;
}
