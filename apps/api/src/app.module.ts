import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';

import { AppInfoModule } from './app-info/app-info.module';
import { CommuteModule } from './commute/commute.module';
import { ConfigModule } from './config/config.module';
import {
  GRAPHQL_BUILD_SCHEMA_OPTIONS,
  GRAPHQL_PATH,
  GRAPHQL_SUBSCRIPTION_OPTIONS,
  SCHEMA_FILE_PATH,
} from './graphql/schema-options';
import { HealthModule } from './health/health.module';
import { LogStreamModule } from './log-stream/log-stream.module';
import { PlatformConfigModule } from './platform-config/platform-config.module';
import { PostingModule } from './posting/posting.module';
import { PostingReadModule } from './posting/posting-read.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProfileModule } from './profile/profile.module';
import { RelevanceModule } from './relevance/relevance.module';
import { ScrapeRunModule } from './scrape-run/scrape-run.module';
import { ScraperModule } from './scraper/scraper.module';

/**
 * Root module of the API_Service.
 *
 * GraphQL is code-first: the decorators on the resolvers and the GraphQL model classes are the
 * source of truth, and Nest writes `apps/api/src/schema.gql` from them at startup. The frontend
 * code generator reads that file, so the schema is the contract between the two apps and is never
 * hand-edited.
 *
 * `ConfigModule` and `PrismaModule` are the infrastructure both declared global: the validated
 * environment file (1.12, 1.15) and the Posting_Store connection (9.1). `ProfileModule` carries the
 * Default_Search_Profile check, whose init hook runs while `main.ts` initialises the application and
 * therefore before the listener binds (3.6). `LogStreamModule` brings the `logMessages` query and
 * the `logMessageAdded` subscription with it, which is why subscriptions are configured above.
 * `PostingModule` carries the single write path into the Posting_Store for Job_Posting (9.2, 9.3)
 * together with the `setRelevanceVerdict` mutation, with which the user overrides a
 * Relevance_Verdict so that every following Scrape_Run retains it (15.15).
 * `ScrapeRunModule` carries the run lifecycle together with the two run mutations and the
 * end-of-run summary: at most one running Scrape_Run, its abort channel, its deadlines and the
 * German answers of `startScrapeRun` and `cancelScrapeRun` (12.1, 12.5, 12.7, 12.10, 12.13,
 * 12.14). `ScraperModule` carries the retrieval phase that runs inside it: every activated
 * Platform_Adapter, the normalization and the per-Platform results (12.3). `CommuteModule` carries
 * the Commute_Service with its Routing_Provider and the enrichment stage that stores the
 * Best_Commute_Time after a Scrape_Run's retrieval phase (8.1, 8.2). `RelevanceModule` carries the
 * Relevance_Service with its retry chain, its run budget, its concurrency bound and the
 * AI_Provider binding the deactivation switch selects (15.7 to 15.11).
 *
 * The read layer of the Web_App is spread over the modules that own the data it reads, with two
 * additions here. `PostingReadModule` carries the posting overview — `jobPostings`, `jobPosting` and
 * the resolved fields of a Job_Posting (10.1 to 10.9, 11.2) — and is a module of its own because it
 * reads from both `PostingModule` and `ScrapeRunModule`, which would be a module cycle the other way
 * round; see the comment there. `AppInfoModule` carries the `appInfo` query of the landing page
 * (14.8), which spans the configuration and the Relevance_Service and belongs to neither. The three
 * Scrape_Run queries live in `ScrapeRunModule` and the read-only `searchCriteria` of 4.11 in
 * `PlatformConfigModule`, next to the state each of them publishes.
 */
@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: SCHEMA_FILE_PATH,
      path: GRAPHQL_PATH,
      buildSchemaOptions: GRAPHQL_BUILD_SCHEMA_OPTIONS,

      /**
       * The realtime half of the Log_Stream (12.4). The WebSocket server attaches to the HTTP
       * listener of `main.ts`, which is what keeps the subscription endpoint on the loopback
       * interface together with the queries.
       */
      subscriptions: GRAPHQL_SUBSCRIPTION_OPTIONS,

      /**
       * Alphabetically sorted output, so that adding a type produces a readable diff in the
       * generated schema instead of a reordering of unrelated blocks.
       */
      sortSchema: true,

      /**
       * Introspection stays on: the Web_App's code generator and the schema test both need it, and
       * the endpoint is reachable from the local machine only (1.16). The bundled Apollo landing
       * page is off — it is a deprecated transitive dependency of `@nestjs/apollo` and the
       * Job_Tool has no use for a second UI next to the Web_App.
       */
      introspection: true,
      playground: false,
    }),
    AppInfoModule,
    CommuteModule,
    ConfigModule,
    HealthModule,
    LogStreamModule,
    PlatformConfigModule,
    PostingModule,
    PostingReadModule,
    PrismaModule,
    ProfileModule,
    RelevanceModule,
    ScrapeRunModule,
    ScraperModule,
  ],
})
export class AppModule {}
