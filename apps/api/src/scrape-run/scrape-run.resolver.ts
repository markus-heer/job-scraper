import { Inject } from '@nestjs/common';
import { Args, ID, Mutation, Resolver } from '@nestjs/graphql';

import { CancelScrapeRunPayloadModel } from './models/cancel-scrape-run-payload.model';
import { StartScrapeRunPayloadModel } from './models/start-scrape-run-payload.model';
import { type RunMutations, ScrapeRunService } from './scrape-run.service';

/**
 * The two run mutations of the Web_App (12.1, 12.5, 12.7, 12.13, 12.14).
 *
 * Thin by construction: both methods forward to `ScrapeRunService` and return what it yields. The
 * single-run guarantee, the abort channel, the German hints and the end-of-run summary all live
 * behind that service, because they are decisions about a Scrape_Run and not about a GraphQL
 * request.
 *
 * Neither mutation throws for a case the user can act on. Both answer with a payload carrying a
 * German hint instead, which is what lets the Web_App show one cause and one recommended next step
 * without inspecting `extensions` (2.5) — the design states this explicitly for exactly these two
 * operations.
 *
 * Requirements: 12.1, 12.5, 12.7, 12.13, 12.14.
 */
@Resolver()
export class ScrapeRunResolver {
  /**
   * The service is injected by its class token explicitly, as everywhere else in this application:
   * naming the token keeps the import a value import and the dependency visible, instead of making
   * the wiring depend on emitted decorator metadata that a type-only import would drop.
   */
  constructor(@Inject(ScrapeRunService) private readonly runs: RunMutations) {}

  /** Starts a Scrape_Run, or reports the running one (12.1, 12.5, 12.13). */
  @Mutation(() => StartScrapeRunPayloadModel, {
    name: 'startScrapeRun',
    description:
      'Starts a Scrape_Run and answers with its identifier. While a Scrape_Run is running, no second one is created and the running identifier is returned together with a German hint.',
  })
  startScrapeRun(): Promise<StartScrapeRunPayloadModel> {
    return this.runs.start();
  }

  /** Cancels a running Scrape_Run, or rejects the cancellation (12.7, 12.14). */
  @Mutation(() => CancelScrapeRunPayloadModel, {
    name: 'cancelScrapeRun',
    description:
      'Cancels a running Scrape_Run. For a Scrape_Run that is not running the cancellation is rejected and the stored Run_Outcome is returned with a German reason.',
  })
  cancelScrapeRun(
    @Args('runId', { type: () => ID, description: 'Identifier of the Scrape_Run to cancel.' })
    runId: string,
  ): Promise<CancelScrapeRunPayloadModel> {
    return this.runs.cancel(runId);
  }
}
