/**
 * Migrations are applied exactly once, in order, and keep the stored data (9.6).
 *
 * The acceptance criterion makes three promises about schema changes, and all three are only
 * observable against a real engine with Prisma's own bookkeeping table in place:
 *
 * - every migration runs exactly once,
 * - in ascending version order,
 * - and already stored Job_Posting, Scrape_Run and relevance assessments survive.
 *
 * The replay is `prisma migrate deploy` run a second time against the already migrated container
 * with seeded data in it — the same command the Start_Script runs on every start (step 5), so what
 * is asserted here is what happens on the user's machine each time the Job_Tool comes up, not a
 * test-only code path.
 *
 * Requirements: 9.6.
 */

import { describe, expect, it } from 'vitest';

import { usePostgres } from '../../testing/postgres-harness';
import {
  SEEDED_CONTENT_HASH,
  SEEDED_EFFECTIVE_PROFILE,
  seedPostingStore,
} from '../../testing/posting-store.fixture';

/** One row of Prisma's migration bookkeeping. */
interface MigrationRow {
  readonly migrationName: string;
  readonly finishedAt: Date | null;
  readonly appliedStepsCount: number;
  readonly rolledBackAt: Date | null;
}

const postgres = usePostgres();

const readMigrations = async (): Promise<readonly MigrationRow[]> =>
  postgres.prisma.$queryRaw<MigrationRow[]>`
    SELECT migration_name       AS "migrationName",
           finished_at          AS "finishedAt",
           applied_steps_count  AS "appliedStepsCount",
           rolled_back_at       AS "rolledBackAt"
      FROM "public"."_prisma_migrations"
     ORDER BY started_at
  `;

describe('Posting_Store migrations', () => {
  it('records every migration exactly once, finished and never rolled back', async () => {
    const migrations = await readMigrations();
    const names = migrations.map((migration) => migration.migrationName);

    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);

    for (const migration of migrations) {
      expect(migration.finishedAt).not.toBeNull();
      expect(migration.rolledBackAt).toBeNull();
      expect(migration.appliedStepsCount).toBeGreaterThan(0);
    }
  });

  it('applied the migrations in ascending version order', async () => {
    const names = (await readMigrations()).map((migration) => migration.migrationName);

    // The migration directory name starts with the timestamp Prisma assigned, so lexicographic
    // order over the names is the version order. Asserted against the application order read from
    // `started_at`, which is what "ascending version order" means for the data.
    expect(names).toEqual([...names].sort());
  });

  it('applies nothing on a replay and keeps the seeded data', async () => {
    const seeded = await seedPostingStore(postgres.prisma);
    const migrationsBefore = await readMigrations();

    const output = await postgres.replayMigrations();

    // Prisma reports an already up-to-date database instead of re-running anything.
    expect(output).toContain('No pending migrations');
    expect(await readMigrations()).toEqual(migrationsBefore);

    const run = await postgres.prisma.scrapeRun.findUniqueOrThrow({
      where: { id: seeded.run.id },
    });
    const posting = await postgres.prisma.jobPosting.findUniqueOrThrow({
      where: { id: seeded.posting.id },
    });
    const platformResult = await postgres.prisma.scrapeRunPlatformResult.findUniqueOrThrow({
      where: { runId_platform: { runId: seeded.run.id, platform: 'STEPSTONE' } },
    });

    // Field by field rather than row count only: a migration that kept the rows but dropped a
    // column would otherwise pass. The relevance assessment and its content hash are named
    // explicitly, because 9.6 lists them next to the Job_Posting and the Scrape_Run.
    expect(run).toEqual(seeded.run);
    expect(posting).toEqual(seeded.posting);
    expect(posting.relevanceVerdict).toBe('RELEVANT');
    expect(posting.relevanceReason).toBe(seeded.posting.relevanceReason);
    expect(posting.relevanceModel).toBe('claude-sonnet-4-5');
    expect(posting.relevanceContentHash).toBe(SEEDED_CONTENT_HASH);
    expect(posting.contentHash).toBe(SEEDED_CONTENT_HASH);

    // The typed JSON column survives as the object it was written as, not as a string.
    expect(platformResult.effectiveProfile).toEqual(SEEDED_EFFECTIVE_PROFILE);

    await expect(postgres.prisma.logMessage.count()).resolves.toBe(1);
  });

  it('keeps the unique key of a Job_Posting enforced after the replay', async () => {
    const seeded = await seedPostingStore(postgres.prisma);

    await postgres.replayMigrations();

    // The constraint of 9.2 is what the upsert path of task 11.1 relies on, so the replay must not
    // have dropped it.
    await expect(
      postgres.prisma.jobPosting.create({
        data: {
          platform: seeded.posting.platform,
          postingId: seeded.posting.postingId,
          title: seeded.posting.title,
          sourceUrl: seeded.posting.sourceUrl,
          firstSeenAt: seeded.posting.firstSeenAt,
          lastSeenAt: seeded.posting.lastSeenAt,
          firstSeenRunId: seeded.run.id,
          contentHash: seeded.posting.contentHash,
        },
      }),
    ).rejects.toThrow(/Unique constraint/i);
  });
});
