import { Inject } from '@nestjs/common';
import { Args, ID, Int, Query, Resolver, Subscription } from '@nestjs/graphql';

import type { LogMessage } from '../prisma/prisma.types';
import { LOG_HISTORY_DEFAULT_LIMIT, LogStreamService } from './log-stream.service';
import { LogMessageModel } from './models/log-message.model';

/**
 * The two halves of the Log_Stream the Web_App stitches its view from (12.2, 12.4, 12.9).
 *
 * Thin by construction: both methods forward to `LogStreamService` and return what it yields. The
 * sequencing, the page size clamp, the replay of the handover window and the secret masking all
 * live in the service, because every emitter of the Job_Tool goes through it while this resolver
 * only serves the one client that reads. There is nothing to map either — a persisted row *is* the
 * published message, which is what keeps "what the subscription delivered" and "what a reload
 * returns" the same value.
 *
 * The protocol the two operations form is the subject of 12.9, and the order matters: the Log_View
 * loads `logMessages` first, remembers the highest `sequence` it received and only then opens
 * `logMessageAdded` with that watermark. A subscription may miss messages while it is being
 * established; the query that ran before it cannot. Each operation takes `afterSequence`, so a
 * reconnect repeats the same two steps with the watermark the client already holds and the view
 * stays gapless and duplicate-free without the client having to buffer anything.
 *
 * Requirements: 12.2, 12.4, 12.9.
 */
@Resolver(() => LogMessageModel)
export class LogStreamResolver {
  /**
   * The service is injected by its class token explicitly, as everywhere else in this application.
   * Inferring the token from the parameter type would make the wiring depend on emitted decorator
   * metadata, and that metadata is lost as soon as the only use of the import is a type annotation
   * — which is precisely what a type-aware import fix turns a constructor parameter into. Naming
   * the token keeps the import a value import and the dependency visible.
   */
  constructor(@Inject(LogStreamService) private readonly logStream: LogStreamService) {}

  /**
   * The history of a run, ascending by sequence (12.2, 12.9).
   *
   * `limit` carries its default in the schema rather than only in the service, so the Web_App's
   * generated types show the page size the Log_View gets when it asks for a run without arguments.
   */
  @Query(() => [LogMessageModel], {
    name: 'logMessages',
    description:
      'Status messages of a Scrape_Run in ascending order of their sequence, which is their order of creation. Pass the highest sequence already held as `afterSequence` to continue a Log_View without gaps and without duplicates.',
  })
  logMessages(
    @Args('runId', { type: () => ID, description: 'Identifier of the Scrape_Run.' })
    runId: string,
    @Args('afterSequence', {
      type: () => Int,
      nullable: true,
      description:
        'Return only messages with a higher sequence. Omitted or null starts at the beginning of the Scrape_Run.',
    })
    afterSequence?: number | null,
    @Args('limit', {
      type: () => Int,
      nullable: true,
      defaultValue: LOG_HISTORY_DEFAULT_LIMIT,
      description: 'Maximum number of messages to return. Values above 1000 are capped.',
    })
    limit?: number | null,
  ): Promise<readonly LogMessage[]> {
    return this.logStream.history(runId, afterSequence, limit);
  }

  /**
   * The live messages of a run (12.4).
   *
   * `resolve` is the identity because the stream yields the persisted row itself, while Nest's
   * default resolver would look for the message under a `logMessageAdded` property of the payload.
   *
   * With `afterSequence` the service replays what it buffered above that watermark before it
   * continues live, which closes the window between the history query being answered and this
   * subscription being established — the one gap the two-step protocol of 12.9 cannot close from
   * the client side. The argument is optional because a client that has no watermark yet (a
   * Log_View opened on a fresh run) has nothing to stitch to.
   *
   * The returned iterator is cancelled by the consumer: when the WebSocket closes, `graphql-ws`
   * stops iterating, which runs the service's cleanup and drops the subscription.
   */
  @Subscription(() => LogMessageModel, {
    name: 'logMessageAdded',
    description:
      'Status messages of a Scrape_Run as they are created. Open this after `logMessages` and pass the highest sequence already held as `afterSequence`.',
    resolve: (payload: LogMessage) => payload,
  })
  logMessageAdded(
    @Args('runId', { type: () => ID, description: 'Identifier of the Scrape_Run to follow.' })
    runId: string,
    @Args('afterSequence', {
      type: () => Int,
      nullable: true,
      description:
        'The highest sequence the client already holds. Messages created above it since the history query are replayed before the live messages continue.',
    })
    afterSequence?: number | null,
  ): AsyncIterableIterator<LogMessage> {
    return this.logStream.stream(runId, afterSequence);
  }
}
