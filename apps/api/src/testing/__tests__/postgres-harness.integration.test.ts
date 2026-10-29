/**
 * What the integration harness promises its callers.
 *
 * The property tests of tasks 11.4 – 11.6 and the read-layer tests of task 15.10 build on three
 * guarantees, so those are asserted here rather than assumed:
 *
 * - the harness hands out a connected client against a migrated throwaway container, not against
 *   the development Posting_Store;
 * - every test starts with an empty Posting_Store, so no test can see another's rows;
 * - the truncation keeps the applied migrations, so the schema does not have to be rebuilt between
 *   tests.
 *
 * This file is itself the proof that Testcontainers works in this repository: without a reachable
 * Docker daemon it fails in the harness `beforeAll` with the explicit message the harness raises.
 *
 * Requirements: 9.6.
 */

import { describe, expect, it } from 'vitest';

import { MIGRATIONS_TABLE, usePostgres } from '../postgres-harness';
import { seedPostingStore } from '../posting-store.fixture';

const postgres = usePostgres();

describe('usePostgres', () => {
  it('connects to a throwaway container and not to the development Posting_Store', async () => {
    const url = new URL(postgres.databaseUrl);

    expect(url.protocol).toBe('postgresql:');
    expect(url.pathname).toBe('/jobtool_test');
    expect(url.searchParams.get('schema')).toBe('public');

    // Mapped to an ephemeral host port by Docker, so it is never the port of the development
    // container from `docker-compose.yml`.
    expect(Number(url.port)).toBeGreaterThan(0);

    const rows = await postgres.prisma.$queryRaw<{ database: string }[]>`
      SELECT current_database() AS "database"
    `;

    expect(rows[0]?.database).toBe('jobtool_test');
  });

  it('applies the migrations, so the Posting_Store tables exist', async () => {
    const tables = await postgres.prisma.$queryRaw<{ tableName: string }[]>`
      SELECT table_name AS "tableName"
        FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_name
    `;

    const names = tables.map((table) => table.tableName);

    expect(names).toContain('JobPosting');
    expect(names).toContain('ScrapeRun');
    expect(names).toContain('ScrapeRunPlatformResult');
    expect(names).toContain('LogMessage');
    expect(names).toContain(MIGRATIONS_TABLE);
  });

  it('starts with an empty Posting_Store and accepts seeded data', async () => {
    await expect(postgres.prisma.jobPosting.count()).resolves.toBe(0);

    const { run, posting } = await seedPostingStore(postgres.prisma);

    expect(posting.firstSeenRunId).toBe(run.id);
    await expect(postgres.prisma.jobPosting.count()).resolves.toBe(1);
    await expect(postgres.prisma.scrapeRun.count()).resolves.toBe(1);
    await expect(postgres.prisma.logMessage.count()).resolves.toBe(1);
  });

  it('leaks no row from the previous test', async () => {
    // Runs after the seeding test above and therefore states what the per-test truncation is for.
    await expect(postgres.prisma.jobPosting.count()).resolves.toBe(0);
    await expect(postgres.prisma.scrapeRun.count()).resolves.toBe(0);
    await expect(postgres.prisma.scrapeRunPlatformResult.count()).resolves.toBe(0);
    await expect(postgres.prisma.logMessage.count()).resolves.toBe(0);
  });

  it('keeps the applied migrations when it truncates', async () => {
    const countMigrations = async (): Promise<number> => {
      const rows = await postgres.prisma.$queryRaw<{ applied: bigint }[]>`
        SELECT count(*) AS "applied" FROM "public"."_prisma_migrations"
      `;

      return Number(rows[0]?.applied ?? -1);
    };

    const before = await countMigrations();

    await seedPostingStore(postgres.prisma);
    await postgres.truncate();

    expect(before).toBeGreaterThan(0);
    await expect(countMigrations()).resolves.toBe(before);
    await expect(postgres.prisma.jobPosting.count()).resolves.toBe(0);
  });
});
