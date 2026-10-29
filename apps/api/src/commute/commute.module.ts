import { Module, type Provider } from '@nestjs/common';

import { ENV_CONFIG } from '../config/env.config';
import type { EnvConfig } from '../config/env.schema';
import { isFixtureMode } from '../config/fixture-mode';
import { LogStreamModule } from '../log-stream/log-stream.module';
import { PostingModule } from '../posting/posting.module';
import { ANTHROPIC_FETCH, type AnthropicFetch } from '../relevance/anthropic-relevance.assessor';
import { relevanceDisabledReasonOf } from '../relevance/relevance.service';
import { AnthropicLocationNormalizer } from './anthropic-location.normalizer';
import { CommuteService } from './commute.service';
import { CommuteEnrichmentService } from './commute-enrichment.service';
import { FixtureLocationNormalizer } from './fixture-location.normalizer';
import { FixtureRoutingProvider } from './fixture-routing.provider';
import { HEIGIT_FETCH, type HeigitFetch, HeigitRoutingProvider } from './heigit-routing.provider';
import { LOCATION_NORMALIZER, type LocationNormalizer } from './location-normalizer.port';
import { ROUTING_PROVIDER, type RoutingProvider } from './routing-provider.port';

/**
 * Binds the {@link ROUTING_PROVIDER} to HeiGIT, or to the fixture double (task 21.1).
 *
 * The one place `SCRAPER_FIXTURE_MODE` takes effect for the Commute_Service. A factory and not a
 * `useClass`, for the same reason the retrieval runtime and the `RELEVANCE_ASSESSOR` are factories:
 * the decision is a configuration value and both branches are real implementations. Each class
 * additionally refuses to be constructed in the other mode, so the binding is not merely the
 * configured choice but the only reachable one — in fixture mode no object that could reach HeiGIT
 * exists in the process, and outside it no object that would answer a Commute_Time from a hash.
 *
 * `HEIGIT_FETCH` stays optional and is forwarded, so the HTTP seam of the provider survives the
 * factory: an integration test can bind it without reaching past this module, exactly as
 * `relevanceAssessorProvider` forwards `ANTHROPIC_FETCH`.
 */
export const routingProviderProvider: Provider = {
  provide: ROUTING_PROVIDER,
  inject: [ENV_CONFIG, { token: HEIGIT_FETCH, optional: true }],
  useFactory: (env: EnvConfig, http?: HeigitFetch): RoutingProvider =>
    isFixtureMode(env) ? new FixtureRoutingProvider(env) : new HeigitRoutingProvider(env, http),
};

/**
 * Binds the {@link LOCATION_NORMALIZER}, or binds no normalizer at all (8.5, 8.6, 8.7).
 *
 * Three branches, checked in the same order and driven by the same switch as
 * `relevanceAssessorProvider` — `RELEVANCE_ENABLED` first, then `SCRAPER_FIXTURE_MODE`:
 *
 * 1. {@link relevanceDisabledReasonOf} reports a reason → **no normalizer** (`undefined`).
 * 2. {@link isFixtureMode} → {@link FixtureLocationNormalizer}, the E2E double.
 * 3. Otherwise → {@link AnthropicLocationNormalizer}.
 *
 * ## Why the deactivated case is an absent value and not a no-op
 *
 * This is the one place the normalization port differs from its sibling `RELEVANCE_ASSESSOR`, and
 * the difference is visible to the user. 15.10 and 15.14 require a verdict to be written for every
 * Job_Posting even when nobody was asked, so "not assessed" is a *result* and the relevance port is
 * always bound to something — a `NoopRelevanceAssessor` if need be. 8.5 states the opposite for this
 * port: with the Relevance_Service deactivated, a free-text work location no rule resolves costs no
 * request, stays "unknown", and **nothing is recorded**, so the value still gets its single chance
 * (8.7) once the service is activated.
 *
 * A bound no-op could not express that. Its only honest answers would be `FAILED`, which the
 * enrichment stage maps to `commute.providerFailed` — a German sentence blaming a provider that was
 * never asked — or `UNRESOLVABLE`, which `CommuteService` records as a permanent dead end and would
 * spend a chance 8.7 gives once. The absent value instead takes `CommuteService.normalizeOnce`
 * straight to `LOCATION_UNRECOGNIZED`, which is `commute.geocodeFailed` and the wording of 8.5.
 *
 * The factory therefore answers `undefined` rather than being left out of the providers array: the
 * `@Module` decorator is evaluated at import time, before any configuration value exists, so "which
 * branch" cannot be decided there. The `@Optional()` injection in `CommuteService` is what reads the
 * result, and it sees exactly what an unbound token would give it — which is why that `@Optional()`
 * stays and why the port's own documentation of the deactivated case holds unchanged.
 *
 * `ANTHROPIC_FETCH` is the relevance assessor's token, reused rather than duplicated: 15.17 permits
 * the AI_Provider for the relevance assessment and for this normalization, so there is one AI_Provider
 * HTTP seam and a test that binds it covers both uses.
 */
export const locationNormalizerProvider: Provider = {
  provide: LOCATION_NORMALIZER,
  inject: [ENV_CONFIG, { token: ANTHROPIC_FETCH, optional: true }],
  useFactory: (env: EnvConfig, http?: AnthropicFetch): LocationNormalizer | undefined => {
    if (relevanceDisabledReasonOf(env) !== null) {
      return undefined;
    }

    return isFixtureMode(env)
      ? new FixtureLocationNormalizer(env)
      : new AnthropicLocationNormalizer(env, http);
  },
};

/**
 * The Commute_Service with its Routing_Provider (8.1 to 8.9, 8.12, 8.13).
 *
 * Two providers and two port bindings. `CommuteService` owns the attempt chain and its caches,
 * `CommuteEnrichmentService` persists what it answers and writes the German Log_Stream lines,
 * {@link ROUTING_PROVIDER} is bound to the implementation the design selects and
 * {@link LOCATION_NORMALIZER} to the one `RELEVANCE_ENABLED` selects. Both services are
 * exported because the end of a Scrape_Run drives the stage (`ScrapeRunModule`) and the later read
 * layer reads the stored result through the posting repository, not through this module.
 *
 * ## What the Routing_Provider binding does and does not decide
 *
 * `ROUTING_PROVIDER=heigit | google` is a permitted configuration pair, and only the HeiGIT
 * implementation exists; the Google one is the escape hatch the port is there for (risk 5 and 15 of
 * the design). {@link routingProviderProvider} therefore does *not* branch on that value: a factory
 * over it would have to answer for a provider that is not implemented, and the honest answer —
 * "configured provider unavailable" — is a startup error the configuration check owns. When the
 * second implementation arrives it is added to that factory and nothing else changes, because the
 * Commute_Service never names an implementation.
 *
 * What the factory does branch on is `SCRAPER_FIXTURE_MODE`, and that is a different kind of
 * decision: both branches exist, both are correct, and the two classes refuse to be constructed in
 * the wrong mode.
 *
 * ## What the Location_Normalizer binding decides
 *
 * 8.5 and 8.6 split on the Relevance_Service: with it deactivated, a free-text work location that
 * no rule resolves costs no AI_Provider request and the Best_Commute_Time stays "unknown".
 * {@link locationNormalizerProvider} is where that split takes effect, and its own documentation
 * carries the reason the deactivated branch is an absent value rather than a no-op.
 *
 * `PostingModule` is imported for the single write path into the Posting_Store (9.3) and
 * `LogStreamModule` for the German lines of the error table. Neither `PrismaModule` nor
 * `ConfigModule` is imported: both are global, and their dependencies are taken through the
 * `PrismaService` class token and the `ENV_CONFIG` token.
 */
@Module({
  imports: [LogStreamModule, PostingModule],
  providers: [
    CommuteService,
    CommuteEnrichmentService,
    routingProviderProvider,
    locationNormalizerProvider,
  ],
  exports: [CommuteService, CommuteEnrichmentService, LOCATION_NORMALIZER],
})
export class CommuteModule {}
