/**
 * What a rejected Commute_Threshold change costs, from the raw environment value onwards (8.14).
 *
 * The retention crosses two modules, and each half is covered on its own: `env.schema.test.ts`
 * shows that an unusable `COMMUTE_THRESHOLD_MINUTES` becomes `null` instead of a start failure, and
 * `config.service.test.ts` shows that a `null` makes the service fall back to the stored value. The
 * seam between them is what 8.14 actually promises, and only the composition can show it — the
 * string the user typed is refused, the number the user configured earlier stays in force, and the
 * hint names the permitted range. A regression that moves the threshold out of the recoverable
 * class would leave both halves green and break exactly this suite.
 *
 * The one case that is *not* retention is asserted too: an empty value is a missing required key,
 * which stops the startup (1.15). The two criteria meet on that boundary, so it is pinned here
 * rather than left to the reader of two files.
 *
 * Requirements: 1.15, 8.10, 8.14.
 */

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppConfigService,
  DEFAULT_COMMUTE_THRESHOLD_MINUTES,
  SETTING_KEY_COMMUTE_THRESHOLD_MINUTES,
} from '../config.service';
import { type EnvConfig, type EnvSource, parseEnvironment } from '../env.schema';
import { envWith } from './env-source.fixture';
import { createSettingStore, storedValueOf } from './setting-store.fixture';

/** The validated configuration of an environment file that is expected to be startable. */
const configOf = (source: EnvSource): EnvConfig => {
  const result = parseEnvironment(source);

  if (result.outcome !== 'valid') {
    throw new Error(`Expected a startable environment, got ${result.outcome}`);
  }

  return result.config;
};

/**
 * Starts the API_Service configuration with a `Setting` table that already holds an accepted
 * Commute_Threshold, and returns what stayed in force.
 */
const startWith = async (rawThreshold: string, previouslyAccepted?: string) => {
  const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

  const { store, rows, writes } = createSettingStore(
    previouslyAccepted === undefined
      ? []
      : [{ key: SETTING_KEY_COMMUTE_THRESHOLD_MINUTES, value: previouslyAccepted }],
  );
  const service = new AppConfigService(
    configOf(envWith({ COMMUTE_THRESHOLD_MINUTES: rawThreshold })),
    store,
  );

  await service.resolveConfigurableValues();

  return {
    service,
    rows,
    writes,
    errorText: errorSpy.mock.calls.map((call) => String(call[0])).join('\n'),
  };
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a rejected Commute_Threshold change', () => {
  it.each(['300', '4', '241', '60.5', '-30', 'eine Stunde'])(
    'keeps the previously accepted value in force for the unusable value %o (8.14)',
    async (rawThreshold) => {
      const { service, rows, writes } = await startWith(rawThreshold, '90');

      expect(service.commuteThresholdMinutes).toBe(90);
      expect(storedValueOf(rows, SETTING_KEY_COMMUTE_THRESHOLD_MINUTES)).toBe('90');
      // The row the fallback depends on is not rewritten, so `updatedAt` keeps meaning "last
      // accepted" and a second restart retains the same value again.
      expect(writes.map((write) => write.key)).not.toContain(SETTING_KEY_COMMUTE_THRESHOLD_MINUTES);
    },
  );

  it('names the permitted range and the value that stays in force (8.14)', async () => {
    const { errorText } = await startWith('300', '90');

    expect(errorText).toContain('config.commuteThresholdInvalid');
    expect(errorText).toContain(
      'Pendelgrenze muss eine ganze Zahl zwischen 5 und 240 Minuten sein; der bisherige Wert ' +
        'bleibt aktiv.',
    );
    expect(errorText).toContain('Weiterhin aktiv: 90 Minuten.');
  });

  it('reports the rejection exactly once per start, not once per reader', async () => {
    const { service, errorText } = await startWith('300', '90');

    expect(errorText.split('\n')).toHaveLength(1);
    expect(service.commuteThresholdMinutes).toBe(90);
    expect(service.commuteThresholdMinutes).toBe(90);
  });

  it('retains the value that every consumer reads and that the log shows', async () => {
    const { service } = await startWith('300', '90');

    expect(service.describeForLog()).toMatchObject({ commuteThresholdMinutes: 90 });
  });

  it('falls back to the documented default when nothing was ever accepted (8.10)', async () => {
    const { service, rows } = await startWith('300');

    expect(service.commuteThresholdMinutes).toBe(DEFAULT_COMMUTE_THRESHOLD_MINUTES);
    expect(storedValueOf(rows, SETTING_KEY_COMMUTE_THRESHOLD_MINUTES)).toBe('60');
  });
});

describe('an accepted Commute_Threshold change', () => {
  it.each(['5', '45', '240'])('replaces the previous value with %s', async (rawThreshold) => {
    const { service, rows, errorText } = await startWith(rawThreshold, '90');

    expect(service.commuteThresholdMinutes).toBe(Number(rawThreshold));
    expect(storedValueOf(rows, SETTING_KEY_COMMUTE_THRESHOLD_MINUTES)).toBe(rawThreshold);
    expect(errorText).toBe('');
  });
});

describe('an empty Commute_Threshold', () => {
  it.each(['', '   '])('stops the startup instead of retaining anything (1.15)', (rawThreshold) => {
    expect(parseEnvironment(envWith({ COMMUTE_THRESHOLD_MINUTES: rawThreshold }))).toEqual({
      outcome: 'incomplete',
      missingKeys: ['COMMUTE_THRESHOLD_MINUTES'],
    });
  });
});
