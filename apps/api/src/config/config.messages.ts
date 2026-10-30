/**
 * German-language output of the configuration check.
 *
 * The user of the Job_Tool is a German speaker and is the one who fills in the environment file,
 * so every text that a failed configuration check puts on the console is German (1.15, 8.14) even
 * though the rest of the API_Service logs in English. Collecting the texts in one file keeps the
 * wording reviewable and keeps the validation in `env.schema.ts` free of presentation concerns.
 *
 * No builder in this file accepts a configuration *value*. They take key names, a file path and
 * the retained Commute_Threshold, which is a value the user configured themselves and sees in the
 * Web_App anyway. That restriction is what guarantees no API key and no database password can
 * reach the console through an error message (14.9).
 *
 * Requirements: 1.15, 8.14, 14.9.
 */

import {
  COMMUTE_THRESHOLD_MAX_MINUTES,
  COMMUTE_THRESHOLD_MIN_MINUTES,
  type EnvKey,
  type EnvKeyName,
} from './env.schema';

/**
 * What each key has to contain, phrased for the user who edits the environment file.
 *
 * Keyed by {@link EnvKeyName} rather than by {@link EnvKey}, so the optional fixture-mode switch has
 * an expectation too: it is never reported as missing, but it is reported as invalid when it carries
 * a value that spells neither state.
 */
export const ENV_KEY_EXPECTATIONS_DE: Readonly<Record<EnvKeyName, string>> = {
  DATABASE_URL: 'Verbindungszeichenfolge, die mit "postgresql://" beginnt',
  HOME_ADDRESS: 'nicht leer, höchstens 200 Zeichen',
  COMMUTE_THRESHOLD_MINUTES: `ganze Zahl von ${COMMUTE_THRESHOLD_MIN_MINUTES} bis ${COMMUTE_THRESHOLD_MAX_MINUTES} (Minuten)`,
  ROUTING_PROVIDER: 'entweder "heigit" oder "google"',
  ROUTING_API_KEY: 'nicht leer',
  ANTHROPIC_API_KEY: 'nicht leer',
  ANTHROPIC_MODEL: 'nicht leer, höchstens 100 Zeichen',
  RELEVANCE_ENABLED: 'entweder "true" oder "false"',
  RELEVANCE_CONCURRENCY: 'ganze Zahl von 1 bis 16',
  RELEVANCE_MAX_PER_RUN: 'ganze Zahl von 1 bis 20000',
  ENRICHMENT_GRACE_MINUTES: 'ganze Zahl von 1 bis 120 (Minuten)',
  USER_AGENT_CONTACT: 'nicht leer, Kontaktangabe wie eine E-Mail-Adresse',
  // 14.10: genau einer der beiden Werte. "respect" schließt eine Plattform aus, deren robots.txt
  // den Abruf untersagt; "ignore" ruft trotzdem ab und meldet die Untersagung als Warnung.
  ROBOTS_POLICY: 'entweder "respect" oder "ignore"',
  API_PORT: 'ganze Zahl von 1024 bis 65535',
  WEB_PORT: 'ganze Zahl von 1024 bis 65535',
  SCRAPER_FIXTURE_MODE:
    'leer oder nicht gesetzt (normaler Betrieb), sonst "1" oder "true" für den Fixture-Betrieb ' +
    'der E2E-Tests bzw. "0" oder "false"',
};

/** Closing line of every fatal configuration message. */
const NOT_STARTED_LINE_DE = 'Der API_Service wurde nicht gestartet.';

/**
 * Names every missing or empty key (1.15).
 *
 * The environment file path is part of the output because the file is deliberately absent from
 * version control: when it has not been created yet, the path is the whole answer.
 */
export const missingEnvKeysMessageDe = (
  missingKeys: readonly EnvKey[],
  envFile: { readonly path: string; readonly loaded: boolean },
): readonly string[] => [
  'Konfiguration unvollständig: Die folgenden Schlüssel fehlen in der Umgebungsdatei oder sind leer:',
  ...missingKeys.map((key) => `  - ${key} (${ENV_KEY_EXPECTATIONS_DE[key]})`),
  envFile.loaded
    ? `Umgebungsdatei: ${envFile.path}`
    : `Umgebungsdatei nicht gefunden: ${envFile.path}`,
  'Bitte .env.example in .env kopieren und die genannten Schlüssel ausfüllen.',
  NOT_STARTED_LINE_DE,
];

/** Names every key whose value is present but unusable, together with its permitted range. */
export const invalidEnvValuesMessageDe = (
  invalidKeys: readonly EnvKeyName[],
): readonly string[] => [
  'Konfiguration ungültig: Die folgenden Schlüssel haben einen unzulässigen Wert:',
  ...invalidKeys.map((key) => `  - ${key}: erwartet ${ENV_KEY_EXPECTATIONS_DE[key]}`),
  'Die Werte selbst werden hier nicht ausgegeben, damit keine Zugangsdaten im Protokoll landen.',
  NOT_STARTED_LINE_DE,
];

/**
 * Reports a rejected Commute_Threshold change and the value that stays active (8.14).
 *
 * The first sentence is the wording pinned in the design's error table; the second names the value
 * that remains in force, so the user can tell the rejection apart from a silently ignored edit.
 */
export const commuteThresholdRejectedMessageDe = (retainedMinutes: number): string =>
  `Pendelgrenze muss eine ganze Zahl zwischen ${COMMUTE_THRESHOLD_MIN_MINUTES} und ${COMMUTE_THRESHOLD_MAX_MINUTES} Minuten sein; der bisherige Wert bleibt aktiv. Weiterhin aktiv: ${retainedMinutes} Minuten.`;
