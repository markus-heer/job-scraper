import { Module } from '@nestjs/common';

import { CommuteModule } from '../commute/commute.module';
import { LogStreamModule } from '../log-stream/log-stream.module';
import { RelevanceModule } from '../relevance/relevance.module';
import { ScraperModule } from '../scraper/scraper.module';
import { ScrapeRunCoordinator } from './scrape-run.coordinator';
import { ScrapeRunResolver } from './scrape-run.resolver';
import { ScrapeRunService } from './scrape-run.service';
import { ScrapeRunPlatformResultResolver } from './scrape-run-platform-result.resolver';
import { ScrapeRunReadContextFactory } from './scrape-run-read.context';
import { ScrapeRunReadResolver } from './scrape-run-read.resolver';
import { ScrapeRunReadService } from './scrape-run-read.service';
import { ScrapeRunSummaryResolver } from './scrape-run-summary.resolver';

/**
 * The lifecycle of a Scrape_Run and the two mutations that drive it (12.1, 12.5, 12.7, 12.10,
 * 12.13, 12.14).
 *
 * Three providers, in the order they depend on each other: the coordinator owns the single running
 * Scrape_Run, its abort channel and its deadlines; `ScrapeRunService` joins it with the retrieval
 * phase, writes the end-of-run summary and the per-Platform results, and answers the two mutations
 * with a German hint instead of a GraphQL error; the resolver only publishes them.
 *
 * The coordinator is exported because everything that runs inside a Scrape_Run reads its abort
 * signal and its deadlines from here, and all of them need the *same* instance: the single-run
 * guarantee of 12.1 is a field on that one object, so a second instance would be a second
 * permission to start a run. `ScrapeRunService` is exported with it, because the enrichment stages
 * of the later tasks join the end of a run through it.
 *
 * `ScraperModule` is imported for the retrieval phase of 12.3, `CommuteModule` and
 * `RelevanceModule` for the two enrichment stages that run between the per-Platform results and the
 * summary (8.1, 15.13), and `LogStreamModule` for the German lifecycle lines and the summary of
 * 12.3 and 12.10. The dependency runs one way only —
 * neither the Scraper_Service nor the enrichment stage reaches back into this module; both are
 * handed the run's identifier, its start time, its deadline and its abort signal as plain values —
 * so there is no circular import and no `forwardRef`.
 * Neither `PrismaModule` nor `ConfigModule` is imported: both are global, and their
 * dependencies are taken through the `PrismaService` class token and the `ENV_CONFIG` token.
 *
 * The coordinator carries the stale-run recovery of 12.2 with it: it is a Nest lifecycle hook on
 * that provider, so importing this module in `AppModule` is all the wiring the recovery needs.
 *
 * `ScrapeRunReadService` is the read side of the same subject and is exported for a reader outside
 * this module: the posting overview compares every Job_Posting against the most recently completed
 * Scrape_Run to derive the marking "neu" of 11.2, and that identifier is one query against the
 * `ScrapeRun` table — which belongs here and not in a posting repository. It depends on nothing in
 * this module, because the selection rule is a statement about stored rows and not about the run
 * this process happens to be executing.
 *
 * `ScrapeRunReadResolver` publishes that read side — the run list of 12.9, the running Scrape_Run of
 * 12.5 and the `latestScrapeRun` of 11.5 and 11.6 — together with the `platformResults` edge of 7.4,
 * which `ScrapeRunReadContextFactory` loads once per request. Neither is exported: a resolver is a
 * leaf of the object graph, and the loader exists for this one request path.
 *
 * `ScrapeRunSummaryResolver` and `ScrapeRunPlatformResultResolver` are two further resolvers for the
 * same read path, each carrying one German label of a closed vocabulary: the Run_Outcome of the
 * posting overview's summary (11.5) and the Platform_Status of a per-Platform result row (7.4,
 * 12.10). They are separate classes only because `@ResolveField` is bound to the object type its
 * class names, and that class names `ScrapeRunModel`.
 */
@Module({
  imports: [CommuteModule, LogStreamModule, RelevanceModule, ScraperModule],
  providers: [
    ScrapeRunCoordinator,
    ScrapeRunReadService,
    ScrapeRunReadContextFactory,
    ScrapeRunService,
    ScrapeRunResolver,
    ScrapeRunReadResolver,
    ScrapeRunSummaryResolver,
    ScrapeRunPlatformResultResolver,
  ],
  exports: [ScrapeRunCoordinator, ScrapeRunReadService, ScrapeRunService],
})
export class ScrapeRunModule {}
