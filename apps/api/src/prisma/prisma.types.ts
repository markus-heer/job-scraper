/**
 * The only import path for the generated Prisma client.
 *
 * Every consumer — repositories, services, resolvers and tests — imports `PrismaClient`, the
 * `Prisma` namespace, the model types and the database enums from this file and never from
 * `@prisma/client` directly. Two reasons:
 *
 * - The generated client is build output. Routing every use through one re-export keeps the
 *   generated path out of the rest of the codebase, so regenerating it or moving its output changes
 *   exactly one file.
 * - The typed JSON columns only exist because `apps/api/src/prisma/json-types.d.ts` declares the
 *   `PrismaJson` namespace. Pairing that declaration with this re-export keeps the two halves of
 *   the typing in one directory.
 *
 * The Prisma database enums share their names with the domain value lists of
 * `@job-scraper/domain` (`Platform`, `PostingStatus`, …) because they mirror them member for
 * member. Code that needs both sides at once — the enum parity test, the GraphQL mapping layer —
 * aliases one of them at its own import site.
 */

export * from '@prisma/client';
