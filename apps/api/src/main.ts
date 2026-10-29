import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { loadEnvConfigOrExit } from './config/env.config';
import {
  assertFixtureModeDatabase,
  installFixtureModeNetworkGuard,
  isFixtureMode,
} from './config/fixture-mode';
import { GRAPHQL_PATH } from './graphql/schema-options';

/**
 * The API_Service binds to the loopback interface only.
 *
 * The Job_Tool runs entirely on one developer machine and has no deployment target (1.16), so
 * there is no authentication layer. A GraphQL endpoint that can start browser automation must
 * therefore not be reachable from the network — binding to `127.0.0.1` instead of the default
 * `0.0.0.0` is what keeps that true, and the Risk Assessment records it as a deliberate decision
 * rather than an oversight.
 */
export const API_HOST = '127.0.0.1';

/**
 * Starts the API_Service.
 *
 * The configuration is loaded before the application is created, not alongside it. An incomplete
 * environment file then costs a German console message and a non-zero exit code (1.15) instead of
 * a process that binds a listener and fails on the first query. `API_PORT` comes from that
 * validated configuration, so an unusable port is reported by name rather than silently replaced
 * by a default.
 */
export async function bootstrap(): Promise<void> {
  const config = loadEnvConfigOrExit();

  // Both are no-ops outside fixture mode. In fixture mode they are what makes "no E2E run issues a
  // real external request" and "no E2E run touches the development Posting_Store" structural rather
  // than configured: the guard is installed before any module is initialised, so it is in force for
  // every provider the application graph later builds, and the database check runs before the first
  // connection is opened. See `./config/fixture-mode.ts`.
  assertFixtureModeDatabase(config);
  installFixtureModeNetworkGuard(config);

  const app = await NestFactory.create(AppModule);

  // Lets a signal from the Start_Script reach `onModuleDestroy`, which is what closes the
  // Posting_Store connection pool deterministically instead of leaving it to process exit.
  app.enableShutdownHooks();

  // Runs every module's init hook, among them the Default_Search_Profile check of `ProfileModule`.
  // `listen` would initialise the application itself, but doing it here is what makes the ordering
  // 3.6 asks for explicit: an invalid profile stops the process before any socket is bound.
  await app.init();

  await app.listen(config.apiPort, API_HOST);

  const logger = new Logger('Bootstrap');

  logger.log(
    `API_Service listening on http://${API_HOST}:${config.apiPort}${GRAPHQL_PATH} (loopback only)`,
  );

  if (isFixtureMode(config)) {
    // Stated once and loudly, because a process in this mode stores Job_Posting that came from a
    // frozen fixture and Commute_Time and Relevance_Verdict that were derived rather than measured.
    // Nobody should ever be in doubt about which of the two kinds of data they are looking at. The
    // E2E harness also waits for this listener, so the line doubles as the readiness marker.
    logger.warn(
      'SCRAPER_FIXTURE_MODE is on: the Platform_Adapter read frozen fixtures, the ' +
        'Routing_Provider and the AI_Provider are local doubles, and every non-loopback request is ' +
        'refused. This is the E2E harness, not a usable Job_Tool.',
    );
  }
}

/**
 * Only bootstrap when this file is the entry point. Tests import from here, and an import must not
 * start a listener or read the environment file.
 */
if (require.main === module) {
  void bootstrap();
}
