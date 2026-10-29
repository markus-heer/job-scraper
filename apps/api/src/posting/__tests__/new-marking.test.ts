/**
 * The derived "neu" marking and the default grouping it orders the overview by (11.2, 11.3, 11.6,
 * 11.7).
 *
 * Pure functions, so these are pure tests: no database, no clock and no Nest context. What they pin
 * down is the part of 11.2 to 11.7 that is not a query — the equality the marking is, the two
 * groups the default grouping splits a filtered set into, and the arithmetic that makes the grouping
 * hold across page boundaries rather than inside one page.
 *
 * Requirements: 11.2, 11.3, 11.6, 11.7.
 */

import { describe, expect, it } from 'vitest';

import {
  isNewPosting,
  newFirstGroups,
  type NewFirstPageSlices,
  newFirstPageSlices,
} from '../new-marking';

const LATEST_COMPLETED = 'run-completed-3';

describe('isNewPosting', () => {
  it('marks a Job_Posting first recorded in the most recently completed Scrape_Run (11.2)', () => {
    expect(isNewPosting({ firstSeenRunId: LATEST_COMPLETED }, LATEST_COMPLETED)).toBe(true);
  });

  it('leaves a Job_Posting of an earlier Scrape_Run unmarked (11.4)', () => {
    expect(isNewPosting({ firstSeenRunId: 'run-completed-2' }, LATEST_COMPLETED)).toBe(false);
  });

  it('leaves a Job_Posting of a later Scrape_Run that did not complete unmarked (11.7)', () => {
    // The cancelled run recorded this posting after the completed one ran, so its recording time is
    // the most recent of all. It is still not marked: the reference is the latest *completed* run.
    expect(isNewPosting({ firstSeenRunId: 'run-cancelled-4' }, LATEST_COMPLETED)).toBe(false);
  });

  it('marks nothing while no Scrape_Run has completed (11.6)', () => {
    expect(isNewPosting({ firstSeenRunId: 'run-cancelled-1' }, null)).toBe(false);
  });
});

describe('newFirstGroups', () => {
  it('splits the set into the postings of the reference run and the rest (11.3)', () => {
    expect(newFirstGroups(LATEST_COMPLETED)).toEqual({
      marked: { firstSeenRunId: LATEST_COMPLETED },
      unmarked: { firstSeenRunId: { not: LATEST_COMPLETED } },
    });
  });

  it('matches no posting in the marked group while no Scrape_Run has completed (11.6)', () => {
    const groups = newFirstGroups(null);

    expect(groups.marked).toEqual({ id: { in: [] } });
    expect(groups.unmarked).toEqual({});
  });
});

describe('newFirstPageSlices', () => {
  /** The slices of one page of the grouped list, as `findPage` computes them from its arguments. */
  const page = (markedCount: number, pageNumber: number, pageSize = 25): NewFirstPageSlices =>
    newFirstPageSlices({ markedCount, skip: (pageNumber - 1) * pageSize, take: pageSize });

  it('reads only marked postings while the page lies inside that group (11.3)', () => {
    expect(page(60, 1)).toEqual({
      markedSkip: 0,
      markedTake: 25,
      unmarkedSkip: 0,
      unmarkedTake: 0,
    });
    expect(page(60, 2)).toEqual({
      markedSkip: 25,
      markedTake: 25,
      unmarkedSkip: 0,
      unmarkedTake: 0,
    });
  });

  it('takes the tail of the marked group and the head of the rest across the boundary (11.3)', () => {
    expect(page(60, 3)).toEqual({
      markedSkip: 50,
      markedTake: 10,
      unmarkedSkip: 0,
      unmarkedTake: 15,
    });
  });

  it('reads only unmarked postings once the marked group is behind the page (11.3)', () => {
    expect(page(60, 4)).toEqual({
      markedSkip: 60,
      markedTake: 0,
      unmarkedSkip: 15,
      unmarkedTake: 25,
    });
  });

  it('degenerates to the ungrouped list when nothing is marked (11.6)', () => {
    expect(page(0, 1)).toEqual({
      markedSkip: 0,
      markedTake: 0,
      unmarkedSkip: 0,
      unmarkedTake: 25,
    });
    expect(page(0, 3)).toEqual({
      markedSkip: 0,
      markedTake: 0,
      unmarkedSkip: 50,
      unmarkedTake: 25,
    });
  });

  it('asks for every entry of the page exactly once, whatever the group sizes', () => {
    // The two windows are a partition of the requested page: together they are its size, and the
    // marked window is always the one that starts first. A page that asked for 24 entries where 25
    // were available, or for the same entry twice, is the failure this covers.
    for (let markedCount = 0; markedCount <= 30; markedCount += 1) {
      for (let pageNumber = 1; pageNumber <= 4; pageNumber += 1) {
        const slices = page(markedCount, pageNumber, 10);
        const available = Math.max(Math.min(markedCount - slices.markedSkip, 10), 0);

        expect(slices.markedTake + slices.unmarkedTake).toBe(10);
        expect(slices.markedTake).toBe(available);
        expect(slices.markedSkip).toBeLessThanOrEqual(markedCount);
      }
    }
  });

  it('reads a negative, fractional or non-finite window as an empty one', () => {
    expect(newFirstPageSlices({ markedCount: -5, skip: -10, take: 25 })).toEqual({
      markedSkip: 0,
      markedTake: 0,
      unmarkedSkip: 0,
      unmarkedTake: 25,
    });
    expect(newFirstPageSlices({ markedCount: 4.7, skip: 2.9, take: Number.NaN })).toEqual({
      markedSkip: 2,
      markedTake: 0,
      unmarkedSkip: 0,
      unmarkedTake: 0,
    });
  });
});
