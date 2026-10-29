import { Module, type Provider } from '@nestjs/common';

import { ENV_CONFIG } from '../config/env.config';
import type { EnvConfig } from '../config/env.schema';
import { isFixtureMode } from '../config/fixture-mode';
import { LogStreamModule } from '../log-stream/log-stream.module';
import { PostingModule } from '../posting/posting.module';
import {
  ANTHROPIC_FETCH,
  type AnthropicFetch,
  AnthropicRelevanceAssessor,
} from './anthropic-relevance.assessor';
import { FixtureRelevanceAssessor } from './fixture-relevance.assessor';
import { NoopRelevanceAssessor } from './noop-relevance.assessor';
import { relevanceDisabledReasonOf, RelevanceService } from './relevance.service';
import { RELEVANCE_ASSESSOR, type RelevanceAssessor } from './relevance-assessor.port';
import { RelevanceEnrichmentService } from './relevance-enrichment.service';

/**
 * Binds the {@link RELEVANCE_ASSESSOR} to the AI_Provider, or to the no-op (15.9, 15.10).
 *
 * The one place the deactivation switch of 15.9 takes effect. A factory rather than a `useClass`,
 * because the decision is a configuration value — unlike `ROUTING_PROVIDER`, where the
 * configuration selects between two implementations and an unimplemented one is a startup error.
 * Here both branches exist and both are correct: an activated service asks Anthropic, a deactivated
 * one asks nobody.
 *
 * Binding the no-op is what makes "no API key means no request" a property of the object graph
 * rather than of a check inside a request path: with the switch off, no `AnthropicRelevanceAssessor`
 * is constructed at all, so there is no code in the process that could send a request and no
 * credential read into one (14.9).
 *
 * `ANTHROPIC_FETCH` stays optional and is forwarded, so the HTTP seam of the assessor survives the
 * factory: an integration test can bind it without reaching past this module.
 *
 * ## The third branch: fixture mode (task 21.1)
 *
 * `SCRAPER_FIXTURE_MODE` selects {@link FixtureRelevanceAssessor}, which answers a deterministic
 * verdict without a request, so an E2E spec can assert the Relevance_Verdict of a freshly scraped
 * Job_Posting. The deactivation switch is checked *first* and keeps its meaning: a fixture-mode run
 * with `RELEVANCE_ENABLED=false` binds the no-op, because 15.9 is about the user's decision not to
 * have postings assessed and fixture mode does not overrule it. `AnthropicRelevanceAssessor` refuses
 * to be constructed in fixture mode, so the Anthropic branch is not merely unselected but
 * unreachable.
 */
export const relevanceAssessorProvider: Provider = {
  provide: RELEVANCE_ASSESSOR,
  inject: [ENV_CONFIG, { token: ANTHROPIC_FETCH, optional: true }],
  useFactory: (env: EnvConfig, http?: AnthropicFetch): RelevanceAssessor => {
    if (relevanceDisabledReasonOf(env) !== null) {
      return new NoopRelevanceAssessor();
    }

    return isFixtureMode(env)
      ? new FixtureRelevanceAssessor(env)
      : new AnthropicRelevanceAssessor(env, http);
  },
};

/**
 * The Relevance_Service with its AI_Provider and the enrichment stage that drives it (15.1 to
 * 15.13).
 *
 * `RelevanceService` owns the retry chain, the run budget, the concurrency bound and the
 * `NOT_ASSESSED` fallback; the bound assessor owns the single request behind them;
 * `RelevanceEnrichmentService` owns the content hash gate, the Posting_Store write and the two
 * per-Job_Posting Log_Stream lines. Both services are exported: the end of a Scrape_Run drives the
 * stage (`ScrapeRunModule`) and the landing page reads the service's activation state (14.8).
 *
 * `PostingModule` is imported for the single write path into the Posting_Store (9.3) and
 * `LogStreamModule` for the German lines of the error table — the same two the commute stage needs,
 * for the same reasons. `ConfigModule`, `PrismaModule` and `PlatformConfigModule` are not imported:
 * all three are global, and their dependencies are taken through the `ENV_CONFIG` token and the
 * `PrismaService` and `PlatformConfigurationService` class tokens.
 */
@Module({
  imports: [LogStreamModule, PostingModule],
  providers: [RelevanceService, RelevanceEnrichmentService, relevanceAssessorProvider],
  exports: [RelevanceService, RelevanceEnrichmentService, RELEVANCE_ASSESSOR],
})
export class RelevanceModule {}
