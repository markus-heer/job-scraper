/**
 * How the read layer of the posting overview reaches its dependencies (10.1, 11.2).
 *
 * Nest's real dependency injection is used — `PostingReadModule` is booted as an application context
 * — with the pieces of infrastructure the application declares global replaced by stand-ins, so no
 * database, no environment file and no network are involved.
 *
 * What that proves is the part a compiler cannot, and it is the reason this module exists at all:
 * the read layer imports `PostingModule` *and* `ScrapeRunModule`, and `ScrapeRunModule` reaches
 * `PostingModule` again through `RelevanceModule` and `ScraperModule`. Had the two reads been put
 * into `PostingModule` itself, that chain would be a module cycle and this boot would fail with
 * Nest's undefined-dependency error instead of resolving. The container starting is the assertion.
 *
 * Requirements: 10.1, 11.2.
 */

import { Global, type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';

import { AppConfigService } from '../../config/config.service';
import { ENV_CONFIG } from '../../config/env.config';
import type { EnvConfig } from '../../config/env.schema';
import { DOMAIN_PLATFORM_CONFIGURATION_INPUTS } from '../../platform-config/platform-config.module';
import {
  PLATFORM_CONFIGURATION_INPUTS,
  PlatformConfigurationService,
} from '../../platform-config/platform-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PostingReadContextFactory } from '../posting-read.context';
import { PostingReadModule } from '../posting-read.module';
import { PostingReadResolver } from '../posting-read.resolver';
import { PostingReadService } from '../posting-read.service';

/** The configuration as this graph reads it; the Relevance_Service stays deactivated. */
const env = {
  homeAddress: 'Hörkherstraße 1d, 80689 München',
  commuteThresholdMinutes: 60,
  databaseUrl: 'postgresql://localhost:5432/job_tool',
  routingApiKey: 'routing-key',
  anthropicApiKey: 'anthropic-key',
  relevanceEnabled: false,
  relevanceConcurrency: 4,
  relevanceMaxPerRun: 200,
  enrichmentGraceMinutes: 10,
} as unknown as EnvConfig;

/**
 * Stand-ins for the global providers of the application.
 *
 * `@Global` here for the same reason `ConfigModule`, `PrismaModule` and `PlatformConfigModule` are:
 * none of the modules under test imports them, and taking the dependency through the class token is
 * what the wiring relies on. The `ScrapeRun` delegate answers the stale-run recovery that runs on
 * bootstrap with "nothing to close".
 */
@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      useValue: { scrapeRun: { findMany: () => Promise.resolve([]) } },
    },
    { provide: ENV_CONFIG, useValue: env },
    {
      provide: AppConfigService,
      useValue: { homeAddress: env.homeAddress, commuteThresholdMinutes: 60 },
    },
    { provide: PLATFORM_CONFIGURATION_INPUTS, useValue: DOMAIN_PLATFORM_CONFIGURATION_INPUTS },
    PlatformConfigurationService,
  ],
  exports: [PrismaService, ENV_CONFIG, AppConfigService, PlatformConfigurationService],
})
class StubInfrastructureModule {}

@Module({ imports: [StubInfrastructureModule, PostingReadModule] })
class RootModule {}

let context: INestApplicationContext | undefined;

afterEach(async () => {
  await context?.close();
  context = undefined;
});

describe('PostingReadModule', () => {
  it('resolves the read service, the request context and the resolver', async () => {
    context = await NestFactory.createApplicationContext(RootModule, { logger: false });

    expect(context.get(PostingReadService)).toBeInstanceOf(PostingReadService);
    expect(context.get(PostingReadContextFactory)).toBeInstanceOf(PostingReadContextFactory);
    expect(context.get(PostingReadResolver)).toBeInstanceOf(PostingReadResolver);
  });

  it('gives every field of one request the same context object', async () => {
    context = await NestFactory.createApplicationContext(RootModule, { logger: false });

    const factory = context.get(PostingReadContextFactory);
    const request = {};

    // The identity is what makes the reference run of 11.2 one selection per request and the
    // `firstSeenRun` edge one query per page.
    expect(factory.for(request)).toBe(factory.for(request));
    expect(factory.for(request)).not.toBe(factory.for({}));
  });
});
