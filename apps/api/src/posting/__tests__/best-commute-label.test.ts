/**
 * The German line a Job_Posting states its Best_Commute_Time with (8.4, 8.13, 10.1).
 *
 * Requirements: 8.4, 8.13, 10.1.
 */

import { describe, expect, it } from 'vitest';

import { bestCommuteLabelDe, COMMUTE_UNKNOWN_LABEL_DE } from '../best-commute-label';

describe('bestCommuteLabelDe', () => {
  it('states the minutes with the mode of transport (8.4)', () => {
    expect(bestCommuteLabelDe({ bestCommuteMinutes: 38, bestCommuteMode: 'BICYCLE' })).toBe(
      '38 Min. (Fahrrad)',
    );
    expect(bestCommuteLabelDe({ bestCommuteMinutes: 52, bestCommuteMode: 'TRANSIT' })).toBe(
      '52 Min. (öffentliche Verkehrsmittel)',
    );
  });

  it('states the hint of 8.13 instead of a number where there is no Best_Commute_Time', () => {
    expect(bestCommuteLabelDe({ bestCommuteMinutes: null, bestCommuteMode: null })).toBe(
      'Erreichbarkeit unbekannt',
    );
  });

  it('contains the "unbekannt" the posting list presents for an unknown value (10.1)', () => {
    expect(COMMUTE_UNKNOWN_LABEL_DE).toContain('unbekannt');
  });

  it('states the minutes alone where no mode is stored with them', () => {
    expect(bestCommuteLabelDe({ bestCommuteMinutes: 12, bestCommuteMode: null })).toBe('12 Min.');
  });

  it('ignores a stored mode where the Best_Commute_Time is unknown (8.13)', () => {
    expect(bestCommuteLabelDe({ bestCommuteMinutes: null, bestCommuteMode: 'BICYCLE' })).toBe(
      COMMUTE_UNKNOWN_LABEL_DE,
    );
  });
});
