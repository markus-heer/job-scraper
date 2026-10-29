/**
 * What the service adds to the Interest_Flag write (10.10, 10.14).
 *
 * Almost nothing in the success case, and that is the assertion: the value is forwarded unchanged,
 * because it arrives as a GraphQL enum over the closed list of `INTEREST_FLAGS` and there is nothing
 * to decide about it. The one behaviour of its own is the failure answer of 10.14 — a rejected write
 * becomes the German sentence of the design's error table, with the original rejection kept as the
 * cause so the server log still names it.
 *
 * The repository is a recording stand-in here: what it stores is its own test's subject.
 *
 * Requirements: 10.10, 10.14.
 */

import { INTEREST_FLAGS, type InterestFlag } from '@job-scraper/domain';
import { InternalServerErrorException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';

import { mapFailure } from '../../common/error-mapping';
import type { JobPosting } from '../../prisma/prisma.types';
import type { InterestFlagWriter, ManualVerdictWriter } from '../posting.service';
import { PostingService } from '../posting.service';

interface RecordedWrite {
  readonly id: string;
  readonly flag: InterestFlag;
}

const writes: RecordedWrite[] = [];

let rejection: unknown = null;

/** The written row, reduced to what this test needs; the repository's own test asserts the rest. */
const storedRow = (write: RecordedWrite): JobPosting =>
  ({ id: write.id, interestFlag: write.flag, postingStatus: 'LISTED' }) as JobPosting;

const repository: InterestFlagWriter & ManualVerdictWriter = {
  setInterestFlag: (id, flag) => {
    if (rejection !== null) {
      return Promise.reject(rejection);
    }

    const write: RecordedWrite = { id, flag };

    writes.push(write);

    return Promise.resolve(storedRow(write));
  },
  setRelevanceVerdictManually: () => Promise.reject(new Error('not the subject of this test file')),
};

let service: PostingService;

beforeEach(() => {
  writes.length = 0;
  rejection = null;
  service = new PostingService(repository);
});

describe('PostingService.setInterestFlag', () => {
  it.each(INTEREST_FLAGS)('forwards the marking %s to the single writer (10.10)', async (flag) => {
    const stored = await service.setInterestFlag('posting-1', flag);

    expect(writes).toEqual([{ id: 'posting-1', flag }]);
    expect(stored.interestFlag).toBe(flag);
  });

  it('answers a rejected write with the German sentence of 10.14', async () => {
    rejection = Object.assign(new Error('Server has closed the connection.'), { code: 'P1017' });

    const refused = service.setInterestFlag('posting-1', 'NOT_INTERESTING');

    await expect(refused).rejects.toBeInstanceOf(InternalServerErrorException);
    await expect(refused).rejects.toThrow(
      'Die Markierung konnte nicht gespeichert werden. Bitte erneut versuchen.',
    );

    // The same sentence the error table owns, read from the module that owns it rather than
    // duplicated: a reworded row has to fail here instead of drifting from the design.
    await expect(refused).rejects.toThrow(
      mapFailure({ kind: 'posting.interestFlagFailed', postingId: 'posting-1' }).userMessageDe,
    );
    expect(writes).toEqual([]);
  });

  it('keeps the original rejection as the cause and the driver message out of the German text', async () => {
    rejection = Object.assign(new Error("Can't reach database server at localhost:5432"), {
      code: 'P1001',
    });

    const refused = await service.setInterestFlag('posting-1', 'UNMARKED').then(
      () => null,
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(InternalServerErrorException);
    expect((refused as InternalServerErrorException).message).not.toContain('localhost:5432');
    expect((refused as Error).cause).toBe(rejection);
  });
});
