import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * Access to the Posting_Store (9.1).
 *
 * `@Global` because the Posting_Store is infrastructure, not a feature: the Log_Stream, the posting
 * and run repositories, the two enrichment services and the GraphQL read layer all need it, and
 * none of them has a different view of it. Declaring it once here is what keeps a single
 * `PrismaService` instance — and therefore a single connection pool — behind all of them;
 * re-importing the module per feature would list the same dependency a dozen times without
 * changing anything about it.
 *
 * The provider is exported as well, so an explicit `imports: [PrismaModule]` keeps working. The
 * Testcontainers harness of task 11.3 relies on that: it builds a testing module from the
 * repository under test alone and has to be able to name its dependencies.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
