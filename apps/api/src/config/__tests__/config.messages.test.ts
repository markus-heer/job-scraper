/**
 * The console output of a failed configuration check.
 *
 * Two properties matter and neither is cosmetic. The output is German, because the person who
 * fills in the environment file is the non-technical user (1.15). And it names keys and ranges
 * only: the builders have no parameter that could carry an API key or the database password into
 * the console (14.9), which this test pins by checking the one value that does appear — the
 * retained Commute_Threshold — and the absence of anything else.
 *
 * Requirements: 1.15, 8.14, 14.9.
 */

import { describe, expect, it } from 'vitest';

import {
  commuteThresholdRejectedMessageDe,
  ENV_KEY_EXPECTATIONS_DE,
  invalidEnvValuesMessageDe,
  missingEnvKeysMessageDe,
} from '../config.messages';
import { REQUIRED_ENV_KEYS } from '../env.schema';

describe('missingEnvKeysMessageDe', () => {
  it('names every missing key and the file it is missing from', () => {
    const lines = missingEnvKeysMessageDe(['HOME_ADDRESS', 'API_PORT'], {
      path: '/repo/.env',
      loaded: true,
    });
    const text = lines.join('\n');

    expect(text).toContain('Konfiguration unvollständig');
    expect(text).toContain('HOME_ADDRESS');
    expect(text).toContain('API_PORT');
    expect(text).toContain('/repo/.env');
    expect(text).toContain('Der API_Service wurde nicht gestartet.');
  });

  it('says so when the environment file does not exist at all', () => {
    const text = missingEnvKeysMessageDe([...REQUIRED_ENV_KEYS], {
      path: '/repo/.env',
      loaded: false,
    }).join('\n');

    expect(text).toContain('nicht gefunden: /repo/.env');
    expect(text).toContain('.env.example');

    for (const key of REQUIRED_ENV_KEYS) {
      expect(text).toContain(key);
    }
  });
});

describe('invalidEnvValuesMessageDe', () => {
  it('names the key with its permitted range and no value', () => {
    const text = invalidEnvValuesMessageDe(['API_PORT']).join('\n');

    expect(text).toContain('Konfiguration ungültig');
    expect(text).toContain(`API_PORT: erwartet ${ENV_KEY_EXPECTATIONS_DE.API_PORT}`);
    expect(text).toContain('ganze Zahl von 1024 bis 65535');
  });
});

describe('commuteThresholdRejectedMessageDe', () => {
  it('names the permitted range and the value that stays in force (8.14)', () => {
    const message = commuteThresholdRejectedMessageDe(60);

    expect(message).toBe(
      'Pendelgrenze muss eine ganze Zahl zwischen 5 und 240 Minuten sein; der bisherige Wert ' +
        'bleibt aktiv. Weiterhin aktiv: 60 Minuten.',
    );
  });
});

describe('ENV_KEY_EXPECTATIONS_DE', () => {
  it('explains every required key, so no key can be reported without a hint', () => {
    for (const key of REQUIRED_ENV_KEYS) {
      expect(ENV_KEY_EXPECTATIONS_DE[key]).toMatch(/\S/);
    }
  });
});
