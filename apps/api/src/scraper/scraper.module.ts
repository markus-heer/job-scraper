import { ADAPTERS } from '@job-scraper/scrapers';
import { Module, type Provider } from '@nestjs/common';

import { ENV_CONFIG } from '../config/env.config';
import type { EnvConfig } from '../config/env.schema';
import { isFixtureMode } from '../config/fixture-mode';
import { LogStreamModule } from '../log-stream/log-stream.module';
import { PostingModule } from '../posting/posting.module';
import { FixtureRetrievalRuntime } from './fixture-retrieval.runtime';
import { createPlaywrightRetrievalRuntime } from './playwright-retrieval.runtime';
import { RETRIEVAL_RUNTIME, type RetrievalRuntime } from './retrieval.port';
import { ADAPTER_REGISTRY, ScraperService } from './scraper.service';

/**
 * Binds the {@link RETRIEVAL_RUNTIME} to the browser, or to the frozen Platform fixtures.
 *
 * The one place `SCRAPER_FIXTURE_MODE` takes effect for the retrieval, and the reason the E2E suite
 * of task 21.1 can drive a complete Scrape_Run without a single Platform request: in fixture mode the
 * adapters read the stored documents of `packages/scrapers/src/adapters/<platform>/__fixtures__/`
 * over a local HTTP server, through the same `AdapterPage` port the Playwright runtime implements.
 *
 * A factory rather than a `useClass`, because the decision is a configuration value and both branches
 * are real implementations — the same shape as the `RELEVANCE_ASSESSOR` binding of `RelevanceModule`.
 * The production branch goes through `createPlaywrightRetrievalRuntime`, which refuses to hand out
 * the browser runtime while the switch is on: binding the fixture runtime is then not merely the
 * configured choice but the only reachable one, so a later edit here cannot quietly put a real
 * retrieval back into an E2E run.
 *
 * Which Platform the fixture runtime serves and which fixture answers which Result_Page is decided by
 * the registry and by the stored cases, not here; see `./fixture-retrieval.runtime.ts`.
 */
export const retrievalRuntimeProvider: Provider = {
  provide: RETRIEVAL_RUNTIME,
  inject: [ENV_CONFIG],
  useFactory: (env: EnvConfig): RetrievalRuntime =>
    isFixtureMode(env) ? new FixtureRetrievalRuntime() : createPlaywrightRetrievalRuntime(env),
};

/**
 * The retrieval phase of a Scrape_Run (12.3).
 *
 * Only the service for now. It is exported because the run mutations of task 12.4 call it: the
 * coordinator creates the Scrape_Run and hands its abort signal and its deadline over, and this
 * service is what then runs the Platform_Adapter.
 *
 * Two dependencies arrive through tokens rather than through an import, and both for the same
 * reason — they are the only parts of the retrieval that are neither pure nor local:
 *
 * - `ADAPTER_REGISTRY` carries the Platform_Adapter registry of `@job-scraper/scrapers`. The
 *   service never names a Platform or an adapter class, which is what 6.6 asks for: a further
 *   Platform_Adapter takes effect by being registered there, and the source of this service stays
 *   untouched. A test registers its own adapters through the same token.
 * - `RETRIEVAL_RUNTIME` carries the browser and the robots.txt cache. In production that is
 *   Playwright plus `fetch`, in fixture mode the frozen fixtures (see
 *   {@link retrievalRuntimeProvider}), and in a unit test an in-memory double, so the orchestration
 *   can be driven without a browser binary and without a network.
 *
 * `PostingModule` is imported for the single write path into the Posting_Store (9.2, 9.3) and
 * `LogStreamModule` for the per-Platform status messages of 12.3. Neither `PrismaModule` nor
 * `ConfigModule` nor `PlatformConfigModule` is imported: all three are global, and their
 * dependencies are taken through the `PrismaService` class token, the `ENV_CONFIG` token and the
 * `PlatformConfigurationService` class token.
 */
@Module({
  imports: [LogStreamModule, PostingModule],
  providers: [
    { provide: ADAPTER_REGISTRY, useValue: ADAPTERS },
    retrievalRuntimeProvider,
    ScraperService,
  ],
  exports: [ScraperService],
})
export class ScraperModule {}
