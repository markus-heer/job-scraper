/**
 * The decisions the manual override makes before it writes (2.5, 15.3, 15.15).
 *
 * Two of them, and both are about the German note the user may give: it is stored trimmed with an
 * empty text collapsed to "no reason", and a text beyond the length of 15.3 is rejected with a
 * German sentence *in front of* the write, so the rejected request persists nothing instead of
 * running into the column's bound.
 *
 * The repository is a recording stand-in here: what it stores is its own test's subject, while this
 * one is about what reaches it.
 *
 * Requirements: 2.5, 15.3, 15.15.
 */

import type { RelevanceVerdict } from '@job-scraper/domain';
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';

import type { JobPosting } from '../../prisma/prisma.types';
import { RELEVANCE_REASON_MAX_LENGTH } from '../../relevance/relevance-assessor.port';
import type { InterestFlagWriter, ManualVerdictWriter } from '../posting.service';
import { PostingService } from '../posting.service';

interface RecordedWrite {
  readonly id: string;
  readonly verdict: RelevanceVerdict;
  readonly reasonDe: string | null;
}

const writes: RecordedWrite[] = [];

/** The written row, reduced to what this test needs; the repository's own test asserts the rest. */
const storedRow = (write: RecordedWrite): JobPosting =>
  ({
    id: write.id,
    relevanceVerdict: write.verdict,
    relevanceReason: write.reasonDe,
    relevanceSetManually: true,
  }) as JobPosting;

const repository: InterestFlagWriter & ManualVerdictWriter = {
  // The Interest_Flag write has its own suite; this stand-in only has to satisfy the type.
  setInterestFlag: () => Promise.reject(new Error('not the subject of this test file')),
  setRelevanceVerdictManually: (id, verdict, reasonDe) => {
    const write: RecordedWrite = { id, verdict, reasonDe };

    writes.push(write);

    return Promise.resolve(storedRow(write));
  },
};

let service: PostingService;

beforeEach(() => {
  writes.length = 0;
  service = new PostingService(repository);
});

describe('PostingService.setRelevanceVerdictManually', () => {
  it('forwards the verdict and the trimmed reason to the single writer (15.15)', async () => {
    const stored = await service.setRelevanceVerdictManually(
      'posting-1',
      'NOT_RELEVANT',
      '  Zeitarbeit statt Festanstellung.  ',
    );

    expect(writes).toEqual([
      {
        id: 'posting-1',
        verdict: 'NOT_RELEVANT',
        reasonDe: 'Zeitarbeit statt Festanstellung.',
      },
    ]);
    expect(stored.relevanceSetManually).toBe(true);
  });

  it.each([null, '', '   '])('stores no reason for the note %o', async (reasonDe) => {
    await service.setRelevanceVerdictManually('posting-1', 'RELEVANT', reasonDe);

    expect(writes.at(0)?.reasonDe).toBeNull();
  });

  it('accepts a reason of exactly the stored length (15.3)', async () => {
    const reason = 'ä'.repeat(RELEVANCE_REASON_MAX_LENGTH);

    await service.setRelevanceVerdictManually('posting-1', 'RELEVANT', reason);

    expect(writes.at(0)?.reasonDe).toBe(reason);
  });

  it('rejects one character more with a German sentence and writes nothing (2.5, 15.3)', async () => {
    const reason = 'ä'.repeat(RELEVANCE_REASON_MAX_LENGTH + 1);
    const rejected = service.setRelevanceVerdictManually('posting-1', 'RELEVANT', reason);

    await expect(rejected).rejects.toBeInstanceOf(BadRequestException);

    // The cause with both numbers, and exactly one recommended next step (2.5).
    await expect(rejected).rejects.toThrow(/301 Zeichen zu lang/);
    await expect(rejected).rejects.toThrow(/höchstens 300 Zeichen/);
    await expect(rejected).rejects.toThrow(/Bitte die Begründung kürzen und erneut speichern\./);

    expect(writes).toEqual([]);
  });

  it('measures the reason after trimming, so surrounding whitespace is not a rejection', async () => {
    const reason = `  ${'ä'.repeat(RELEVANCE_REASON_MAX_LENGTH)}  `;

    await service.setRelevanceVerdictManually('posting-1', 'UNCERTAIN', reason);

    expect(writes.at(0)?.reasonDe).toHaveLength(RELEVANCE_REASON_MAX_LENGTH);
  });
});
