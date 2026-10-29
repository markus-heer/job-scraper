import { registerEnumType } from '@nestjs/graphql';

import { toEnumRef } from '../../graphql/domain-enums';
import { REACHABILITIES } from '../posting-page-query';

/**
 * The three reachability values of the filter of 10.5, as a GraphQL enum.
 *
 * Registered from `REACHABILITIES` in `../posting-page-query.ts` rather than from a second list, for
 * the same reason the nine domain vocabularies are registered from their domain tuples: the runtime
 * value list and the compile-time union have to be one declaration, or the schema and the filter
 * can drift apart by one value.
 *
 * Deliberately not part of `../../graphql/domain-enums.ts`: `Reachability` is not a stored column
 * and not a member of `@job-scraper/domain`. It is a reading of `bestCommuteMinutes` against the
 * configured Commute_Threshold (8.3, 8.11, 8.13), so the same stored Job_Posting answers to a
 * different value once the user changes the threshold.
 *
 * Requirements: 8.11, 8.13, 10.5.
 */
export const ReachabilityEnumRef = toEnumRef(REACHABILITIES);

registerEnumType(ReachabilityEnumRef, {
  name: 'Reachability',
  description:
    'How reachable a Job_Posting is, read from its Best_Commute_Time against the configured Commute_Threshold.',
});
