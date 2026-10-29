/**
 * Unit tests for the write failure path of the Posting_Store (9.9).
 *
 * 9.9 asks for three things when storing a Job_Posting fails: the affected record stays in its
 * pre-write state, the failure is reported with platform name and Posting_Id in the Log_Stream, and
 * the remaining Job_Posting of the running Scrape_Run are still stored. Only the first of the three
 * is a statement about the Posting_Store access layer; the other two are statements about the
 * component that drives the per-posting loop:
 *
 * - **Reporting** needs a Scrape_Run context the repository does not have. `LogStreamService.emit`
 *   is keyed by `runId` and carries a German text that names what happens next, and only the
 *   Scraper_Service can truthfully say that the run continues — if the repository claimed it while
 *   the caller aborted, the Log_View would state the opposite of what happened. The design's error
 *   table pins the entry to `ERROR` `posting.writeFailed` with platform and postingId and the run
 *   summary to the number of failed writes, so the component that counts the failures is the one
 *   that reports them; splitting the two would mean keeping a count and a log line consistent
 *   across two components. Emitting here on top of that would also have to survive the very
 *   failure it reports — a rejected `emit` against the same unreachable Posting_Store must not
 *   replace the write error on its way to the caller.
 * - **Continuing with the next posting** is the loop, and the loop belongs to the caller: the
 *   repository stores one Job_Posting per call and cannot know whether another follows.
 *
 * Hence `UpsertResult` has no failure variant and the rejected write propagates unchanged. Those
 * two clauses of 9.9 are covered by the Scraper_Service tasks 12.3 and 12.9, whose requirement
 * references name 9.9 for exactly this reason.
 *
 * What is asserted here is therefore everything the repository itself guarantees, which is more
 * than "the record survives":
 *
 * - A rejected create stores nothing at all, and a rejected update moves no field of the stored
 *   record — including a reappearance that was half-way through resetting the Posting_Status (9.8).
 * - The error reaches the caller as the object the Posting_Store raised, so the caller can report
 *   the cause and the central error mapping (12.5) can classify it.
 * - The failure is attributable and local to one Job_Posting: exactly the call that carries the
 *   failing platform and Posting_Id rejects, earlier postings of the run keep their stored state,
 *   and the next call — a different posting or a retry of the failed one — is served normally. That
 *   is the half of "the run continues" the repository is responsible for: nothing about a rejected
 *   write is sticky.
 *
 * The two neighbouring suites each pin one write failure inline where their subject is: a rejected
 * update in `posting.repository.test.ts` and a rejected sweep in `posting.repository.sweep.test.ts`.
 * Those cases are not repeated here.
 */

import { computeContentHash } from '@job-scraper/domain';
import type { NormalizedJobPosting } from '@job-scraper/scrapers';
import { beforeEach, describe, expect, it } from 'vitest';

import { PostingRepository } from '../posting.repository';
import { createPostingStore, type PostingStoreFixture } from './job-posting-delegate.fixture';

const FIRST_RUN_ID = 'run-1';
const SECOND_RUN_ID = 'run-2';
const FIRST_RUN_STARTED_AT = new Date('2026-03-02T08:00:00.000Z');
const SECOND_RUN_STARTED_AT = new Date('2026-03-09T08:00:00.000Z');

/** A normalized Job_Posting with every field set, so a test only states what it varies. */
const posting = (overrides: Partial<NormalizedJobPosting> = {}): NormalizedJobPosting => ({
  platform: 'STEPSTONE',
  postingId: 'abc-123',
  title: 'Projektmanagerin Pharma',
  employer: 'Beispiel Pharma GmbH',
  workLocation: 'München',
  publishedAt: new Date('2026-02-27T00:00:00.000Z'),
  sourceUrl: 'https://www.stepstone.de/stellenangebote--abc-123',
  descriptionText: 'Sie steuern Projekte im Bereich Life Science.',
  ...overrides,
});

/**
 * A rejection shaped like the ones the generated client raises for an unreachable Posting_Store.
 *
 * `P1001` rather than `P2002`: the unique-key conflict is the lost insert race and has its own
 * recovery path, so it is the one Prisma error that is deliberately *not* a failure under 9.9.
 */
const storeUnreachable = (): Error & { code: string } =>
  Object.assign(new Error("Can't reach database server at `localhost:5432`"), { code: 'P1001' });

describe('PostingRepository write failures', () => {
  let fixture: PostingStoreFixture;
  let repository: PostingRepository;

  beforeEach(() => {
    fixture = createPostingStore();
    repository = new PostingRepository(fixture.store);
  });

  it('stores nothing at all when the insert of an unknown Job_Posting is rejected', async () => {
    fixture.failNextWrite(storeUnreachable());

    await expect(repository.upsert(posting(), FIRST_RUN_ID, FIRST_RUN_STARTED_AT)).rejects.toThrow(
      "Can't reach database server",
    );

    // The pre-write state of a Job_Posting that was never stored is its absence: no half-written
    // record, and nothing the next Scrape_Run would mistake for a first recording.
    expect(fixture.rows.size).toBe(0);
    expect(fixture.writes).toHaveLength(0);
  });

  it('keeps a reappearing Job_Posting at "no longer listed" when its update is rejected', async () => {
    const before = {
      ...fixture.seed({
        platform: 'STEPSTONE',
        postingId: 'abc-123',
        title: 'Projektmanagerin Pharma',
        sourceUrl: 'https://www.stepstone.de/stellenangebote--abc-123',
        descriptionText: 'Sie steuern Projekte im Bereich Life Science.',
        firstSeenRunId: FIRST_RUN_ID,
        firstSeenAt: FIRST_RUN_STARTED_AT,
        lastSeenAt: FIRST_RUN_STARTED_AT,
        postingStatus: 'NO_LONGER_LISTED',
        contentHash: computeContentHash(
          'Projektmanagerin Pharma',
          'Sie steuern Projekte im Bereich Life Science.',
        ),
      }),
    };

    fixture.failNextWrite(storeUnreachable());

    await expect(
      repository.upsert(
        posting({ title: 'Senior Projektmanagerin Pharma' }),
        SECOND_RUN_ID,
        SECOND_RUN_STARTED_AT,
      ),
    ).rejects.toThrow("Can't reach database server");

    // The reset of 9.8 is part of the same statement as the content fields, so a rejected write
    // applies none of it: the posting is not half listed again with a stale title.
    expect(fixture.rowOf('STEPSTONE', 'abc-123')).toEqual(before);
  });

  it('hands the rejection to the caller unchanged, so it can be reported and classified', async () => {
    const raised = storeUnreachable();

    fixture.failNextWrite(raised);

    // The caller needs the original object: the Prisma error code is what the central error mapping
    // (12.5) turns into the German message and the `ERROR` `posting.writeFailed` entry, and the
    // platform name and Posting_Id of 9.9 are the arguments of this very call.
    await expect(repository.upsert(posting(), FIRST_RUN_ID, FIRST_RUN_STARTED_AT)).rejects.toBe(
      raised,
    );
  });

  it('rejects only the affected Job_Posting and stores the rest of the result list', async () => {
    const list = [
      posting(),
      posting({ postingId: 'def-456', title: 'Projektleiterin Biotech' }),
      posting({ postingId: 'ghi-789', title: 'Studienkoordinatorin' }),
    ];
    const failures: { postingId: string; error: unknown }[] = [];

    await repository.upsert(list[0]!, FIRST_RUN_ID, FIRST_RUN_STARTED_AT);

    const firstPosting = { ...fixture.rowOf('STEPSTONE', 'abc-123')! };

    fixture.failNextWrite(storeUnreachable());

    // The caller's loop, reduced to what 9.9 asks of it: record the failure of one posting and go
    // on with the next one.
    for (const entry of list.slice(1)) {
      try {
        await repository.upsert(entry, FIRST_RUN_ID, FIRST_RUN_STARTED_AT);
      } catch (error: unknown) {
        failures.push({ postingId: entry.postingId, error });
      }
    }

    // Exactly the call that carried the failing Posting_Id rejected, which is what makes the
    // Log_Stream report of 9.9 attributable to one platform and one Posting_Id.
    expect(failures).toHaveLength(1);
    expect(failures[0]?.postingId).toBe('def-456');

    // The posting stored before the failure is untouched, the one after it is stored normally.
    expect(fixture.rowOf('STEPSTONE', 'abc-123')).toEqual(firstPosting);
    expect(fixture.rowOf('STEPSTONE', 'def-456')).toBeUndefined();
    expect(fixture.rowOf('STEPSTONE', 'ghi-789')).toMatchObject({
      title: 'Studienkoordinatorin',
      firstSeenRunId: FIRST_RUN_ID,
      postingStatus: 'LISTED',
    });
  });

  it('stores a Job_Posting normally when it is retried after a rejected write', async () => {
    fixture.failNextWrite(storeUnreachable());

    await expect(repository.upsert(posting(), FIRST_RUN_ID, FIRST_RUN_STARTED_AT)).rejects.toThrow(
      "Can't reach database server",
    );

    const result = await repository.upsert(posting(), FIRST_RUN_ID, FIRST_RUN_STARTED_AT);

    // Nothing about the failure is sticky, and the retry is still the first recording of this
    // Job_Posting by this Scrape_Run — 9.4 holds across the rejected attempt because every
    // timestamp comes from the run start time rather than from a clock.
    expect(result).toEqual({ postingId: 'abc-123', created: true, contentChanged: false });
    expect(fixture.rows.size).toBe(1);
    expect(fixture.rowOf('STEPSTONE', 'abc-123')).toMatchObject({
      title: 'Projektmanagerin Pharma',
      firstSeenAt: FIRST_RUN_STARTED_AT,
      lastSeenAt: FIRST_RUN_STARTED_AT,
      firstSeenRunId: FIRST_RUN_ID,
      postingStatus: 'LISTED',
    });
  });
});
