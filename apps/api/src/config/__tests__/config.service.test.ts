/**
 * How the last accepted Home_Address and Commute_Threshold survive a rejected change.
 *
 * The behaviour under test is the one 8.14 asks for and that nothing else in the Job_Tool can
 * provide: a Commute_Threshold outside 5 to 240 is refused, the previously accepted value stays in
 * force, and the user is told the permitted range. The `Setting` table is where "previously
 * accepted" lives, so the test drives the service against a stand-in store that behaves like the
 * `Setting` delegate — the resolution logic is the real one, only the storage is in memory. The
 * Testcontainers harness of a later task exercises the same service against PostgreSQL.
 *
 * Seeding (8.10) is the second subject: the first start writes the documented default pair, so a
 * later rejected change has something to fall back to.
 *
 * Requirements: 8.10, 8.14, 14.9.
 */

import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppConfigService,
  DEFAULT_COMMUTE_THRESHOLD_MINUTES,
  SETTING_KEY_COMMUTE_THRESHOLD_MINUTES,
  SETTING_KEY_HOME_ADDRESS,
} from '../config.service';
import type { EnvConfig } from '../env.schema';
import { createSettingStore, storedValueOf } from './setting-store.fixture';

const ENV: EnvConfig = {
  databaseUrl: 'postgresql://jobtool:secret@127.0.0.1:55432/jobtool?schema=public',
  homeAddress: 'Hörkherstraße 1d, 80689 München',
  commuteThresholdMinutes: 60,
  routingProvider: 'heigit',
  routingApiKey: 'routing-key-must-not-be-printed',
  anthropicApiKey: 'sk-ant-must-not-be-printed',
  anthropicModel: 'claude-sonnet-4-5',
  relevanceEnabled: true,
  relevanceConcurrency: 4,
  relevanceMaxPerRun: 200,
  enrichmentGraceMinutes: 10,
  userAgentContact: 'job.tool@example.com',
  robotsPolicy: 'respect',
  apiPort: 4000,
  webPort: 5173,
  // Normal operation: nothing in the configuration service depends on the fixture switch, which is
  // the point — fixture mode changes which provider is bound, not what a configuration value means.
  scraperFixtureMode: false,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('AppConfigService', () => {
  it('seeds the accepted pair on the first start (8.10)', async () => {
    const { store, rows } = createSettingStore();
    const service = new AppConfigService(ENV, store);

    await service.resolveConfigurableValues();

    expect(service.homeAddress).toBe('Hörkherstraße 1d, 80689 München');
    expect(service.commuteThresholdMinutes).toBe(60);
    expect(storedValueOf(rows, SETTING_KEY_HOME_ADDRESS)).toBe('Hörkherstraße 1d, 80689 München');
    expect(storedValueOf(rows, SETTING_KEY_COMMUTE_THRESHOLD_MINUTES)).toBe('60');
  });

  it('records an accepted change as the new previous value', async () => {
    const { store, rows } = createSettingStore([
      { key: SETTING_KEY_COMMUTE_THRESHOLD_MINUTES, value: '45' },
      { key: SETTING_KEY_HOME_ADDRESS, value: 'Marienplatz 1, 80331 München' },
    ]);
    const service = new AppConfigService({ ...ENV, commuteThresholdMinutes: 90 }, store);

    await service.resolveConfigurableValues();

    expect(service.commuteThresholdMinutes).toBe(90);
    expect(storedValueOf(rows, SETTING_KEY_COMMUTE_THRESHOLD_MINUTES)).toBe('90');
    expect(storedValueOf(rows, SETTING_KEY_HOME_ADDRESS)).toBe('Hörkherstraße 1d, 80689 München');
  });

  it('writes nothing when the configuration is unchanged', async () => {
    const { store, writes } = createSettingStore([
      { key: SETTING_KEY_COMMUTE_THRESHOLD_MINUTES, value: '60' },
      { key: SETTING_KEY_HOME_ADDRESS, value: 'Hörkherstraße 1d, 80689 München' },
    ]);

    await new AppConfigService(ENV, store).resolveConfigurableValues();

    expect(writes).toEqual([]);
  });

  it('retains the previously accepted Commute_Threshold when the configured one is rejected (8.14)', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { store, rows } = createSettingStore([
      { key: SETTING_KEY_COMMUTE_THRESHOLD_MINUTES, value: '45' },
    ]);
    const service = new AppConfigService({ ...ENV, commuteThresholdMinutes: null }, store);

    await service.resolveConfigurableValues();

    expect(service.commuteThresholdMinutes).toBe(45);
    expect(storedValueOf(rows, SETTING_KEY_COMMUTE_THRESHOLD_MINUTES)).toBe('45');
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      'Pendelgrenze muss eine ganze Zahl zwischen 5 und 240 Minuten sein',
    );
    expect(String(error.mock.calls[0]?.[0])).toContain('Weiterhin aktiv: 45 Minuten.');
  });

  it('falls back to the documented default when a rejected change meets an unseeded store', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { store, rows } = createSettingStore();
    const service = new AppConfigService({ ...ENV, commuteThresholdMinutes: null }, store);

    await service.resolveConfigurableValues();

    expect(service.commuteThresholdMinutes).toBe(DEFAULT_COMMUTE_THRESHOLD_MINUTES);
    expect(storedValueOf(rows, SETTING_KEY_COMMUTE_THRESHOLD_MINUTES)).toBe('60');
  });

  it('ignores a stored value that is itself outside the permitted range', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { store } = createSettingStore([
      { key: SETTING_KEY_COMMUTE_THRESHOLD_MINUTES, value: '600' },
    ]);
    const service = new AppConfigService({ ...ENV, commuteThresholdMinutes: null }, store);

    await service.resolveConfigurableValues();

    expect(service.commuteThresholdMinutes).toBe(DEFAULT_COMMUTE_THRESHOLD_MINUTES);
  });

  it('keeps every credential out of the loggable description (14.9)', async () => {
    const { store } = createSettingStore();
    const service = new AppConfigService(ENV, store);

    await service.resolveConfigurableValues();

    const serialised = JSON.stringify(service.describeForLog());

    for (const secret of [ENV.routingApiKey, ENV.anthropicApiKey, ENV.databaseUrl]) {
      expect(serialised).not.toContain(secret);
    }

    expect(serialised).toContain('***');
    expect(service.describeForLog()).toMatchObject({ commuteThresholdMinutes: 60 });
  });
});
