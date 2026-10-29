import { describe, expect, it } from 'vitest';

import {
  type LogMessage,
  Prisma,
  PrismaClient,
  type ScrapeRunPlatformResult,
} from '../prisma.types';

describe('prisma.types re-export', () => {
  it('exposes the generated client', () => {
    expect(typeof PrismaClient).toBe('function');
  });

  it('exposes every model of the Posting_Store', () => {
    expect(Object.values(Prisma.ModelName).sort()).toEqual([
      'CommuteCacheEntry',
      'JobPosting',
      'LocationNormalization',
      'LogMessage',
      'ScrapeRun',
      'ScrapeRunPlatformResult',
      'Setting',
    ]);
  });
});

describe('typed JSON columns', () => {
  it('types ScrapeRunPlatformResult.effectiveProfile as the effective Search_Profile', () => {
    const snapshot: PrismaJson.EffectiveSearchProfileJson = {
      platform: 'STEPSTONE',
      criteria: [
        { field: 'jobTitle', value: 'Projektmanagerin', provenance: 'DEFAULT' },
        { field: 'searchRadiusKm', value: 25, provenance: 'OVERRIDE' },
      ],
    };

    // Compiles only because the column carries the typed shape: a plain Prisma.JsonValue would
    // reject the readonly criteria list.
    const row: Pick<ScrapeRunPlatformResult, 'effectiveProfile'> = { effectiveProfile: snapshot };

    expect(row.effectiveProfile?.criteria.map((criterion) => criterion.field)).toEqual([
      'jobTitle',
      'searchRadiusKm',
    ]);
  });

  it('keeps effectiveProfile nullable, as the schema declares it', () => {
    const row: Pick<ScrapeRunPlatformResult, 'effectiveProfile'> = { effectiveProfile: null };

    expect(row.effectiveProfile).toBeNull();
  });

  it('rejects a criterion field that is not part of the Search_Profile', () => {
    const unknownCriterion = {
      field: 'unknownField',
      value: '',
      provenance: 'DEFAULT',
    } as const;

    // @ts-expect-error - 'unknownField' is not a Criterion_Field, so the typed column rejects it
    const invalid: PrismaJson.EffectiveCriterionJson = unknownCriterion;

    expect(invalid.field).toBe('unknownField');
  });

  it('types LogMessage.detail as the structured log context', () => {
    const detail: PrismaJson.LogMessageDetailJson = { platform: 'STEPSTONE', pagesFetched: 3 };
    const row: Pick<LogMessage, 'detail'> = { detail };

    expect(row.detail?.['pagesFetched']).toBe(3);
  });
});
