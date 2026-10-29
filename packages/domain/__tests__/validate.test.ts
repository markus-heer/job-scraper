/**
 * Unit tests for `validateDefaultSearchProfile` (3.1, 3.2, 3.5, 3.6).
 *
 * The happy path is the real `DEFAULT_SEARCH_PROFILE`: the constant the API_Service validates at
 * startup has to pass, otherwise the tool cannot start at all (3.6). Every other test takes that
 * constant and breaks exactly one range, so the asserted issue is attributable to that range alone.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_SEARCH_PROFILE } from '../src/search-profile/constants.js';
import type { SearchProfile } from '../src/search-profile/types.js';
import {
  PROFILE_VALIDATION_LIMITS,
  type ProfileValidationIssue,
  validateDefaultSearchProfile,
} from '../src/search-profile/validate.js';

const {
  textMaxLength,
  synonymMinCount,
  synonymMaxCount,
  synonymMaxLength,
  searchRadiusKmMin,
  searchRadiusKmMax,
  publicationPeriodDaysMin,
  publicationPeriodDaysMax,
} = PROFILE_VALIDATION_LIMITS;

/** The Default_Search_Profile with one field replaced, so one range is broken at a time. */
function profileWith(patch: Partial<SearchProfile>): SearchProfile {
  return { ...DEFAULT_SEARCH_PROFILE, ...patch };
}

/** A synonym list of `count` valid entries, for the count bounds of 3.2. */
function synonyms(count: number): readonly string[] {
  return Array.from({ length: count }, (_unused, index) => `Synonym ${index + 1}`);
}

const codesOf = (issues: readonly ProfileValidationIssue[]): readonly string[] =>
  issues.map((issue) => issue.code);

describe('validateDefaultSearchProfile', () => {
  it('accepts the delivered DEFAULT_SEARCH_PROFILE (3.1, 3.2, 3.5)', () => {
    expect(validateDefaultSearchProfile(DEFAULT_SEARCH_PROFILE)).toEqual([]);
  });

  it('accepts every range boundary (3.2, 3.5)', () => {
    const atBounds = profileWith({
      jobTitle: 'x'.repeat(textMaxLength),
      titleSynonyms: synonyms(synonymMaxCount),
      industry: 'y'.repeat(textMaxLength),
      searchLocation: 'z'.repeat(textMaxLength),
      searchRadiusKm: searchRadiusKmMax,
      publicationPeriodDays: publicationPeriodDaysMax,
    });

    expect(validateDefaultSearchProfile(atBounds)).toEqual([]);
    expect(
      validateDefaultSearchProfile(
        profileWith({
          titleSynonyms: synonyms(synonymMinCount),
          searchRadiusKm: searchRadiusKmMin,
          publicationPeriodDays: publicationPeriodDaysMin,
        }),
      ),
    ).toEqual([]);
  });

  describe.each([
    {
      field: 'jobTitle',
      code: 'profile.jobTitleInvalid',
      labelDe: 'Jobtitel',
      patch: (jobTitle: string): Partial<SearchProfile> => ({ jobTitle }),
    },
    {
      field: 'industry',
      code: 'profile.industryInvalid',
      labelDe: 'Branche',
      patch: (industry: string): Partial<SearchProfile> => ({ industry }),
    },
    {
      field: 'searchLocation',
      code: 'profile.searchLocationInvalid',
      labelDe: 'Suchort',
      patch: (searchLocation: string): Partial<SearchProfile> => ({ searchLocation }),
    },
  ] as const)('$field', ({ field, code, labelDe, patch }) => {
    it('reports an empty value (3.5)', () => {
      const issues = validateDefaultSearchProfile(profileWith(patch('')));

      expect(issues).toEqual([
        {
          field,
          code,
          messageDe: `${labelDe} muss angegeben sein und darf höchstens 100 Zeichen lang sein.`,
        },
      ]);
    });

    it('reports a whitespace-only value (3.5)', () => {
      expect(codesOf(validateDefaultSearchProfile(profileWith(patch('   '))))).toEqual([code]);
    });

    it('reports a value above the character limit (3.5)', () => {
      const issues = validateDefaultSearchProfile(
        profileWith(patch('a'.repeat(textMaxLength + 1))),
      );

      expect(codesOf(issues)).toEqual([code]);
      expect(issues[0]?.messageDe).toContain(String(textMaxLength));
    });
  });

  describe('titleSynonyms', () => {
    it('reports fewer than the minimum number of synonyms (3.2)', () => {
      const issues = validateDefaultSearchProfile(
        profileWith({ titleSynonyms: synonyms(synonymMinCount - 1) }),
      );

      expect(issues).toEqual([
        {
          field: 'titleSynonyms',
          code: 'profile.titleSynonymsCountInvalid',
          messageDe: 'Es müssen 4 bis 20 Titel-Synonyme angegeben sein (aktuell: 3).',
        },
      ]);
    });

    it('reports more than the maximum number of synonyms (3.2)', () => {
      const issues = validateDefaultSearchProfile(
        profileWith({ titleSynonyms: synonyms(synonymMaxCount + 1) }),
      );

      expect(codesOf(issues)).toEqual(['profile.titleSynonymsCountInvalid']);
    });

    it('reports an empty synonym list with the count issue only (3.2)', () => {
      expect(codesOf(validateDefaultSearchProfile(profileWith({ titleSynonyms: [] })))).toEqual([
        'profile.titleSynonymsCountInvalid',
      ]);
    });

    it('reports a synonym below the minimum length, naming its position (3.2)', () => {
      const issues = validateDefaultSearchProfile(
        profileWith({ titleSynonyms: ['Projektmanager', 'x', 'Projektleiterin', 'Projektleiter'] }),
      );

      expect(issues).toEqual([
        {
          field: 'titleSynonyms',
          code: 'profile.titleSynonymInvalid',
          messageDe: 'Das Titel-Synonym an Position 2 muss 2 bis 100 Zeichen lang sein.',
        },
      ]);
    });

    it('reports a synonym above the maximum length (3.2)', () => {
      const issues = validateDefaultSearchProfile(
        profileWith({
          titleSynonyms: [...synonyms(synonymMinCount), 'x'.repeat(synonymMaxLength + 1)],
        }),
      );

      expect(codesOf(issues)).toEqual(['profile.titleSynonymInvalid']);
      expect(issues[0]?.messageDe).toContain('Position 5');
    });

    it('reports one issue per offending synonym (3.6)', () => {
      const issues = validateDefaultSearchProfile(
        profileWith({ titleSynonyms: ['Projektmanager', ' ', 'Projektleiterin', 'a'] }),
      );

      expect(codesOf(issues)).toEqual([
        'profile.titleSynonymInvalid',
        'profile.titleSynonymInvalid',
      ]);
      expect(issues.map((issue) => issue.messageDe)).toEqual([
        'Das Titel-Synonym an Position 2 muss 2 bis 100 Zeichen lang sein.',
        'Das Titel-Synonym an Position 4 muss 2 bis 100 Zeichen lang sein.',
      ]);
    });
  });

  describe.each([
    {
      field: 'searchRadiusKm',
      code: 'profile.searchRadiusKmInvalid',
      min: searchRadiusKmMin,
      max: searchRadiusKmMax,
      messageDe: 'Der Suchradius muss eine ganze Zahl zwischen 1 und 200 Kilometern sein.',
      patch: (searchRadiusKm: number): Partial<SearchProfile> => ({ searchRadiusKm }),
    },
    {
      field: 'publicationPeriodDays',
      code: 'profile.publicationPeriodDaysInvalid',
      min: publicationPeriodDaysMin,
      max: publicationPeriodDaysMax,
      messageDe:
        'Der Veröffentlichungszeitraum muss eine ganze Zahl zwischen 1 und 365 Tagen sein.',
      patch: (publicationPeriodDays: number): Partial<SearchProfile> => ({ publicationPeriodDays }),
    },
  ] as const)('$field', ({ field, code, min, max, messageDe, patch }) => {
    it('reports a value below the minimum (3.5)', () => {
      expect(validateDefaultSearchProfile(profileWith(patch(min - 1)))).toEqual([
        { field, code, messageDe },
      ]);
    });

    it('reports a value above the maximum (3.5)', () => {
      expect(codesOf(validateDefaultSearchProfile(profileWith(patch(max + 1))))).toEqual([code]);
    });

    it('reports a non-integer value (3.5)', () => {
      expect(codesOf(validateDefaultSearchProfile(profileWith(patch(min + 0.5))))).toEqual([code]);
    });

    it('reports a non-finite value (3.5)', () => {
      expect(codesOf(validateDefaultSearchProfile(profileWith(patch(Number.NaN))))).toEqual([code]);
    });
  });

  it('reports every violation at once, in SearchProfile declaration order (3.6)', () => {
    const broken = profileWith({
      jobTitle: '',
      titleSynonyms: ['ok eins', 'x'],
      industry: '',
      searchLocation: ' ',
      searchRadiusKm: 0,
      publicationPeriodDays: 366,
    });

    expect(codesOf(validateDefaultSearchProfile(broken))).toEqual([
      'profile.jobTitleInvalid',
      'profile.titleSynonymsCountInvalid',
      'profile.titleSynonymInvalid',
      'profile.industryInvalid',
      'profile.searchLocationInvalid',
      'profile.searchRadiusKmInvalid',
      'profile.publicationPeriodDaysInvalid',
    ]);
  });

  it('names the permitted range in every German message and keeps the code English (3.6, 16.8)', () => {
    const broken = profileWith({ jobTitle: '', searchRadiusKm: 0, publicationPeriodDays: 0 });

    for (const issue of validateDefaultSearchProfile(broken)) {
      expect(issue.messageDe).toMatch(/\d/u);
      expect(issue.code).toMatch(/^profile\.[A-Za-z]+$/u);
    }
  });
});
