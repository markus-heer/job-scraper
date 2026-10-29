import { Global, Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { AppConfigService } from './config.service';
import { ENV_CONFIG, loadEnvConfigOrExit } from './env.config';

/**
 * The validated configuration of the API_Service (1.12, 1.15).
 *
 * `@Global` for the same reason as `PrismaModule`: the configuration is infrastructure. The
 * Commute_Service needs Home_Address and Commute_Threshold, the Relevance_Service the AI_Provider
 * settings, the Platform_Adapter the user agent contact, the GraphQL `appInfo` query most of it —
 * and all of them need the same instance, because `AppConfigService` resolves the configurable
 * pair once at startup.
 *
 * `PrismaModule` is imported explicitly even though it is global as well. The import is what
 * orders the two lifecycles: Nest initialises an imported module before the importing one, so the
 * Posting_Store connection is open before `AppConfigService` reads the last accepted pair from the
 * `Setting` table.
 *
 * The factory calls the loader that also runs in `main.ts`; the loader caches, so the environment
 * file is read once per process and the port the listener bound to cannot differ from the port the
 * rest of the application sees.
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: ENV_CONFIG,
      useFactory: loadEnvConfigOrExit,
    },
    AppConfigService,
  ],
  exports: [ENV_CONFIG, AppConfigService],
})
export class ConfigModule {}
