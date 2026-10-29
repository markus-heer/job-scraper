import { Module } from '@nestjs/common';

import { LogStreamResolver } from './log-stream.resolver';
import { LogStreamService } from './log-stream.service';
import { secretMaskerProvider } from './secret-masker.provider';

/**
 * The Log_Stream feature module (12.2, 12.3, 12.4, 12.9, 14.9).
 *
 * The service, its masker and the resolver that serves the Log_View. The service is exported
 * because the Log_Stream is a dependency of nearly every other feature — the Scraper_Service, both
 * enrichment services and the run lifecycle all report through it — and all of them need the *same*
 * instance, since the sequence counters live in it.
 *
 * The resolver is only a provider: Nest discovers it through the module container when it builds
 * the schema, and nothing else in the application calls it. It is registered here rather than in a
 * shared GraphQL module so that the feature arrives in one piece.
 *
 * The masker is provided but not exported: masking belongs to `emit`, and a second consumer that
 * could mask on its own would make "every message is masked" a convention instead of a property of
 * this module. The error mapper of a later task reports through `emit` for the same reason.
 *
 * Neither `PrismaModule` nor `ConfigModule` is imported: both are global, and the two dependencies
 * are taken through the `PrismaService` class token and the `ENV_CONFIG` token respectively.
 */
@Module({
  providers: [secretMaskerProvider, LogStreamService, LogStreamResolver],
  exports: [LogStreamService],
})
export class LogStreamModule {}
