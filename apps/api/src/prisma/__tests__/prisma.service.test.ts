/**
 * The connection lifecycle of the Posting_Store client.
 *
 * No database is involved: constructing the generated client performs no I/O (not even the
 * datasource URL is read), so the real `PrismaService` can be instantiated here and only the two
 * calls that would open and close a socket are observed. The questions this answers are about the
 * lifecycle wiring, not about SQL — the behaviour of the stored data is the subject of the
 * repository tests and of the integration harness that runs against a real PostgreSQL container
 * (tasks 11.x).
 *
 * What has to hold:
 *
 * - the client connects eagerly during module initialisation rather than lazily on the first
 *   query, so an unreachable Posting_Store fails the startup instead of a later GraphQL request;
 * - a failing connect propagates, which is what turns it into a non-zero exit;
 * - the connection is released again on shutdown;
 * - the service is a `PrismaClient`, because the repositories use the generated model API on it.
 *
 * Requirements: 9.1.
 */

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaService } from '../prisma.service';

let service: PrismaService;

beforeEach(() => {
  // The service logs one line per lifecycle transition; the assertions below are about the
  // connection, so the output is kept out of the test report.
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

  service = new PrismaService();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PrismaService', () => {
  it('carries the generated model API, so repositories query through the injected service', () => {
    // The assertion is deliberately about the API and not `instanceof`: the `PrismaClient` symbol
    // the generated package exports is a wrapper, not the class the instance is built from, so an
    // `instanceof` check against it is false for every client Prisma ever hands out. What the
    // repositories actually need is the model delegates and the connection API, so that is what is
    // pinned here. One delegate stands for all of them.
    expect(typeof service.$connect).toBe('function');
    expect(typeof service.$disconnect).toBe('function');
    expect(typeof service.$transaction).toBe('function');
    expect(typeof service.jobPosting.findMany).toBe('function');
  });

  it('opens the Posting_Store connection on module initialisation', async () => {
    const connect = vi.spyOn(service, '$connect').mockResolvedValue(undefined);

    await service.onModuleInit();

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('propagates a failing connect so the startup fails fast', async () => {
    const failure = new Error('Posting_Store unreachable');
    vi.spyOn(service, '$connect').mockRejectedValue(failure);

    await expect(service.onModuleInit()).rejects.toThrow(failure);
  });

  it('releases the Posting_Store connection on shutdown', async () => {
    const disconnect = vi.spyOn(service, '$disconnect').mockResolvedValue(undefined);

    await service.onModuleDestroy();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not connect before the lifecycle hook runs', async () => {
    const connect = vi.spyOn(service, '$connect').mockResolvedValue(undefined);

    expect(connect).not.toHaveBeenCalled();

    await service.onModuleInit();

    expect(connect).toHaveBeenCalledTimes(1);
  });
});
