/**
 * Unit tests for the upsert path of the Posting_Store (9.2, 9.3, 9.8, 11.8).
 *
 * The three field groups of 9.3 are what every case below is about, so they are asserted
 * separately rather than through one big object comparison: a test that compares whole rows passes
 * for the wrong reason as soon as a later task adds a column.
 *
 * Property-based coverage of idempotence and preservation belongs to tasks 11.4 and 11.5; the cases
 * here pin the concrete examples and the branches a generator would only reach by accident — the
 * whitespace-insensitive key and the lost insert race.
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

describe('PostingRepository.upsert', () => {
  let fixture: PostingStoreFixture;
  let repository: PostingRepository;

  beforeEach(() => {
    fixture = createPostingStore();
    repository = new PostingRepository(fixture.store);
  });

  it('stores an unknown Job_Posting with the lifecycle values of the recording run', async () => {
    const result = await repository.upsert(posting(), FIRST_RUN_ID, FIRST_RUN_STARTED_AT);

    expect(result).toEqual({ postingId: 'abc-123', created: true, contentChanged: false });

    const stored = fixture.rowOf('STEPSTONE', 'abc-123');

    expect(stored).toBeDefined();
    // The eight fields of 6.3 as the Platform showed them.
    expect(stored).toMatchObject({
      platform: 'STEPSTONE',
      postingId: 'abc-123',
      title: 'Projektmanagerin Pharma',
      employer: 'Beispiel Pharma GmbH',
      workLocation: 'München',
      publishedAt: new Date('2026-02-27T00:00:00.000Z'),
      sourceUrl: 'https://www.stepstone.de/stellenangebote--abc-123',
      descriptionText: 'Sie steuern Projekte im Bereich Life Science.',
    });
    // 9.1 and 11.1: both times come from the run start time, not from a clock.
    expect(stored?.firstSeenAt).toEqual(FIRST_RUN_STARTED_AT);
    expect(stored?.lastSeenAt).toEqual(FIRST_RUN_STARTED_AT);
    expect(stored?.firstSeenRunId).toBe(FIRST_RUN_ID);
    expect(stored?.postingStatus).toBe('LISTED');
    expect(stored?.interestFlag).toBe('UNMARKED');
    expect(stored?.contentHash).toBe(
      computeContentHash(
        'Projektmanagerin Pharma',
        'Sie steuern Projekte im Bereich Life Science.',
      ),
    );
    // 10.7: the denormalized sort key agrees with the default Relevance_Verdict.
    expect(stored?.relevanceVerdict).toBe('NOT_ASSESSED');
    expect(stored?.relevanceRank).toBe(2);
  });

  it('keeps a Job_Posting without optional fields and marks them empty', async () => {
    await repository.upsert(
      posting({ employer: null, workLocation: null, publishedAt: null, descriptionText: null }),
      FIRST_RUN_ID,
      FIRST_RUN_STARTED_AT,
    );

    expect(fixture.rowOf('STEPSTONE', 'abc-123')).toMatchObject({
      employer: null,
      workLocation: null,
      publishedAt: null,
      descriptionText: null,
    });
    expect(fixture.rowOf('STEPSTONE', 'abc-123')?.contentHash).toBe(
      computeContentHash('Projektmanagerin Pharma', null),
    );
  });

  it('overwrites the content fields of a known Job_Posting and moves only the last sighting', async () => {
    await repository.upsert(posting(), FIRST_RUN_ID, FIRST_RUN_STARTED_AT);

    const result = await repository.upsert(
      posting({
        title: 'Senior Projektmanagerin Pharma',
        employer: 'Beispiel Pharma SE',
        workLocation: 'München-Schwabing',
        publishedAt: new Date('2026-03-05T00:00:00.000Z'),
        sourceUrl: 'https://www.stepstone.de/stellenangebote--abc-123-neu',
        descriptionText: 'Sie verantworten klinische Studien.',
      }),
      SECOND_RUN_ID,
      SECOND_RUN_STARTED_AT,
    );

    expect(result).toEqual({ postingId: 'abc-123', created: false, contentChanged: true });
    expect(fixture.rows.size).toBe(1);

    const stored = fixture.rowOf('STEPSTONE', 'abc-123');

    // 9.3 overwrites: the running Scrape_Run wins for everything the Platform shows.
    expect(stored).toMatchObject({
      title: 'Senior Projektmanagerin Pharma',
      employer: 'Beispiel Pharma SE',
      workLocation: 'München-Schwabing',
      publishedAt: new Date('2026-03-05T00:00:00.000Z'),
      sourceUrl: 'https://www.stepstone.de/stellenangebote--abc-123-neu',
      descriptionText: 'Sie verantworten klinische Studien.',
    });
    expect(stored?.lastSeenAt).toEqual(SECOND_RUN_STARTED_AT);
    // 9.3 and 11.8 preserve: the first recording stays with the run that made it.
    expect(stored?.firstSeenAt).toEqual(FIRST_RUN_STARTED_AT);
    expect(stored?.firstSeenRunId).toBe(FIRST_RUN_ID);
  });

  it('reports unchanged content when only the fields outside the hash moved', async () => {
    await repository.upsert(posting(), FIRST_RUN_ID, FIRST_RUN_STARTED_AT);

    const result = await repository.upsert(
      posting({ employer: 'Beispiel Pharma SE', workLocation: 'Garching' }),
      SECOND_RUN_ID,
      SECOND_RUN_STARTED_AT,
    );

    // 15.5: employer and work location are not part of the content hash, so no paid re-assessment.
    expect(result.contentChanged).toBe(false);
    expect(fixture.rowOf('STEPSTONE', 'abc-123')?.employer).toBe('Beispiel Pharma SE');
  });

  it('reports unchanged content when the Platform only reflowed the same text', async () => {
    await repository.upsert(posting(), FIRST_RUN_ID, FIRST_RUN_STARTED_AT);

    const result = await repository.upsert(
      posting({ descriptionText: 'Sie   steuern Projekte\n im Bereich  Life Science.' }),
      SECOND_RUN_ID,
      SECOND_RUN_STARTED_AT,
    );

    expect(result.contentChanged).toBe(false);
  });

  it('preserves the Interest_Flag and a manually set Relevance_Verdict across a sighting', async () => {
    await repository.upsert(posting(), FIRST_RUN_ID, FIRST_RUN_STARTED_AT);

    const stored = fixture.rowOf('STEPSTONE', 'abc-123');

    // What the user and the enrichment stages own (10.10, 15.15, 8.5).
    fixture.rows.set(stored!.id, {
      ...stored!,
      interestFlag: 'NOT_INTERESTING',
      relevanceVerdict: 'RELEVANT',
      relevanceReason: 'Passt zum Profil.',
      relevanceSetManually: true,
      relevanceRank: 0,
      relevanceContentHash: stored!.contentHash,
      bestCommuteMinutes: 22,
      bestCommuteMode: 'BICYCLE',
      commutePrecision: 'EXACT',
      commuteLocationInput: 'München',
    });

    await repository.upsert(
      posting({ title: 'Projektmanagerin Pharma (m/w/d)' }),
      SECOND_RUN_ID,
      SECOND_RUN_STARTED_AT,
    );

    expect(fixture.rowOf('STEPSTONE', 'abc-123')).toMatchObject({
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
  });

  it('resets a Job_Posting that is listed again and keeps its first recording', async () => {
    await repository.upsert(posting(), FIRST_RUN_ID, FIRST_RUN_STARTED_AT);

    const stored = fixture.rowOf('STEPSTONE', 'abc-123');

    fixture.rows.set(stored!.id, { ...stored!, postingStatus: 'NO_LONGER_LISTED' });

    await repository.upsert(posting(), SECOND_RUN_ID, SECOND_RUN_STARTED_AT);

    // 9.8: back to "listed", with the time of first recording untouched.
    expect(fixture.rowOf('STEPSTONE', 'abc-123')?.postingStatus).toBe('LISTED');
    expect(fixture.rowOf('STEPSTONE', 'abc-123')?.firstSeenAt).toEqual(FIRST_RUN_STARTED_AT);
  });

  it('produces the same data state when the same result list is applied twice', async () => {
    const list = [posting(), posting({ postingId: 'def-456', title: 'Projektleiterin Biotech' })];

    for (const entry of list) {
      await repository.upsert(entry, FIRST_RUN_ID, FIRST_RUN_STARTED_AT);
    }

    const afterFirstPass = [...fixture.rows.values()].map((row) => ({ ...row }));
    const secondPass = [] as { created: boolean }[];

    for (const entry of list) {
      secondPass.push(await repository.upsert(entry, FIRST_RUN_ID, FIRST_RUN_STARTED_AT));
    }

    // 9.4: the number of stored Job_Posting and every field value are unchanged.
    expect([...fixture.rows.values()]).toEqual(afterFirstPass);
    expect(secondPass.every((result) => !result.created)).toBe(true);
  });

  it('matches the stored Job_Posting when the Posting_Id arrives padded with whitespace', async () => {
    await repository.upsert(posting(), FIRST_RUN_ID, FIRST_RUN_STARTED_AT);

    const result = await repository.upsert(
      posting({ postingId: '  abc-123\n' }),
      SECOND_RUN_ID,
      SECOND_RUN_STARTED_AT,
    );

    // 9.2: the key is compared after trimming, so no second record appears.
    expect(result).toEqual({ postingId: 'abc-123', created: false, contentChanged: false });
    expect(fixture.rows.size).toBe(1);
  });

  it('holds one record per platform even for an identical Posting_Id', async () => {
    await repository.upsert(posting(), FIRST_RUN_ID, FIRST_RUN_STARTED_AT);
    await repository.upsert(posting({ platform: 'JOBVECTOR' }), FIRST_RUN_ID, FIRST_RUN_STARTED_AT);

    // 9.2: the key is the combination, so the same Posting_Id on two Platform is two Job_Posting.
    expect(fixture.rows.size).toBe(2);
    expect(fixture.rowOf('JOBVECTOR', 'abc-123')).toBeDefined();
  });

  it('falls back to an update when a concurrent write won the insert', async () => {
    // The state a concurrent writer left behind: the record exists, written by the earlier run.
    fixture.seed({
      platform: 'STEPSTONE',
      postingId: 'abc-123',
      title: 'Projektmanagerin Pharma (Erstschreiber)',
      sourceUrl: 'https://www.stepstone.de/stellenangebote--abc-123',
      firstSeenRunId: FIRST_RUN_ID,
      firstSeenAt: FIRST_RUN_STARTED_AT,
      lastSeenAt: FIRST_RUN_STARTED_AT,
      contentHash: computeContentHash('Projektmanagerin Pharma (Erstschreiber)', null),
    });

    // …but this writer read before that insert landed, so it takes the insert branch and collides.
    fixture.staleNextRead();

    const result = await repository.upsert(posting(), SECOND_RUN_ID, SECOND_RUN_STARTED_AT);

    expect(result).toEqual({ postingId: 'abc-123', created: false, contentChanged: true });
    expect(fixture.rows.size).toBe(1);

    const stored = fixture.rowOf('STEPSTONE', 'abc-123');

    expect(stored?.title).toBe('Projektmanagerin Pharma');
    expect(stored?.lastSeenAt).toEqual(SECOND_RUN_STARTED_AT);
    // The lost race must not move the first recording to the losing run.
    expect(stored?.firstSeenRunId).toBe(FIRST_RUN_ID);
  });

  it('leaves the stored Job_Posting untouched when the Posting_Store rejects the write', async () => {
    await repository.upsert(posting(), FIRST_RUN_ID, FIRST_RUN_STARTED_AT);

    const before = { ...fixture.rowOf('STEPSTONE', 'abc-123')! };

    fixture.failNextWrite(new Error('connection terminated'));

    // 9.9: the failure reaches the caller, which reports it and continues with the next posting.
    await expect(
      repository.upsert(posting({ title: 'Andere Rolle' }), SECOND_RUN_ID, SECOND_RUN_STARTED_AT),
    ).rejects.toThrow('connection terminated');
    expect(fixture.rowOf('STEPSTONE', 'abc-123')).toEqual(before);
  });
});
