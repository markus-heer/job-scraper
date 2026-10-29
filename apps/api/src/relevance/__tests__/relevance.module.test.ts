/**
 * Where the deactivation switch of 15.9 takes effect: the object graph.
 *
 * `RelevanceModule` binds `RELEVANCE_ASSESSOR` through a factory over the configuration, and the
 * promise of 15.10 — no API key means no request — is only kept if an activated installation and a
 * deactivated one really receive different objects. Nest's real dependency injection is used, with
 * a stand-in global module in place of `ConfigModule` so that no environment file is read.
 *
 * What one assessor does with a request is asserted in `./anthropic-relevance.assessor.test.ts` and
 * `./noop-relevance.assessor.test.ts`; what the service decides around it in
 * `./relevance.service.test.ts`.
 *
 * Requirements: 15.9, 15.10.
 */

import { Global, type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';

import { ENV_CONFIG } from '../../config/env.config';
import type { EnvConfig } from '../../config/env.schema';
import { PlatformConfigurationService } from '../../platform-config/platform-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AnthropicRelevanceAssessor } from '../anthropic-relevance.assessor';
import { NoopRelevanceAssessor } from '../noop-relevance.assessor';
import { RelevanceModule } from '../relevance.module';
import { RelevanceService } from '../relevance.service';
import { RELEVANCE_ASSESSOR } from '../relevance-assessor.port';
import { RelevanceEnrichmentService } from '../relevance-enrichment.service';

/** The configuration as the factory reads it; no environment file is involved. */
const envWith = (overrides: Partial<EnvConfig>): EnvConfig =>
  ({
    relevanceEnabled: true,
    anthropicApiKey: 'sk-ant-test-key',
    anthropicModel: 'claude-sonnet-4-5',
    relevanceMaxPerRun: 200,
    relevanceConcurrency: 4,
    ...overrides,
  }) as unknown as EnvConfig;

let context: INestApplicationContext | undefined;

/**
 * Boots `RelevanceModule` over one configuration, with stand-ins for the global providers.
 *
 * `@Global` here for the same reason the application declares them global: the module deliberately
 * does not import `ConfigModule`, `PrismaModule` or `PlatformConfigModule`, and taking those
 * dependencies through their tokens is part of the wiring under test. No environment file, no
 * database and no network are involved.
 */
const bootWith = async (env: EnvConfig): Promise<INestApplicationContext> => {
  @Global()
  @Module({
    providers: [
      { provide: ENV_CONFIG, useValue: env },
      { provide: PrismaService, useValue: {} },
      { provide: PlatformConfigurationService, useValue: { effectiveProfileOf: () => null } },
    ],
    exports: [ENV_CONFIG, PrismaService, PlatformConfigurationService],
  })
  class StubInfrastructureModule {}

  @Module({ imports: [StubInfrastructureModule, RelevanceModule] })
  class RootModule {}

  context = await NestFactory.createApplicationContext(RootModule, { logger: false });

  return context;
};

afterEach(async () => {
  await context?.close();
  context = undefined;
});

describe('RelevanceModule', () => {
  it('binds the AI_Provider while the Relevance_Service is activated', async () => {
    const app = await bootWith(envWith({ relevanceEnabled: true }));

    expect(app.get(RELEVANCE_ASSESSOR, { strict: false })).toBeInstanceOf(
      AnthropicRelevanceAssessor,
    );
    expect(app.get(RelevanceService, { strict: false }).activated).toBe(true);
  });

  it('resolves the enrichment stage that drives the service in a Scrape_Run (15.13)', async () => {
    const app = await bootWith(envWith({ relevanceEnabled: true }));

    expect(app.get(RelevanceEnrichmentService, { strict: false })).toBeInstanceOf(
      RelevanceEnrichmentService,
    );
  });

  it('binds the no-op when the switch deactivates the service (15.9, 15.10)', async () => {
    const app = await bootWith(envWith({ relevanceEnabled: false }));

    expect(app.get(RELEVANCE_ASSESSOR, { strict: false })).toBeInstanceOf(NoopRelevanceAssessor);
    expect(app.get(RelevanceService, { strict: false }).disabledReason).toBe('SWITCHED_OFF');
  });

  it('binds the no-op when no API key is configured (15.10)', async () => {
    const app = await bootWith(envWith({ anthropicApiKey: '' }));

    expect(app.get(RELEVANCE_ASSESSOR, { strict: false })).toBeInstanceOf(NoopRelevanceAssessor);
    expect(app.get(RelevanceService, { strict: false }).disabledReason).toBe('NO_API_KEY');
  });
});
