/**
 * How the Posting_Store reaches its consumers.
 *
 * Nest's real dependency injection is used — the module is booted as an application context — but
 * the two lifecycle hooks are replaced for the duration of the test, so no connection to a
 * database is attempted. That the hooks themselves call `$connect` and `$disconnect` is the
 * subject of `prisma.service.test.ts`; what is asserted here is that Nest calls them at all, and
 * when.
 *
 * The injection test is about the `@Global` decision: a feature module that never imports
 * `PrismaModule` still receives the client, and it receives the *same* instance, which is what
 * keeps a single connection pool behind every repository, the Log_Stream and both enrichment
 * services.
 *
 * Requirements: 9.1.
 */

import { Module } from '@nestjs/common';
import { type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrismaModule } from '../prisma.module';
import { PrismaService } from '../prisma.service';

/**
 * A stand-in for the feature modules that arrive with the later tasks. The provider is declared
 * with an explicit `inject` list rather than with a decorated constructor on purpose: the API
 * package is compiled by esbuild in tests, which does not emit the constructor parameter metadata
 * that implicit injection relies on. A factory provider needs no metadata and exercises exactly
 * the same resolution path.
 */
const CONSUMER = Symbol('TEST_CONSUMER');

@Module({
  providers: [
    {
      provide: CONSUMER,
      useFactory: (prisma: PrismaService) => ({ prisma }),
      inject: [PrismaService],
    },
  ],
  exports: [CONSUMER],
})
class ConsumerModule {}

@Module({ imports: [PrismaModule, ConsumerModule] })
class RootModule {}

let context: INestApplicationContext | undefined;

afterEach(async () => {
  await context?.close();
  context = undefined;
  vi.restoreAllMocks();
});

describe('PrismaModule', () => {
  it('provides the Posting_Store client and lets Nest own its connection lifecycle', async () => {
    const onModuleInit = vi
      .spyOn(PrismaService.prototype, 'onModuleInit')
      .mockResolvedValue(undefined);
    const onModuleDestroy = vi
      .spyOn(PrismaService.prototype, 'onModuleDestroy')
      .mockResolvedValue(undefined);

    context = await NestFactory.createApplicationContext(PrismaModule, { logger: false });

    expect(typeof context.get(PrismaService).jobPosting.findMany).toBe('function');
    expect(onModuleInit).toHaveBeenCalledTimes(1);
    expect(onModuleDestroy).not.toHaveBeenCalled();

    const closing = context;
    context = undefined;
    await closing.close();

    expect(onModuleDestroy).toHaveBeenCalledTimes(1);
  });

  it('hands the same single instance to a module that does not import it', async () => {
    vi.spyOn(PrismaService.prototype, 'onModuleInit').mockResolvedValue(undefined);
    vi.spyOn(PrismaService.prototype, 'onModuleDestroy').mockResolvedValue(undefined);

    context = await NestFactory.createApplicationContext(RootModule, { logger: false });

    const consumer = context.get<{ prisma: PrismaService }>(CONSUMER, { strict: false });

    expect(typeof consumer.prisma.jobPosting.findMany).toBe('function');
    expect(consumer.prisma === context.get(PrismaService, { strict: false })).toBe(true);
  });
});
