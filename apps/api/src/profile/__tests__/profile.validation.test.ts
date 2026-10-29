/**
 * What an invalid Default_Search_Profile costs at startup.
 *
 * Criterion 3.6 pins three things at once: the startup stops, the message is German and names every
 * affected Criterion_Field with its permitted value range, and the exit code is non-zero. The
 * ranges themselves are covered by the unit tests of `validateDefaultSearchProfile` in
 * `packages/domain`, so what is asserted here is the consequence — that the process really stops,
 * and that every reported field reaches the console.
 *
 * The profile constant shipped in `packages/domain` is checked as it is: a change to it that breaks
 * a range would otherwise only show up when the API_Service refuses to start.
 *
 * Requirements: 3.5, 3.6.
 */

import { DEFAULT_SEARCH_PROFILE, type SearchProfile } from '@job-scraper/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkDefaultSearchProfile,
  PROFILE_FAILURE_EXIT_CODE,
  validateDefaultSearchProfileOrExit,
} from '../profile.validation';

/** Two independent range violations, so the message has to name both fields. */
const INVALID_PROFILE: SearchProfile = {
  ...DEFAULT_SEARCH_PROFILE,
  searchLocation: '   ',
  searchRadiusKm: 0,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('checkDefaultSearchProfile', () => {
  it('accepts the Default_Search_Profile constant', () => {
    const outcome = checkDefaultSearchProfile();

    expect(outcome).toEqual({ ok: true, profile: DEFAULT_SEARCH_PROFILE });
  });

  it('names every affected Criterion_Field with its permitted range in German (3.6)', () => {
    const outcome = checkDefaultSearchProfile(INVALID_PROFILE);

    expect(outcome.ok).toBe(false);

    if (outcome.ok) {
      return;
    }

    expect(outcome.issues.map((issue) => issue.field)).toEqual([
      'searchLocation',
      'searchRadiusKm',
    ]);

    const message = outcome.messageLinesDe.join('\n');

    expect(message).toContain('Standard-Suchprofil ungültig');
    expect(message).toContain('Suchort (searchLocation)');
    expect(message).toContain('höchstens 100 Zeichen');
    expect(message).toContain('Suchradius (searchRadiusKm)');
    expect(message).toContain('zwischen 1 und 200 Kilometern');
    expect(message).toContain('Der API_Service wurde nicht gestartet.');
  });

  it('reports one line per violation, so three broken synonyms are seen at once', () => {
    const outcome = checkDefaultSearchProfile({
      ...DEFAULT_SEARCH_PROFILE,
      titleSynonyms: ['a', 'b', 'c', 'Projektmanager'],
    });

    expect(outcome.ok).toBe(false);

    if (outcome.ok) {
      return;
    }

    expect(outcome.issues.filter((issue) => issue.field === 'titleSynonyms')).toHaveLength(3);
    expect(outcome.messageLinesDe.filter((line) => line.includes('Titel-Synonym'))).toHaveLength(3);
  });
});

describe('validateDefaultSearchProfileOrExit', () => {
  it('stops the startup with a non-zero exit code when the profile is invalid (3.6)', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    validateDefaultSearchProfileOrExit(INVALID_PROFILE);

    expect(exit).toHaveBeenCalledWith(PROFILE_FAILURE_EXIT_CODE);
    expect(PROFILE_FAILURE_EXIT_CODE).not.toBe(0);
    expect(error.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'Suchradius (searchRadiusKm)',
    );
  });

  it('returns the profile and keeps the process running when every range holds', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(validateDefaultSearchProfileOrExit()).toEqual(DEFAULT_SEARCH_PROFILE);
    expect(exit).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
