/**
 * That the generated GraphQL layer is present, current and type-safe at its call sites.
 *
 * Three things are asserted, and the third is the reason this file exists at all:
 *
 * - the generated artefacts of an operation are there and carry the operation from the `.graphql`
 *   file, so a broken `pnpm codegen` is a failing test rather than a missing import later;
 * - the schema types reached the Web_App with the closed value lists of the API_Service, which is
 *   what lets the German string module map every state it has to render;
 * - the suppression inside the generated operation files does not leak out of them. Those files
 *   carry `@ts-nocheck` (see `codegen.ts` for the two generator artefacts that forces), and the
 *   `@ts-expect-error` assertions below are what proves that this does not cost the call sites
 *   their type safety: `tsconfig.json` includes `src`, so `pnpm check-types` reads this file, and
 *   an `@ts-expect-error` that stops erroring is itself an error (TS2578).
 *
 * Requirements: 10.1.
 */

import { Kind, OperationTypeNode } from 'graphql';
import { describe, expect, it } from 'vitest';

import { HealthDocument, type HealthQuery, useHealthQuery } from '../health.generated';
import type { InterestFlag, Platform, PostingStatus } from '../schema.generated';

/** Compiles only for `true`, which is what turns a type-level claim into a checked assertion. */
type Expect<T extends true> = T;

/** Invariant type equality, so `any` or a widened union cannot pass as the expected type. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// --- The schema's closed value lists arrived as string unions, not as `string` ---

export type PlatformIsClosed = Expect<
  Equals<Platform, 'GLASSDOOR' | 'INDEED' | 'JOBVECTOR' | 'STEPSTONE'>
>;
export type PostingStatusIsClosed = Expect<Equals<PostingStatus, 'LISTED' | 'NO_LONGER_LISTED'>>;
export type InterestFlagIsClosed = Expect<Equals<InterestFlag, 'NOT_INTERESTING' | 'UNMARKED'>>;

// @ts-expect-error 10.1: a Platform the API_Service does not know is not a Platform.
const unknownPlatform: Platform = 'MONSTER';

// --- The operation result type is checked where it is read ---

export type HealthIsString = Expect<Equals<HealthQuery['health'], string>>;

// @ts-expect-error 10.1: `health` is a String! in the schema, so a number is not a result.
const wrongResultShape: HealthQuery = { health: 42 };

// @ts-expect-error 10.1: the schema has no `uptime` field on the root query type.
const unknownResultField: HealthQuery = { health: 'ok', uptime: 1 };

// --- The hook options are checked at the call site ---

/** The options object the generated query hook accepts. */
type HealthOptions = NonNullable<Parameters<typeof useHealthQuery>[0]>;

const validOptions: HealthOptions = { fetchPolicy: 'cache-and-network', pollInterval: 5_000 };

const invalidOptions: HealthOptions = {
  // @ts-expect-error 10.1: `fetchPolicy` is a closed set of Apollo Client policies.
  fetchPolicy: 'whenever-convenient',
};

describe('generated GraphQL artefacts', () => {
  it('generated a document for the operation in health.graphql', () => {
    expect(HealthDocument.kind).toBe(Kind.DOCUMENT);

    const operation = HealthDocument.definitions[0];

    expect(operation?.kind).toBe(Kind.OPERATION_DEFINITION);
    expect(operation?.kind === Kind.OPERATION_DEFINITION && operation.operation).toBe(
      OperationTypeNode.QUERY,
    );
    expect(operation?.kind === Kind.OPERATION_DEFINITION && operation.name?.value).toBe('Health');
  });

  it('generated a React hook for it', () => {
    expect(typeof useHealthQuery).toBe('function');
  });

  it('keeps the type-level assertions of this file reachable', () => {
    // The `@ts-expect-error` assertions above are checked by `pnpm check-types`, not at runtime.
    // Referencing the values here keeps them out of reach of `noUnusedLocals`, which would
    // otherwise be the first thing to fail and would hide what the file actually asserts.
    expect([unknownPlatform, wrongResultShape, unknownResultField]).toHaveLength(3);
    expect([validOptions, invalidOptions]).toHaveLength(2);
  });
});
