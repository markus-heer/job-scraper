/**
 * How the Commute_Service and its enrichment stage reach their dependencies (8.1, 8.5, 8.6).
 *
 * Nest's real dependency injection is used — `CommuteModule` is booted as an application context —
 * with the three pieces of infrastructure the application declares global replaced by stand-ins, so
 * no database, no environment file and no network are involved. What that proves is the part a
 * compiler cannot: the {@link ROUTING_PROVIDER} token is bound, both services resolve, and
 * {@link LOCATION_NORMALIZER} takes each of the three branches of `locationNormalizerProvider`
 * according to `RELEVANCE_ENABLED` and `SCRAPER_FIXTURE_MODE`.
 *
 * The deactivated branch is the one worth reading carefully: the token resolves to `undefined`
 * rather than throwing, which is what the `@Optional()` injection in `CommuteService` reads as "no
 * AI_Provider normalization available" and what puts the Job_Tool on the 8.5 path — no request,
 * Best_Commute_Time "unknown", nothing recorded.
 *
 * Requirements: 8.1, 8.5, 8.6.
 */

import { Global, type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';

import { AppConfigService } from '../../config/config.service';
import { ENV_CONFIG } from '../../config/env.config';
import type { EnvConfig } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { AnthropicLocationNormalizer } from '../anthropic-location.normalizer';
import { CommuteModule } from '../commute.module';
import { CommuteService } from '../commute.service';
import { CommuteEnrichmentService } from '../commute-enrichment.service';
import { FixtureLocationNormalizer } from '../fixture-location.normalizer';
import { FixtureRoutingProvider } from '../fixture-routing.provider';
import { HeigitRoutingProvider } from '../heigit-routing.provider';
import { LOCATION_NORMALIZER, type LocationNormalizer } from '../location-normalizer.port';
import { ROUTING_PROVIDER, type RoutingProvider } from '../routing-provider.port';

/** The configuration as this graph reads it: the Home_Address and the two provider credentials. */
const baseEnv = {
  homeAddress: 'Hörkherstraße 1d, 80689 München',
  routingApiKey: 'routing-key',
  databaseUrl: 'postgresql://localhost:5432/job_tool',
  anthropicApiKey: 'anthropic-key',
  anthropicModel: 'claude-sonnet-4-5',
  relevanceEnabled: true,
  scraperFixtureMode: false,
} as unknown as EnvConfig;

/** The same configuration with the named keys overridden, for one branch of the factory. */
const envWith = (overrides: Partial<EnvConfig>): EnvConfig =>
  ({ ...baseEnv, ...overrides }) as EnvConfig;

/**
 * Boots `CommuteModule` over a given configuration.
 *
 * `@Global` on the stand-in module for the same reason `ConfigModule` and `PrismaModule` are:
 * `CommuteModule` deliberately does not import them, and taking the dependency through the class
 * token is what the wiring under test relies on.
 */
const bootWith = async (env: EnvConfig): Promise<INestApplicationContext> => {
  @Global()
  @Module({
    providers: [
      { provide: PrismaService, useValue: {} },
      { provide: ENV_CONFIG, useValue: env },
      { provide: AppConfigService, useValue: { homeAddress: env.homeAddress } },
    ],
    exports: [PrismaService, ENV_CONFIG, AppConfigService],
  })
  class StubInfrastructureModule {}

  @Module({ imports: [StubInfrastructureModule, CommuteModule] })
  class RootModule {}

  return NestFactory.createApplicationContext(RootModule, { logger: false });
};

/** The bound normalizer, or `undefined` for the deactivated branch. */
const normalizerOf = (context: INestApplicationContext): LocationNormalizer | undefined =>
  context.get<LocationNormalizer | undefined>(LOCATION_NORMALIZER, { strict: false });

let context: INestApplicationContext | undefined;

afterEach(async () => {
  await context?.close();
  context = undefined;
});

describe('CommuteModule', () => {
  it('binds the Routing_Provider and resolves both services', async () => {
    context = await bootWith(baseEnv);

    const routing = context.get<RoutingProvider>(ROUTING_PROVIDER, { strict: false });

    expect(routing).toBeInstanceOf(HeigitRoutingProvider);
    expect(context.get(CommuteService, { strict: false })).toBeInstanceOf(CommuteService);
    expect(context.get(CommuteEnrichmentService, { strict: false })).toBeInstanceOf(
      CommuteEnrichmentService,
    );
  });

  it('binds the Anthropic Location_Normalizer with the Relevance_Service activated (8.6)', async () => {
    context = await bootWith(baseEnv);

    expect(normalizerOf(context)).toBeInstanceOf(AnthropicLocationNormalizer);
  });

  it('binds no Location_Normalizer with RELEVANCE_ENABLED off, which is the 8.5 branch', async () => {
    context = await bootWith(envWith({ relevanceEnabled: false }));

    // No AI_Provider normalization is available, so a free-text work location no rule resolves
    // stays "unknown" without a request and without a recorded `LocationNormalization` row — the
    // value keeps its single chance of 8.7 for the day the Relevance_Service is activated.
    expect(normalizerOf(context)).toBeUndefined();
  });

  it('binds no Location_Normalizer without an API key either (8.5)', async () => {
    context = await bootWith(envWith({ anthropicApiKey: '   ' }));

    expect(normalizerOf(context)).toBeUndefined();
  });

  it('binds the fixture Location_Normalizer in fixture mode, reaching no third party', async () => {
    context = await bootWith(
      envWith({
        scraperFixtureMode: true,
        databaseUrl: 'postgresql://localhost:5432/jobtool_test',
      }),
    );

    expect(normalizerOf(context)).toBeInstanceOf(FixtureLocationNormalizer);
    expect(context.get<RoutingProvider>(ROUTING_PROVIDER, { strict: false })).toBeInstanceOf(
      FixtureRoutingProvider,
    );
  });

  it('prefers the deactivated branch over fixture mode, as the relevance binding does', async () => {
    context = await bootWith(
      envWith({
        scraperFixtureMode: true,
        relevanceEnabled: false,
        databaseUrl: 'postgresql://localhost:5432/jobtool_test',
      }),
    );

    // 15.9 is about the user's decision not to have postings assessed, and fixture mode does not
    // overrule it. The same order as `relevanceAssessorProvider`, for the same reason.
    expect(normalizerOf(context)).toBeUndefined();
  });
});
