/**
 * Unit tests for the "no longer listed" sweep of the Posting_Store (9.5, 9.7, 9.8).
 *
 * Two questions, kept apart on purpose:
 *
 * - **What the sweep marks when it runs.** Exactly the stored postings of that Platform absent from
 *   the result list, with every other field of those records retained.
 * - **When it runs at all.** Only with both the Run_Outcome and the Platform_Status at "completed".
 *   The gate is enumerated over every other Run_Outcome and every other Platform_Status rather than
 *   spot-checked, because each of those values reaches the sweep from a different failure path and a
 *   gate that leaks for one of them loses user-visible postings.
 *
 * Property-based coverage of the gated set difference is Property 9 (task 11.6); the cases here pin
 * the concrete examples, the round trip with the upsert and the boundary a generator hits rarely —
 * the empty result list.
 */

import { PLATFORM_STATUSES, RUN_OUTCOMES } from '@job-scraper/domain';
import type { NormalizedJobPosting } from '@job-scraper/scrapers';
import { beforeEach, describe, expect, it } from 'vitest';

import type { JobPosting, PlatformStatus, RunOutcome } from '../../prisma/prisma.types';
import { PostingRepository } from '../posting.repository';
import { createPostingStore, type PostingStoreFixture } from './job-posting-delegate.fixture';

const FIRST_RUN_ID = 'run-1';
const SECOND_RUN_ID = 'run-2';
const FIRST_RUN_STARTED_AT = new Date('2026-03-02T08:00:00.000Z');
const SECOND_RUN_STARTED_AT = new Date('2026-03-09T08:00:00.000Z');

/** Every Platform_Status other than "completed": the whole right-hand side of 9.7. */
const NOT_COMPLETED_PLATFORM_STATUSES: readonly PlatformStatus[] = PLATFORM_STATUSES.filter(
  (status) => status !== 'COMPLETED',
);

/** Every Run_Outcome other than "completed", plus the still-running run (`null`). */
const NOT_COMPLETED_RUN_OUTCOMES: readonly (RunOutcome | null)[] = [
  ...RUN_OUTCOMES.filter((outcome) => outcome !== 'COMPLETED'),
  null,
];

/** Seeds a Job_Posting of the earlier Scrape_Run, listed and enriched. */
const seedListed = (fixture: PostingStoreFixture, postingId: string): JobPosting =>
  fixture.seed({
    platform: 'STEPSTONE',
    postingId,
    title: `Projektmanagerin ${postingId}`,
    sourceUrl: `https://www.stepstone.de/stellenangebote--${postingId}`,
    descriptionText: 'Sie steuern Projekte im Bereich Life Science.',
    employer: 'Beispiel Pharma GmbH',
    workLocation: 'München',
    publishedAt: new Date('2026-02-27T00:00:00.000Z'),
    firstSeenRunId: FIRST_RUN_ID,
    firstSeenAt: FIRST_RUN_STARTED_AT,
    lastSeenAt: FIRST_RUN_STARTED_AT,
    postingStatus: 'LISTED',
    interestFlag: 'NOT_INTERESTING',
    relevanceVerdict: 'RELEVANT',
    relevanceReason: 'Passt zum Profil.',
    relevanceSetManually: true,
    relevanceRank: 0,
    bestCommuteMinutes: 22,
    bestCommuteMode: 'BICYCLE',
    commutePrecision: 'EXACT',
    commuteLocationInput: 'München',
  });

/** The normalized Job_Posting a later Scrape_Run would hand to the upsert. */
const posting = (overrides: Partial<NormalizedJobPosting> = {}): NormalizedJobPosting => ({
  platform: 'STEPSTONE',
  postingId: 'abc-123',
  title: 'Projektmanagerin abc-123',
  employer: 'Beispiel Pharma GmbH',
  workLocation: 'München',
  publishedAt: new Date('2026-02-27T00:00:00.000Z'),
  sourceUrl: 'https://www.stepstone.de/stellenangebote--abc-123',
  descriptionText: 'Sie steuern Projekte im Bereich Life Science.',
  ...overrides,
});

/** The status of each stored row, keyed by Posting_Id, so a failure names the posting it means. */
const statusesOf = (fixture: PostingStoreFixture): Record<string, string> =>
  Object.fromEntries(
    [...fixture.rows.values()].map((row) => [
      `${row.platform}/${row.postingId}`,
      row.postingStatus,
    ]),
  );

describe('PostingRepository.markAbsentAsNoLongerListed', () => {
  let fixture: PostingStoreFixture;
  let repository: PostingRepository;

  beforeEach(() => {
    fixture = createPostingStore();
    repository = new PostingRepository(fixture.store);
  });

  it('marks exactly the stored postings absent from the result list', async () => {
    seedListed(fixture, 'abc-123');
    seedListed(fixture, 'def-456');
    seedListed(fixture, 'ghi-789');

    const swept = await repository.markAbsentAsNoLongerListed({
      platform: 'STEPSTONE',
      seenPostingIds: ['abc-123'],
      runOutcome: 'COMPLETED',
      platformStatus: 'COMPLETED',
    });

    // 9.5: the set difference "stored minus seen", and nothing else.
    expect(swept).toBe(2);
    expect(statusesOf(fixture)).toEqual({
      'STEPSTONE/abc-123': 'LISTED',
      'STEPSTONE/def-456': 'NO_LONGER_LISTED',
      'STEPSTONE/ghi-789': 'NO_LONGER_LISTED',
    });
  });

  it('retains every other field of a swept Job_Posting', async () => {
    const before = { ...seedListed(fixture, 'def-456') };

    await repository.markAbsentAsNoLongerListed({
      platform: 'STEPSTONE',
      seenPostingIds: [],
      runOutcome: 'COMPLETED',
      platformStatus: 'COMPLETED',
    });

    // 9.5: the Posting_Status is the only column the sweep may move. Compared as a whole row, so a
    // later task adding a column cannot make this assertion pass by omission.
    expect(fixture.rowOf('STEPSTONE', 'def-456')).toEqual({
      ...before,
      postingStatus: 'NO_LONGER_LISTED',
    });
  });

  it('sweeps every stored Job_Posting of the Platform when the result list is empty', async () => {
    seedListed(fixture, 'abc-123');
    seedListed(fixture, 'def-456');

    const swept = await repository.markAbsentAsNoLongerListed({
      platform: 'STEPSTONE',
      seenPostingIds: [],
      runOutcome: 'COMPLETED',
      platformStatus: 'COMPLETED',
    });

    // A completed retrieval that found nothing is evidence, not a missing result list.
    expect(swept).toBe(2);
    expect(statusesOf(fixture)).toEqual({
      'STEPSTONE/abc-123': 'NO_LONGER_LISTED',
      'STEPSTONE/def-456': 'NO_LONGER_LISTED',
    });
  });

  it('leaves the Job_Posting of every other Platform untouched', async () => {
    seedListed(fixture, 'abc-123');
    fixture.seed({
      platform: 'JOBVECTOR',
      postingId: 'abc-123',
      title: 'Projektleiterin Biotech',
      sourceUrl: 'https://www.jobvector.de/stellenangebot-abc-123',
      firstSeenRunId: FIRST_RUN_ID,
      postingStatus: 'LISTED',
    });

    const swept = await repository.markAbsentAsNoLongerListed({
      platform: 'STEPSTONE',
      seenPostingIds: [],
      runOutcome: 'COMPLETED',
      platformStatus: 'COMPLETED',
    });

    // 9.5 scopes the sweep to "that Platform"; the same Posting_Id elsewhere is a different record.
    expect(swept).toBe(1);
    expect(statusesOf(fixture)).toEqual({
      'STEPSTONE/abc-123': 'NO_LONGER_LISTED',
      'JOBVECTOR/abc-123': 'LISTED',
    });
  });

  it('recognizes a seen Posting_Id that arrives padded with whitespace', async () => {
    seedListed(fixture, 'abc-123');

    const swept = await repository.markAbsentAsNoLongerListed({
      platform: 'STEPSTONE',
      seenPostingIds: ['  abc-123\n'],
      runOutcome: 'COMPLETED',
      platformStatus: 'COMPLETED',
    });

    // 9.2: the key is compared after trimming, here as well as in the upsert.
    expect(swept).toBe(0);
    expect(fixture.rowOf('STEPSTONE', 'abc-123')?.postingStatus).toBe('LISTED');
  });

  it('changes nothing on a second sweep over the same state', async () => {
    seedListed(fixture, 'abc-123');

    const input = {
      platform: 'STEPSTONE',
      seenPostingIds: [],
      runOutcome: 'COMPLETED',
      platformStatus: 'COMPLETED',
    } as const;

    expect(await repository.markAbsentAsNoLongerListed(input)).toBe(1);

    const writesAfterFirstSweep = fixture.writes.length;

    expect(await repository.markAbsentAsNoLongerListed(input)).toBe(0);
    expect(fixture.writes.length).toBe(writesAfterFirstSweep);
    expect(fixture.rowOf('STEPSTONE', 'abc-123')?.postingStatus).toBe('NO_LONGER_LISTED');
  });

  it.each(NOT_COMPLETED_RUN_OUTCOMES)(
    'marks no Job_Posting when the Run_Outcome is %s',
    async (runOutcome) => {
      seedListed(fixture, 'abc-123');

      const swept = await repository.markAbsentAsNoLongerListed({
        platform: 'STEPSTONE',
        seenPostingIds: [],
        runOutcome,
        platformStatus: 'COMPLETED',
      });

      // 9.7: a cancelled or still running Scrape_Run is no evidence that a posting is gone.
      expect(swept).toBe(0);
      expect(fixture.writes).toHaveLength(0);
      expect(fixture.rowOf('STEPSTONE', 'abc-123')?.postingStatus).toBe('LISTED');
    },
  );

  it.each(NOT_COMPLETED_PLATFORM_STATUSES)(
    'marks no Job_Posting when the Platform_Status is %s',
    async (platformStatus) => {
      seedListed(fixture, 'abc-123');

      const swept = await repository.markAbsentAsNoLongerListed({
        platform: 'STEPSTONE',
        seenPostingIds: [],
        runOutcome: 'COMPLETED',
        platformStatus,
      });

      // 9.7: a truncated retrieval — blocked, signed out, rate limited, timed out — keeps every
      // stored Posting_Status, which also covers the Partial_Result of 7.7.
      expect(swept).toBe(0);
      expect(fixture.writes).toHaveLength(0);
      expect(fixture.rowOf('STEPSTONE', 'abc-123')?.postingStatus).toBe('LISTED');
    },
  );

  it('keeps a Partial_Result of a signed-out Platform listed and sweeps it after a completed run', async () => {
    seedListed(fixture, 'abc-123');
    seedListed(fixture, 'def-456');

    // The run read the first posting before the sign-in prompt, so the second one is missing from a
    // result list that is not evidence of anything (7.7).
    await repository.markAbsentAsNoLongerListed({
      platform: 'STEPSTONE',
      seenPostingIds: ['abc-123'],
      runOutcome: 'COMPLETED',
      platformStatus: 'SIGN_IN_REQUIRED',
    });

    expect(statusesOf(fixture)).toEqual({
      'STEPSTONE/abc-123': 'LISTED',
      'STEPSTONE/def-456': 'LISTED',
    });

    // The next run gets through, and now the absence counts.
    await repository.markAbsentAsNoLongerListed({
      platform: 'STEPSTONE',
      seenPostingIds: ['abc-123'],
      runOutcome: 'COMPLETED',
      platformStatus: 'COMPLETED',
    });

    expect(statusesOf(fixture)).toEqual({
      'STEPSTONE/abc-123': 'LISTED',
      'STEPSTONE/def-456': 'NO_LONGER_LISTED',
    });
  });

  it('lists a swept Job_Posting again when it reappears, keeping its first recording', async () => {
    seedListed(fixture, 'abc-123');

    await repository.markAbsentAsNoLongerListed({
      platform: 'STEPSTONE',
      seenPostingIds: [],
      runOutcome: 'COMPLETED',
      platformStatus: 'COMPLETED',
    });

    expect(fixture.rowOf('STEPSTONE', 'abc-123')?.postingStatus).toBe('NO_LONGER_LISTED');

    const result = await repository.upsert(posting(), SECOND_RUN_ID, SECOND_RUN_STARTED_AT);

    // 9.8: the round trip, with the time of first recording and the recording run untouched.
    expect(result.created).toBe(false);

    const stored = fixture.rowOf('STEPSTONE', 'abc-123');

    expect(stored?.postingStatus).toBe('LISTED');
    expect(stored?.firstSeenAt).toEqual(FIRST_RUN_STARTED_AT);
    expect(stored?.firstSeenRunId).toBe(FIRST_RUN_ID);
    expect(stored?.lastSeenAt).toEqual(SECOND_RUN_STARTED_AT);
    // What the user owns survives the round trip as well (10.10, 15.15).
    expect(stored?.interestFlag).toBe('NOT_INTERESTING');
    expect(stored?.relevanceSetManually).toBe(true);
  });

  it('leaves every stored Job_Posting untouched when the Posting_Store rejects the sweep', async () => {
    const before = { ...seedListed(fixture, 'abc-123') };

    fixture.failNextWrite(new Error('connection terminated'));

    // 9.9: the failure reaches the caller, which reports it to the Log_Stream and carries on.
    await expect(
      repository.markAbsentAsNoLongerListed({
        platform: 'STEPSTONE',
        seenPostingIds: [],
        runOutcome: 'COMPLETED',
        platformStatus: 'COMPLETED',
      }),
    ).rejects.toThrow('connection terminated');
    expect(fixture.rowOf('STEPSTONE', 'abc-123')).toEqual(before);
  });
});
