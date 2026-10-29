import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { PrismaClient } from './prisma.types';

/**
 * The injectable Posting_Store client (9.1).
 *
 * The service *is* the `PrismaClient` rather than wrapping one, so the repositories that arrive
 * with the later tasks (`PostingRepository`, `RunRepository`, the Log_Stream persistence) inject
 * one object and use the generated, typed model API on it directly. A hand-written facade in front
 * of it would have to be widened for every new query and would hide the typed JSON columns that
 * `json-types.d.ts` exists to provide.
 *
 * Subclassing is also what gives the connection a lifecycle that Nest owns: `onModuleInit` opens
 * the connection pool before the first resolver can be reached, and `onModuleDestroy` closes it
 * again. The client is imported through `./prisma.types`, the one permitted import path for the
 * generated client.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /**
   * Opens the connection to the Posting_Store while the application is still starting up.
   *
   * `$connect` is called explicitly instead of relying on Prisma's lazy connect on the first
   * query. The difference is when a misconfigured or unreachable Posting_Store surfaces: eagerly,
   * as a failed startup before the HTTP listener binds, rather than as a failing GraphQL request
   * minutes later. That matches the fail-fast startup the API_Service applies to its configuration
   * (1.15) and gives the Start_Script's readiness gate (1.11) something truthful to poll — a
   * process that answers `health` can also reach its database.
   *
   * The error is deliberately not swallowed or translated: an exception here aborts the bootstrap
   * with a non-zero exit code, and the Start_Script reports the unreachable service to the user in
   * German. API_Service log output itself stays English (16.8).
   */
  async onModuleInit(): Promise<void> {
    await this.$connect();

    this.logger.log('Posting_Store connection established');
  }

  /**
   * Closes the connection pool when the application shuts down.
   *
   * NOTE: Nest calls this on `app.close()`. Terminating the process with a signal (Ctrl+C, the
   * Start_Script stopping the API_Service) only reaches it once `app.enableShutdownHooks()` is
   * called during bootstrap — `main.ts` is not this task's file, so that line belongs to whoever
   * next touches the bootstrap. Nothing leaks in the meantime: the query engine goes away with the
   * Node process, and since Prisma 5 the engine no longer needs an explicit disconnect to release
   * server-side connections on exit. Having the hook here means an in-process shutdown — the
   * Testcontainers harness of task 11.3 closing its application context between files — releases
   * the pool deterministically instead of leaving a handle open for the next test.
   */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();

    this.logger.log('Posting_Store connection closed');
  }
}
