/**
 * The Interest_Flag write in the Posting_Store (10.10, 10.14).
 *
 * What the write has to achieve is one sentence of 10.10: the marking is stored persistently and the
 * Posting_Status stays as it was. The Glossary makes the same point from the other side — the
 * marking is independent of the Posting_Status — so both directions are asserted on a Job_Posting
 * that is "no longer listed" as well, where a write that silently reset the status would be invisible
 * in the user's default view.
 *
 * The withdrawal of 10.10 is not a second mechanism: it is this write with the other value of the
 * closed list, which is why both values are exercised in both directions.
 *
 * Nothing is asserted here about the hiding of 10.11. It is a filter default in
 * `../posting-page-query.ts` and is asserted there; this write stores no hint of it.
 *
 * Requirements: 10.10, 10.14.
 */

import { INTEREST_FLAGS, type InterestFlag } from '@job-scraper/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { JobPosting } from '../../prisma/prisma.types';
import { PostingRepository } from '../posting.repository';
import { createPostingStore, type PostingStoreFixture } from './job-posting-delegate.fixture';

const CHECKED_AT = new Date('2026-03-02T08:05:00.000Z');

/**
 * A Job_Posting a Scrape_Run recorded, the Relevance_Service assessed and the commute stage
 * enriched.
 *
 * Every column outside the marking is seeded so that a write touching one of them would be visible
 * rather than hidden behind a column default.
 */
const seedEnriched = (
  fixture: PostingStoreFixture,
  overrides: Partial<JobPosting> = {},
): JobPosting =>
  fixture.seed({
    platform: 'STEPSTONE',
    postingId: 'abc-123',
    title: 'Projektmanagerin Pharma',
    sourceUrl: 'https://www.stepstone.de/stellenangebote--abc-123',
    firstSeenRunId: 'run-1',
    firstSeenAt: new Date('2026-03-02T08:00:00.000Z'),
    lastSeenAt: new Date('2026-03-09T08:00:00.000Z'),
    postingStatus: 'LISTED',
    interestFlag: 'UNMARKED',
    relevanceVerdict: 'RELEVANT',
    relevanceReason: 'Passt zum Suchprofil.',
    relevanceModel: 'claude-sonnet-4-5',
    relevanceAssessedAt: CHECKED_AT,
    relevanceSetManually: true,
    contentHash: 'hash-1',
    relevanceContentHash: 'hash-1',
    bicycleMinutes: 41,
    transitMinutes: 22,
    bestCommuteMinutes: 22,
    bestCommuteMode: 'TRANSIT',
    commutePrecision: 'EXACT',
    commuteLocationInput: 'München',
    commuteCheckedAt: CHECKED_AT,
    ...overrides,
  });

describe('PostingRepository.setInterestFlag', () => {
  let fixture: PostingStoreFixture;
  let repository: PostingRepository;

  beforeEach(() => {
    fixture = createPostingStore();
    repository = new PostingRepository(fixture.store);
  });

  it('stores the marking the user set and answers with the stored row (10.10)', async () => {
    const seeded = seedEnriched(fixture);

    const returned = await repository.setInterestFlag(seeded.id, 'NOT_INTERESTING');

    expect(returned.interestFlag).toBe('NOT_INTERESTING');

    // The answer of the mutation is the stored state, not a projection of the arguments.
    expect(fixture.rows.get(seeded.id)).toEqual(returned);
    expect(fixture.writes).toEqual([{ kind: 'update', id: seeded.id }]);
  });

  it('withdraws a marking with the other value of the closed list (10.10)', async () => {
    const seeded = seedEnriched(fixture, { interestFlag: 'NOT_INTERESTING' });

    const returned = await repository.setInterestFlag(seeded.id, 'UNMARKED');

    expect(returned.interestFlag).toBe('UNMARKED');
    expect(fixture.rows.get(seeded.id)?.interestFlag).toBe('UNMARKED');
  });

  it.each(INTEREST_FLAGS)(
    'leaves the Posting_Status of a listed Job_Posting untouched when storing %s (10.10)',
    async (flag: InterestFlag) => {
      const seeded = seedEnriched(fixture);

      const returned = await repository.setInterestFlag(seeded.id, flag);

      expect(returned.postingStatus).toBe('LISTED');
    },
  );

  it.each(INTEREST_FLAGS)(
    'marks a Job_Posting that is no longer listed without reviving it (%s, Glossary)',
    async (flag: InterestFlag) => {
      const seeded = seedEnriched(fixture, { postingStatus: 'NO_LONGER_LISTED' });

      const returned = await repository.setInterestFlag(seeded.id, flag);

      expect(returned.interestFlag).toBe(flag);
      expect(returned.postingStatus).toBe('NO_LONGER_LISTED');
    },
  );

  it('leaves every column outside the marking alone', async () => {
    const seeded = seedEnriched(fixture);

    const returned = await repository.setInterestFlag(seeded.id, 'NOT_INTERESTING');

    // The retrieval's fields and the lifecycle of 9.3 and 11.8.
    expect(returned).toMatchObject({
      platform: 'STEPSTONE',
      postingId: 'abc-123',
      title: 'Projektmanagerin Pharma',
      firstSeenRunId: 'run-1',
      firstSeenAt: seeded.firstSeenAt,
      lastSeenAt: seeded.lastSeenAt,
      contentHash: 'hash-1',
    });

    // What the two enrichment stages own (15.1, 15.15, 8.2).
    expect(returned).toMatchObject({
      relevanceVerdict: 'RELEVANT',
      relevanceReason: 'Passt zum Suchprofil.',
      relevanceModel: 'claude-sonnet-4-5',
      relevanceAssessedAt: CHECKED_AT,
      relevanceSetManually: true,
      relevanceContentHash: 'hash-1',
      bicycleMinutes: 41,
      transitMinutes: 22,
      bestCommuteMinutes: 22,
      bestCommuteMode: 'TRANSIT',
      commutePrecision: 'EXACT',
      commuteLocationInput: 'München',
      commuteCheckedAt: CHECKED_AT,
    });
  });

  it('re-applying the stored value writes it again and changes nothing', async () => {
    const seeded = seedEnriched(fixture, { interestFlag: 'NOT_INTERESTING' });

    const returned = await repository.setInterestFlag(seeded.id, 'NOT_INTERESTING');

    expect(returned).toEqual(seeded);
  });

  it('persists nothing when the Posting_Store rejects the write (10.14)', async () => {
    const seeded = seedEnriched(fixture);
    const rejection = Object.assign(new Error('Server has closed the connection.'), {
      code: 'P1017',
    });

    fixture.failNextWrite(rejection);

    await expect(repository.setInterestFlag(seeded.id, 'NOT_INTERESTING')).rejects.toBe(rejection);

    // The Job_Posting keeps the marking it had, which is what lets it stay in the default view.
    expect(fixture.rows.get(seeded.id)).toEqual(seeded);
    expect(fixture.rows.get(seeded.id)?.interestFlag).toBe('UNMARKED');
    expect(fixture.writes).toEqual([]);
  });

  it('rejects an identifier no Job_Posting carries and writes nothing', async () => {
    const seeded = seedEnriched(fixture);

    await expect(repository.setInterestFlag('posting-unknown', 'NOT_INTERESTING')).rejects.toThrow(
      /posting-unknown/,
    );

    expect(fixture.rows.get(seeded.id)).toEqual(seeded);
    expect(fixture.writes).toEqual([]);
  });
});
