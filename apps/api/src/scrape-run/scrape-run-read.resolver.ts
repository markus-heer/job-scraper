import { Inject } from '@nestjs/common';
import { Args, Context, ID, Int, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';

import {
  isResultIncomplete,
  RESULT_INCOMPLETE_HINT_DE,
  RUN_OUTCOME_LABELS_DE,
} from '../common/error-mapping';
import type { RequestKey } from '../graphql/request-cache';
import type { ScrapeRun, ScrapeRunPlatformResult } from '../prisma/prisma.types';
import { ScrapeRunModel } from './models/scrape-run.model';
import { ScrapeRunPlatformResultModel } from './models/scrape-run-platform-result.model';
import { ScrapeRunSummaryModel } from './models/scrape-run-summary.model';
import { ScrapeRunReadContextFactory } from './scrape-run-read.context';
import {
  SCRAPE_RUN_LIST_DEFAULT_LIMIT,
  type ScrapeRunReadQueries,
  ScrapeRunReadService,
  type ScrapeRunSummary,
} from './scrape-run-read.service';

/**
 * The four Scrape_Run queries of the Web_App and the resolved fields of a stored run (7.4, 11.5,
 * 11.6, 12.9, 12.10).
 *
 * Thin by construction, like the two run mutations next to it: every method forwards to
 * `ScrapeRunReadService` and returns what it yields. The selection rule of the reference run, the
 * counters of 11.5 and the list size cap all live behind that service, because they are statements
 * about stored rows and not about a GraphQL request.
 *
 * The four queries answer four different questions and are deliberately not one:
 *
 * - **`latestScrapeRun`** is the most recently *completed* Scrape_Run with the counters of 11.5, and
 *   it is nullable because 11.6 asks for a German hint in place of those values while no Scrape_Run
 *   has reached the Run_Outcome "completed". That nullability is the whole API_Service side of 11.6:
 *   the hint is a sentence the Web_App owns, and there is nothing to report here but the absence.
 * - **`activeScrapeRun`** is the Scrape_Run that is running right now, or null. It is what the
 *   Web_App needs to decide whether to offer "Suchlauf starten" or the running run's Log_View
 *   (12.1, 12.5).
 * - **`scrapeRuns`** is the recent runs, newest first, whatever their outcome: the way back into the
 *   Log_Stream of an earlier run (12.9).
 * - **`scrapeRun`** is one *named* run, which is what the Log_View of 12.2 is addressed by and what
 *   the end-of-run summary of 12.10 is read from. Neither of the two queries above can serve it:
 *   `activeScrapeRun` answers `null` the moment the run ends, which is the moment 12.10 asks for the
 *   summary, and `scrapeRuns` would leave a run older than the list length without one.
 *
 * ## The three resolved fields, and why they are German text
 *
 * `platformResults` is an edge rather than a column and is loaded per request through DataLoader, so
 * a run list of 20 entries costs one query for it instead of 20.
 *
 * The other two are German sentences about this run, and they are here for the reason
 * `apps/web/src/i18n/de.ts` states: the API_Service owns every German text that states a stored
 * value or explains a failure, and the closed vocabularies of the glossary are translated in
 * `../common/error-mapping.ts` only. `runOutcomeLabelDe` is the same arrangement as on
 * `ScrapeRunSummary` — the enum stays published next to the label, so a reader that branches on the
 * Run_Outcome still can — and `resultIncompleteHintDe` is the hint 7.4 asks the summary to carry
 * where at least one Platform ended with something other than "completed". Both are nullable, and
 * the absence is the information: no outcome means the run is still going, and no hint means the
 * result list is complete.
 *
 * Requirements: 7.4, 11.5, 11.6, 12.1, 12.2, 12.5, 12.9, 12.10.
 */
@Resolver(() => ScrapeRunModel)
export class ScrapeRunReadResolver {
  /**
   * Both dependencies are injected by their class token explicitly, as everywhere else in this
   * application: naming the token keeps the import a value import and the dependency visible,
   * instead of making the wiring depend on emitted decorator metadata that a type-only import would
   * drop.
   */
  constructor(
    @Inject(ScrapeRunReadService) private readonly runs: ScrapeRunReadQueries,
    @Inject(ScrapeRunReadContextFactory) private readonly contexts: ScrapeRunReadContextFactory,
  ) {}

  /** The recent Scrape_Run, newest first (12.9). */
  @Query(() => [ScrapeRunModel], {
    name: 'scrapeRuns',
    description:
      'The most recent Scrape_Run, newest first, whatever their Run_Outcome. The way back into the status messages of an earlier Scrape_Run.',
  })
  scrapeRuns(
    @Args('limit', {
      type: () => Int,
      nullable: true,
      defaultValue: SCRAPE_RUN_LIST_DEFAULT_LIMIT,
      description: 'Maximum number of Scrape_Run to return. Values above 100 are capped.',
    })
    limit?: number | null,
  ): Promise<readonly ScrapeRun[]> {
    return this.runs.recentRuns(limit);
  }

  /** The Scrape_Run that is currently running, or null (12.1, 12.5). */
  @Query(() => ScrapeRunModel, {
    name: 'activeScrapeRun',
    nullable: true,
    description:
      'The Scrape_Run that is currently running, or null while none is running. At most one Scrape_Run runs at a time.',
  })
  activeScrapeRun(): Promise<ScrapeRun | null> {
    return this.runs.activeRun();
  }

  /** One named Scrape_Run, the run a Log_View is opened on (12.2, 12.10). */
  @Query(() => ScrapeRunModel, {
    name: 'scrapeRun',
    nullable: true,
    description:
      'One stored Scrape_Run by its identifier, whatever its Run_Outcome, or null where no Scrape_Run carries that identifier. What the Log_View is opened on and what its end-of-run summary is read from.',
  })
  scrapeRun(
    @Args('id', { type: () => ID, description: 'Identifier of the Scrape_Run.' }) id: string,
  ): Promise<ScrapeRun | null> {
    return this.runs.runById(id);
  }

  /** The most recently completed Scrape_Run with the counters of the overview (11.5, 11.6). */
  @Query(() => ScrapeRunSummaryModel, {
    name: 'latestScrapeRun',
    nullable: true,
    description:
      'The most recently completed Scrape_Run with its start time, end time, Run_Outcome and the counts of first-recorded, re-sighted and stored Job_Posting. Null while no Scrape_Run has reached the Run_Outcome "completed".',
  })
  latestScrapeRun(): Promise<ScrapeRunSummary | null> {
    return this.runs.latestScrapeRunSummary();
  }

  /** What each requested Platform produced in this Scrape_Run (7.4). */
  @ResolveField(() => [ScrapeRunPlatformResultModel], {
    name: 'platformResults',
    description:
      'One entry per Platform this Scrape_Run requested, with the Platform_Status it ended with. Empty for a Scrape_Run that ended before its first Platform was requested.',
  })
  platformResults(
    @Parent() run: ScrapeRun,
    @Context() context: RequestKey,
  ): Promise<readonly ScrapeRunPlatformResult[]> {
    return this.contexts.for(context).platformResults(run.id);
  }

  /**
   * How this Scrape_Run ended, as the German text a summary prints (12.10).
   *
   * Null while the run is still going, which is exactly when `runOutcome` is null: a running
   * Scrape_Run has no outcome to label, and inventing one ("läuft noch") would put a fourth value
   * into a vocabulary the glossary closes at three.
   */
  @ResolveField(() => String, {
    name: 'runOutcomeLabelDe',
    nullable: true,
    description:
      'How the Scrape_Run ended as German text, or null while it is still running. For a reader that prints the Run_Outcome rather than branching on it.',
  })
  runOutcomeLabelDe(@Parent() run: ScrapeRun): string | null {
    return run.runOutcome === null ? null : RUN_OUTCOME_LABELS_DE[run.runOutcome];
  }

  /**
   * The hint of 7.4 that the result list of this Scrape_Run is incomplete, or null where it is not.
   *
   * "Incomplete" is one Platform_Status other than "completed" among the Platform this run
   * requested, which is read through the same per-request loader the `platformResults` edge uses —
   * so a client that selects both fields pays for one query, not two.
   *
   * Null rather than an empty string for the complete case: a sentence that is sometimes blank
   * would have to be tested for blankness by the Web_App, while a nullable field says in the schema
   * that there may be nothing to show.
   */
  @ResolveField(() => String, {
    name: 'resultIncompleteHintDe',
    nullable: true,
    description:
      'German hint that the result list of this Scrape_Run is incomplete, present exactly where at least one requested Platform ended with a Platform_Status other than "completed" (7.4). Null where every requested Platform was queried completely.',
  })
  async resultIncompleteHintDe(
    @Parent() run: ScrapeRun,
    @Context() context: RequestKey,
  ): Promise<string | null> {
    const results = await this.contexts.for(context).platformResults(run.id);

    return isResultIncomplete(results.map((result) => result.platformStatus))
      ? RESULT_INCOMPLETE_HINT_DE
      : null;
  }
}
