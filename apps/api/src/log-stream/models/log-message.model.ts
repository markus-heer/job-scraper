import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

import { PlatformEnumRef } from '../../graphql/domain-enums';
import type { LogLevel, LogMessage, Platform } from '../../prisma/prisma.types';
import { LogLevelEnumRef } from './log-level.enum';

/**
 * One status message of a Scrape_Run as the Log_View receives it (12.2, 12.3, 12.4).
 *
 * `implements Omit<LogMessage, 'detail'>` is the load-bearing part of this declaration: the
 * resolvers hand persisted rows straight to GraphQL, and this clause is what makes the compiler
 * check that every column the schema promises exists on the row with the type the schema claims. A
 * renamed or retyped column in `schema.prisma` then fails `pnpm check-types` here instead of
 * turning into a `null` in the Log_View.
 *
 * `detail` is the one column that stays inside the API_Service, and it is excluded on purpose
 * rather than by omission. It is the structured developer context of a message (an attempt count, a
 * source URL, a missing field name) with an open key set, so exposing it would mean putting an
 * untyped JSON scalar into the schema the Web_App's code generator reads — for data the Log_View
 * does not render: the user sees creation time, platform, level and the German text, and technical
 * detail deliberately stays out of their way. The column is still written and still masked (14.9);
 * it is read from the Posting_Store when a developer debugs a run.
 *
 * Apollo's cache key for this type is `['runId', 'sequence']` (12.9), so both fields are part of
 * the type even though `id` is the primary key: the pair is what makes a message delivered twice —
 * by the history query and by the subscription after a reconnect — collapse into one cache entry.
 *
 * Requirements: 12.2, 12.3, 12.4, 12.9.
 */
@ObjectType('LogMessage', {
  description: 'One status message of a Scrape_Run, as shown in the Log_View.',
})
export class LogMessageModel implements Omit<LogMessage, 'detail'> {
  @Field(() => ID, { description: 'Identifier of the stored message.' })
  id: string;

  @Field(() => ID, { description: 'Identifier of the Scrape_Run this message belongs to.' })
  runId: string;

  @Field(() => Int, {
    description:
      'Position within the Scrape_Run: strictly monotonic and gapless, starting at 1. The Log_View passes the highest value it holds as `afterSequence` to reload without gaps and without duplicates.',
  })
  sequence: number;

  @Field(() => Date, {
    description: 'Creation time in ISO 8601 format; the order of creation (12.3, 12.4).',
  })
  createdAt: Date;

  @Field(() => PlatformEnumRef, {
    nullable: true,
    description:
      'The Platform the message is about, or null for a message that concerns the whole Scrape_Run.',
  })
  platform: Platform | null;

  @Field(() => LogLevelEnumRef, { description: 'Severity of the message.' })
  level: LogLevel;

  @Field(() => String, { description: 'Stable English key for tests and developers.' })
  code: string;

  @Field(() => String, { description: 'German text shown in the Log_View (12.3).' })
  messageDe: string;
}
