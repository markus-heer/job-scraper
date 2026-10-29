/**
 * The nine closed value lists of `@job-scraper/domain`, published as GraphQL enums.
 *
 * `packages/domain` declares each vocabulary as a `const` tuple with a derived union type rather
 * than as a TypeScript `enum`, because a tuple is the only form that lets the runtime value list
 * and the compile-time type be the same declaration. `registerEnumType`, on the other hand, needs
 * an object whose own enumerable keys are the member names — the shape a TypeScript string `enum`
 * compiles to. `toEnumRef` bridges the two by deriving that object from the tuple, so the GraphQL
 * schema, the Prisma enums and the domain tuples all trace back to one declaration and no value
 * list is ever typed out a second time.
 *
 * Importing this module registers the enums as a side effect; `app.module.ts` additionally passes
 * `DOMAIN_ENUM_REFS` as `orphanedTypes` so that each enum reaches the generated `schema.gql` even
 * while no query or field references it yet. Without that, Nest would only emit the enums that are
 * reachable from a root type, and the Web_App's code generator would not see the closed value
 * lists it has to render (2.2 expects a fixed set of states per Platform and per Job_Posting).
 */

import {
  COMMUTE_MODES,
  COMMUTE_PRECISIONS,
  INTEREST_FLAGS,
  PLATFORM_STATUSES,
  PLATFORMS,
  POSTING_STATUSES,
  RELEVANCE_VERDICTS,
  RUN_OUTCOMES,
  RUN_STATUSES,
} from '@job-scraper/domain';
import { registerEnumType } from '@nestjs/graphql';

/**
 * The member-name-to-value object `registerEnumType` reads. For a string value list the two sides
 * are identical, which is what keeps a GraphQL enum member and the stored database value equal.
 */
export type EnumRef<TValue extends string> = Readonly<Record<TValue, TValue>>;

/**
 * Derives the enum reference object from a `const` tuple.
 *
 * The assertion is the one unavoidable step: `Object.fromEntries` is typed to return a loose record
 * because it cannot know the key set of its input, while the tuple's union type is exactly that key
 * set. The mapping below is total over `values` and maps every member onto itself, so the asserted
 * type is the true one.
 *
 * Exported for the closed value lists that are *not* domain vocabularies and therefore have no
 * entry below: `Reachability` in `../posting/models/reachability.enum.ts` is a reading of a stored
 * column against configuration rather than a stored value, and it is registered from the same
 * tuple-to-object derivation so that no value list is typed out a second time there either.
 */
export const toEnumRef = <TValue extends string>(values: readonly TValue[]): EnumRef<TValue> =>
  Object.freeze(Object.fromEntries(values.map((value) => [value, value]))) as EnumRef<TValue>;

export const PlatformEnumRef = toEnumRef(PLATFORMS);
export const PlatformStatusEnumRef = toEnumRef(PLATFORM_STATUSES);
export const PostingStatusEnumRef = toEnumRef(POSTING_STATUSES);
export const InterestFlagEnumRef = toEnumRef(INTEREST_FLAGS);
export const RelevanceVerdictEnumRef = toEnumRef(RELEVANCE_VERDICTS);
export const RunOutcomeEnumRef = toEnumRef(RUN_OUTCOMES);
export const RunStatusEnumRef = toEnumRef(RUN_STATUSES);
export const CommuteModeEnumRef = toEnumRef(COMMUTE_MODES);
export const CommutePrecisionEnumRef = toEnumRef(COMMUTE_PRECISIONS);

/**
 * One entry per domain vocabulary. The GraphQL type name matches the domain union type name, so a
 * reader of `schema.gql` and a reader of `packages/domain/src/enums.ts` see the same identifier.
 *
 * Descriptions are English like every other identifier and comment in the repository (16.8); only
 * Web_App strings, Start_Script output and Relevance_Reason texts are German.
 */
const DOMAIN_ENUM_REGISTRATIONS = [
  {
    name: 'Platform',
    ref: PlatformEnumRef,
    description: 'A job platform the Job_Tool retrieves job postings from.',
  },
  {
    name: 'PlatformStatus',
    ref: PlatformStatusEnumRef,
    description:
      'The configuration state of one Platform at startup, or the result of a Scrape_Run for that Platform.',
  },
  {
    name: 'PostingStatus',
    ref: PostingStatusEnumRef,
    description: 'Whether a stored Job_Posting is still listed on its Platform.',
  },
  {
    name: 'InterestFlag',
    ref: InterestFlagEnumRef,
    description: "The user's marking of a Job_Posting, independent of its Posting_Status.",
  },
  {
    name: 'RelevanceVerdict',
    ref: RelevanceVerdictEnumRef,
    description: 'The outcome of a relevance assessment of a Job_Posting.',
  },
  {
    name: 'RunOutcome',
    ref: RunOutcomeEnumRef,
    description: 'The final state of a finished Scrape_Run.',
  },
  {
    name: 'RunStatus',
    ref: RunStatusEnumRef,
    description: 'Whether a Scrape_Run is still running or has finished.',
  },
  {
    name: 'CommuteMode',
    ref: CommuteModeEnumRef,
    description: 'The means of transport a Commute_Time is determined for.',
  },
  {
    name: 'CommutePrecision',
    ref: CommutePrecisionEnumRef,
    description: 'How precisely the work location behind a Commute_Time could be resolved.',
  },
] as const;

for (const { name, ref, description } of DOMAIN_ENUM_REGISTRATIONS) {
  registerEnumType(ref, { name, description });
}

/** The GraphQL type names of the registered domain enums, in registration order. */
export const DOMAIN_ENUM_NAMES: readonly string[] = DOMAIN_ENUM_REGISTRATIONS.map(
  (registration) => registration.name,
);

/**
 * The enum reference objects, for `buildSchemaOptions.orphanedTypes`. Nest only emits a registered
 * enum when something references it or when it is listed here.
 */
export const DOMAIN_ENUM_REFS: readonly object[] = DOMAIN_ENUM_REGISTRATIONS.map(
  (registration) => registration.ref,
);
