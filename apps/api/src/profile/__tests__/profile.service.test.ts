/**
 * That the Default_Search_Profile check really sits in the startup sequence.
 *
 * The check itself is covered in `profile.validation.test.ts`. What matters here is the wiring:
 * `DefaultProfileService` runs it from an init hook, and `AppModule` imports the module that
 * provides it — without that import the hook would never run and an invalid profile would reach the
 * first request (3.6). The success path additionally has to record the profile with the value of
 * every Criterion_Field (3.7).
 *
 * Requirements: 3.5, 3.6, 3.7.
 */

import 'reflect-metadata';

import { DEFAULT_SEARCH_PROFILE } from '@job-scraper/domain';
import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../../app.module';
import { ProfileModule } from '../profile.module';
import { DefaultProfileService } from '../profile.service';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('DefaultProfileService', () => {
  it('records every Criterion_Field value of the valid Default_Search_Profile (3.7)', () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    new DefaultProfileService().onModuleInit();

    expect(exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);

    const line = String(log.mock.calls[0]?.[0]);

    expect(line).toContain('Standard-Suchprofil:');
    expect(line).toContain(`Jobtitel: ${DEFAULT_SEARCH_PROFILE.jobTitle}`);
    expect(line).toContain(`Branche: ${DEFAULT_SEARCH_PROFILE.industry}`);
    expect(line).toContain(`Suchort: ${DEFAULT_SEARCH_PROFILE.searchLocation}`);
    expect(line).toContain(`Suchradius: ${DEFAULT_SEARCH_PROFILE.searchRadiusKm} km`);
    expect(line).toContain(`Beschäftigungsart: ${DEFAULT_SEARCH_PROFILE.employmentType}`);
    expect(line).toContain(
      `Veröffentlichungszeitraum: ${DEFAULT_SEARCH_PROFILE.publicationPeriodDays} Tage`,
    );

    for (const synonym of DEFAULT_SEARCH_PROFILE.titleSynonyms) {
      expect(line).toContain(synonym);
    }
  });
});

describe('startup wiring', () => {
  it('registers the check as an init hook', () => {
    expect(DefaultProfileService.prototype.onModuleInit).toBeTypeOf('function');
  });

  it('is imported by the root module, so the hook runs before the listener binds (3.6)', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as readonly unknown[] | undefined;

    expect(imports ?? []).toContain(ProfileModule);
  });
});
