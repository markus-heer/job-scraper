/**
 * The manual Relevance_Verdict override in the Posting_Store (15.15).
 *
 * What the write has to achieve is one sentence of 15.15: the manual assessment is stored, it is
 * marked as set manually, and every following Scrape_Run keeps it in place of a service assessment.
 * The first two are columns and are asserted directly; the third is the content hash gate, so the
 * real `needsRelevanceAssessment` is called on the row this write produced instead of a copy of its
 * condition — a gate that read the flag differently from the way the write sets it would otherwise
 * pass both tests separately.
 *
 * The denormalized rank of 10.7 is asserted for every verdict value, which is the assertion the
 * design asks for so that `relevanceRank` and `relevanceVerdict` cannot drift apart.
 *
 * Requirements: 10.3, 10.7, 15.15.
 */

import { RELEVANCE_RANK, RELEVANCE_VERDICTS, type RelevanceVerdict } from '@job-scraper/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { JobPosting } from '../../prisma/prisma.types';
import { needsRelevanceAssessment } from '../../relevance/content-hash-gate';
import { PostingRepository } from '../posting.repository';
import { createPostingStore, type PostingStoreFixture } from './job-posting-delegate.fixture';

const ASSESSED_AT = new Date('2026-03-02T08:05:00.000Z');

/**
 * A Job_Posting that a Scrape_Run recorded and the Relevance_Service already assessed, enriched with
 * a commute result and marked by the user.
 *
 * Everything outside the relevance group is seeded so that a write touching it would be visible, and
 * the stored assessment is seeded so that the override has something to replace.
 */
const seedAssessed = (fixture: PostingStoreFixture): JobPosting =>
  fixture.seed({
    platform: 'STEPSTONE',
    postingId: 'abc-123',
    title: 'Projektmanagerin Pharma',
    sourceUrl: 'https://www.stepstone.de/stellenangebote--abc-123',
    firstSeenRunId: 'run-1',
    firstSeenAt: new Date('2026-03-02T08:00:00.000Z'),
    lastSeenAt: new Date('2026-03-09T08:00:00.000Z'),
    interestFlag: 'NOT_INTERESTING',
    relevanceVerdict: 'NOT_RELEVANT',
    relevanceReason: 'Fachgebiet passt nicht zum Suchprofil.',
    relevanceModel: 'claude-sonnet-4-5',
    relevanceAssessedAt: ASSESSED_AT,
    relevanceRank: RELEVANCE_RANK.NOT_RELEVANT,
    relevanceSetManually: false,
    contentHash: 'hash-1',
    relevanceContentHash: 'hash-1',
    bicycleMinutes: 41,
    bestCommuteMinutes: 22,
    bestCommuteMode: 'TRANSIT',
    commutePrecision: 'EXACT',
    commuteLocationInput: 'München',
    commuteCheckedAt: ASSESSED_AT,
  });

describe('PostingRepository.setRelevanceVerdictManually', () => {
  let fixture: PostingStoreFixture;
  let repository: PostingRepository;

  beforeEach(() => {
    fixture = createPostingStore();
    repository = new PostingRepository(fixture.store);
  });

  it('stores the verdict the user set and marks it as set manually (15.15)', async () => {
    const seeded = seedAssessed(fixture);

    const returned = await repository.setRelevanceVerdictManually(
      seeded.id,
      'RELEVANT',
      'Passt doch: Seniorität und Arbeitsort stimmen.',
    );

    expect(returned).toMatchObject({
      relevanceVerdict: 'RELEVANT',
      relevanceReason: 'Passt doch: Seniorität und Arbeitsort stimmen.',
      relevanceSetManually: true,
    });

    // The answer of the mutation is the stored state, not a projection of the arguments.
    expect(fixture.rows.get(seeded.id)).toEqual(returned);
    expect(fixture.writes).toEqual([{ kind: 'update', id: seeded.id }]);
  });

  it('stores no reason where the user gave none', async () => {
    const seeded = seedAssessed(fixture);

    const returned = await repository.setRelevanceVerdictManually(seeded.id, 'UNCERTAIN', null);

    expect(returned.relevanceReason).toBeNull();
    expect(returned.relevanceVerdict).toBe('UNCERTAIN');
  });

  it.each(RELEVANCE_VERDICTS)(
    'derives the sort key of 10.7 from the verdict %s instead of taking it from the caller',
    async (verdict: RelevanceVerdict) => {
      const seeded = seedAssessed(fixture);

      const returned = await repository.setRelevanceVerdictManually(seeded.id, verdict, null);

      expect(returned.relevanceRank).toBe(RELEVANCE_RANK[verdict]);
    },
  );

  it('clears the model and the assessment time, because no model produced this verdict (10.3)', async () => {
    const seeded = seedAssessed(fixture);

    const returned = await repository.setRelevanceVerdictManually(seeded.id, 'RELEVANT', null);

    expect(returned.relevanceModel).toBeNull();
    expect(returned.relevanceAssessedAt).toBeNull();
  });

  it('leaves every column outside the manual verdict alone', async () => {
    const seeded = seedAssessed(fixture);

    const returned = await repository.setRelevanceVerdictManually(seeded.id, 'RELEVANT', null);

    // The retrieval's fields and the lifecycle of 9.3 and 11.8.
    expect(returned).toMatchObject({
      platform: 'STEPSTONE',
      postingId: 'abc-123',
      title: 'Projektmanagerin Pharma',
      firstSeenRunId: 'run-1',
      firstSeenAt: seeded.firstSeenAt,
      lastSeenAt: seeded.lastSeenAt,
      postingStatus: 'LISTED',
      contentHash: 'hash-1',
      relevanceContentHash: 'hash-1',
    });

    // What the user and the commute stage own (10.10, 8.2).
    expect(returned).toMatchObject({
      interestFlag: 'NOT_INTERESTING',
      bicycleMinutes: 41,
      bestCommuteMinutes: 22,
      bestCommuteMode: 'TRANSIT',
      commutePrecision: 'EXACT',
      commuteLocationInput: 'München',
      commuteCheckedAt: ASSESSED_AT,
    });
  });

  it('keeps the Relevance_Service away from the Job_Posting afterwards, changed content or not (15.15)', async () => {
    const seeded = seedAssessed(fixture);

    const overridden = await repository.setRelevanceVerdictManually(seeded.id, 'RELEVANT', null);

    expect(needsRelevanceAssessment(overridden)).toBe(false);

    // The same row after a later Scrape_Run rewrote the content: the gate still refuses, which is
    // what makes the manual verdict survive rather than be replaced (15.6 against 15.15).
    expect(needsRelevanceAssessment({ ...overridden, contentHash: 'hash-2' })).toBe(false);
  });

  it('persists nothing when the Posting_Store rejects the write', async () => {
    const seeded = seedAssessed(fixture);
    const rejection = Object.assign(new Error('Server has closed the connection.'), {
      code: 'P1017',
    });

    fixture.failNextWrite(rejection);

    await expect(
      repository.setRelevanceVerdictManually(seeded.id, 'RELEVANT', 'Passt doch.'),
    ).rejects.toBe(rejection);

    expect(fixture.rows.get(seeded.id)).toEqual(seeded);
    expect(fixture.writes).toEqual([]);
  });

  it('rejects an identifier no Job_Posting carries and writes nothing', async () => {
    const seeded = seedAssessed(fixture);

    await expect(
      repository.setRelevanceVerdictManually('posting-unknown', 'RELEVANT', null),
    ).rejects.toThrow(/posting-unknown/);

    expect(fixture.rows.get(seeded.id)).toEqual(seeded);
    expect(fixture.writes).toEqual([]);
  });
});
