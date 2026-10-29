import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

import { RunOutcomeEnumRef } from '../../graphql/domain-enums';
import type { RunOutcome } from '../../prisma/prisma.types';
import type { ScrapeRunSummary } from '../scrape-run-read.service';

/**
 * What the posting overview states about the most recently completed Scrape_Run (11.5, 11.6).
 *
 * The answer to `latestScrapeRun`, and nullable on purpose: 11.6 asks the Web_App to show a German
 * hint *instead of* these values while the Posting_Store holds no Scrape_Run with the Run_Outcome
 * "completed", and `null` is that case. The hint itself is not carried here, because it is a
 * sentence the user reads and the Web_App owns every sentence it renders without the API_Service
 * having had an opinion to express — there is nothing to report but the absence.
 *
 * Seven values rather than the three counts alone: 11.5 names the start time, the end time and the
 * Run_Outcome next to them, and the run's `id` comes with them so the Web_App can open the Log_View
 * of the run the numbers are about and Apollo can normalize the type.
 *
 * `implements ScrapeRunSummary` is the load-bearing part of this declaration, as on every other
 * model here: the service owns the values and this class only publishes them, so a field added on
 * one side fails `pnpm check-types` instead of silently going missing from the schema.
 *
 * This is a *summary* and not the `ScrapeRun` type the run list of 10.1 returns. The two overlap in
 * four fields and differ in what they are for: a `ScrapeRun` is a stored row with its per-Platform
 * results, while this type is the one run the overview is built around, with the counters of 11.5
 * that no single row carries.
 *
 * Requirements: 11.5, 11.6.
 */
@ObjectType('ScrapeRunSummary', {
  description:
    'The most recently completed Scrape_Run with the counters the posting overview states. Absent while no Scrape_Run has reached the Run_Outcome "completed".',
})
export class ScrapeRunSummaryModel implements ScrapeRunSummary {
  @Field(() => ID, { description: 'Identifier of the most recently completed Scrape_Run.' })
  id: string;

  @Field(() => Date, { description: 'When that Scrape_Run started (11.1, 11.5).' })
  startedAt: Date;

  @Field(() => Date, {
    description:
      'When that Scrape_Run ended. The latest end time among the completed Scrape_Run is what makes this the reference run of the "neu" marking (11.2).',
  })
  finishedAt: Date;

  @Field(() => RunOutcomeEnumRef, {
    description:
      'How that Scrape_Run ended. Always "completed": a Scrape_Run with any other Run_Outcome is never the reference run (11.7).',
  })
  runOutcome: RunOutcome;

  @Field(() => Int, {
    description:
      'Job_Posting recorded for the first time in that Scrape_Run. These are exactly the ones marked "neu" (11.2, 11.5).',
  })
  newPostings: number;

  @Field(() => Int, {
    description:
      'Job_Posting that were already stored and were sighted again in that Scrape_Run (11.5).',
  })
  resightedPostings: number;

  @Field(() => Int, {
    description:
      'Job_Posting the Job_Tool holds in total, across every Scrape_Run and every Platform (11.5).',
  })
  totalPostings: number;
}
