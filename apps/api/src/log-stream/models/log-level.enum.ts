import { registerEnumType } from '@nestjs/graphql';

import { $Enums } from '../../prisma/prisma.types';

/**
 * The severity of a Log_Stream message, published as a GraphQL enum.
 *
 * This is the one closed value list of the Job_Tool that is *not* a domain vocabulary: the enum
 * parity test records `LogLevel` as deliberately database-only, because the level is produced
 * inside `apps/api` and `packages/domain` has no tuple for it. The registration therefore lives
 * next to the GraphQL model that uses it rather than in `src/graphql/domain-enums.ts`, and the
 * reference object is the generated Prisma enum itself — the shape `registerEnumType` wants is
 * exactly what Prisma emits for an enum, so `schema.prisma` stays the single source of the member
 * list and no value is typed out a second time.
 *
 * Unlike the nine domain enums this one needs no `orphanedTypes` entry: `LogMessage.level`
 * references it, so Nest reaches it from the `logMessages` query and emits it into `schema.gql`.
 *
 * Requirements: 12.3.
 */
registerEnumType($Enums.LogLevel, {
  name: 'LogLevel',
  description: 'The severity of a Log_Stream message.',
});

/** The registered reference object, for `@Field(() => LogLevelEnumRef)`. */
export const LogLevelEnumRef = $Enums.LogLevel;
