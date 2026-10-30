/**
 * The shape of the local environment file (1.12).
 *
 * This file is pure: it takes a record of raw strings and answers whether the Job_Tool can run
 * with them. Nothing here reads `process.env`, touches the file system or prints — `env-file.ts`
 * loads the file, `env.config.ts` decides what to do with a failure and `config.service.ts`
 * resolves the two configurable values against the `Setting` table. Keeping the validation itself
 * side-effect free is what makes the fail-fast behaviour testable without spawning a process.
 *
 * Two classes of failure are distinguished, because the requirements treat them differently:
 *
 * - A key that is missing or empty stops the startup and is reported by name (1.15). All 15 keys
 *   in {@link REQUIRED_ENV_KEYS} are required; there is no silent default for any of them.
 *   `.env.example` documents two keys beyond them: `POSTGRES_PORT`, which docker-compose.yml reads
 *   to bind the host port of the Posting_Store container and which nothing here validates because
 *   no part of the API_Service ever reads it, and `SCRAPER_FIXTURE_MODE`, which is validated here
 *   but is deliberately *not* required — see {@link OPTIONAL_ENV_KEYS}.
 * - A `COMMUTE_THRESHOLD_MINUTES` that is present but is not an integer from 5 to 240 is a
 *   *rejected configuration change* (8.14), not a reason to refuse to start. It surfaces as
 *   `commuteThresholdMinutes: null`, and the resolution against the `Setting` table then keeps the
 *   previously accepted value. Every other invalid value stops the startup: the Job_Tool has no
 *   stored previous value to fall back to for those, so continuing would mean guessing.
 *
 * Values never appear in any output of this module. Only key names and the permitted range leave
 * it, which is what keeps the API keys and the database password out of the console (14.9).
 *
 * Requirements: 1.12, 1.15, 8.10, 8.14, 14.9.
 */

import { z } from 'zod';

/**
 * Every key the Job_Tool requires, in the order of `.env.example`.
 *
 * The order is the order of the reported key names, so a user comparing the error output against
 * the template file reads both top to bottom.
 */
export const REQUIRED_ENV_KEYS = [
  'DATABASE_URL',
  'HOME_ADDRESS',
  'COMMUTE_THRESHOLD_MINUTES',
  'ROUTING_PROVIDER',
  'ROUTING_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'RELEVANCE_ENABLED',
  'RELEVANCE_CONCURRENCY',
  'RELEVANCE_MAX_PER_RUN',
  'ENRICHMENT_GRACE_MINUTES',
  'USER_AGENT_CONTACT',
  'ROBOTS_POLICY',
  'API_PORT',
  'WEB_PORT',
] as const;

/** One of the 15 required environment keys. */
export type EnvKey = (typeof REQUIRED_ENV_KEYS)[number];

/**
 * The two values of the Robots_Policy (14.10).
 *
 * Required rather than defaulted, and spelled out rather than a boolean, because this is the one
 * configuration value that changes what the Job_Tool is willing to request from a third party. A
 * missing key stops the start by name, so the value is always something somebody chose.
 *
 * `respect` gates a retrieval on the evaluated robots.txt (14.2, 14.3). `ignore` retrieves anyway
 * and reports the prohibition as a warning instead (14.11, 14.12). **Under both values the
 * robots.txt is still retrieved and evaluated and a stated `Crawl-delay` is still applied** (14.1,
 * 14.4) — the policy decides only whether a prohibition stops the retrieval, never whether the
 * Job_Tool bothers to look or how fast it goes.
 */
export const ROBOTS_POLICIES = ['respect', 'ignore'] as const;

/** Whether an evaluated robots.txt prohibition gates a retrieval (14.10). */
export type RobotsPolicy = (typeof ROBOTS_POLICIES)[number];

/**
 * Keys the API_Service reads but does not require.
 *
 * Exactly one: `SCRAPER_FIXTURE_MODE`, the switch that puts the retrieval, the Routing_Provider and
 * the AI_Provider on fixtures so the E2E suite can drive a whole Scrape_Run without a single
 * external request (design, Testing Strategy; task 21.1).
 *
 * Why it is optional rather than required, although every other key the API_Service reads is
 * required: a required key has to be filled in before the Job_Tool starts at all, and this one must
 * be *absent* in every normal installation. Making it required would mean asking the user to
 * configure a test switch in order to run the application, and a user who then set it to the wrong
 * value would silently get fixture data instead of real Job_Posting. Absent therefore has to mean
 * "off", which is precisely what "optional with a default" is. It is still validated: a value that
 * is present but is neither an on nor an off spelling stops the startup like any other unusable
 * value, so a typo cannot read as "off".
 *
 * `.env.example` documents it as commented-out lines with that reasoning, and the key-set test
 * compares the template against the required keys plus this list plus the Compose-only key, so a
 * key that is documented but validated nowhere still fails.
 */
export const OPTIONAL_ENV_KEYS = ['SCRAPER_FIXTURE_MODE'] as const;

/** One of the optional environment keys. */
export type OptionalEnvKey = (typeof OPTIONAL_ENV_KEYS)[number];

/** Any environment key the API_Service reads, required or not. */
export type EnvKeyName = EnvKey | OptionalEnvKey;

/**
 * Keys whose value is a credential.
 *
 * `DATABASE_URL` counts: it carries the database password. Every output path that reports a
 * configuration value replaces these with {@link SECRET_MASK} (14.9).
 */
export const SECRET_ENV_KEYS: readonly EnvKey[] = [
  'DATABASE_URL',
  'ROUTING_API_KEY',
  'ANTHROPIC_API_KEY',
];

/** The fixed mask that replaces a credential in any output, matching the Log_Stream masking. */
export const SECRET_MASK = '***';

/** Permitted range of the Commute_Threshold in minutes (8.10). */
export const COMMUTE_THRESHOLD_MIN_MINUTES = 5;
export const COMMUTE_THRESHOLD_MAX_MINUTES = 240;

/** The two Routing_Provider implementations the Commute_Service can be pointed at. */
export const ROUTING_PROVIDERS = ['heigit', 'google'] as const;
export type RoutingProvider = (typeof ROUTING_PROVIDERS)[number];

/**
 * An integer read from a string, without numeric coercion.
 *
 * `z.coerce.number()` would accept `""` as 0 and `"4.5"` as 4.5; both are configuration mistakes
 * that must be named rather than rounded away. Matching the digits first makes "not an integer"
 * (8.14) a parse failure instead of a value that silently changes meaning.
 */
const integerInRange = (min: number, max: number) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min).max(max));

/** A local port. Ports below 1024 need elevated privileges, which the Job_Tool never has. */
const localPort = () => integerInRange(1024, 65_535);

/** `true` or `false` spelled out, so that a typo is an error rather than a falsy value. */
const booleanFlag = () => z.enum(['true', 'false']).transform((value) => value === 'true');

/** The spellings {@link SCRAPER_FIXTURE_MODE_KEY} accepts as "on"; anything else is a typo. */
export const FIXTURE_MODE_ON_VALUES = ['1', 'true'] as const;

/** The spellings that mean "off". Absent and empty mean "off" as well. */
export const FIXTURE_MODE_OFF_VALUES = ['0', 'false'] as const;

/**
 * The fixture-mode switch.
 *
 * Both spellings are accepted because both are already in use: the design's Testing Strategy writes
 * `SCRAPER_FIXTURE_MODE=1`, and `RELEVANCE_ENABLED` establishes `true` / `false` as the repository's
 * boolean convention. Accepting the two of them costs nothing, while rejecting one of them would
 * guarantee that someone eventually sets the other and is told the switch is invalid.
 */
const fixtureModeFlag = () =>
  z
    .enum([...FIXTURE_MODE_ON_VALUES, ...FIXTURE_MODE_OFF_VALUES])
    .transform((value) => (FIXTURE_MODE_ON_VALUES as readonly string[]).includes(value));

/** Schema of the 13 keys whose invalid value stops the startup. */
export const envSchemaWithoutCommuteThreshold = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .regex(/^postgres(ql)?:\/\//),
  HOME_ADDRESS: z.string().min(1).max(200),
  ROUTING_PROVIDER: z.enum(ROUTING_PROVIDERS),
  ROUTING_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().min(1).max(100),
  RELEVANCE_ENABLED: booleanFlag(),
  RELEVANCE_CONCURRENCY: integerInRange(1, 16),
  // Raised from 1,000 with the Page_Safety_Limit of 13.10: a Scrape_Run that reads a result list to
  // its end (13.3) can produce several thousand Job_Posting, and a cap below the candidate count
  // silently leaves the rest unassessed until a later run. The upper bound stays finite because each
  // assessment is a paid AI_Provider request; the Log_Stream names how many the cap skipped.
  RELEVANCE_MAX_PER_RUN: integerInRange(1, 20_000),
  ENRICHMENT_GRACE_MINUTES: integerInRange(1, 120),
  USER_AGENT_CONTACT: z.string().min(1).max(200),
  ROBOTS_POLICY: z.enum(ROBOTS_POLICIES),
  API_PORT: localPort(),
  WEB_PORT: localPort(),
});

/** Schema of the Commute_Threshold on its own, because its failure is recoverable (8.14). */
export const commuteThresholdSchema = integerInRange(
  COMMUTE_THRESHOLD_MIN_MINUTES,
  COMMUTE_THRESHOLD_MAX_MINUTES,
);

/** The one optional key, which is the only key whose absence is a value rather than a failure. */
export const SCRAPER_FIXTURE_MODE_KEY = 'SCRAPER_FIXTURE_MODE' satisfies OptionalEnvKey;

/** Schema of {@link SCRAPER_FIXTURE_MODE_KEY}; absent and empty both mean "off". */
export const scraperFixtureModeSchema = fixtureModeFlag();

/**
 * The complete environment file schema.
 *
 * Exported for the key-set test and for documentation value; the parse below deliberately applies
 * the two halves separately so that an invalid Commute_Threshold does not take the rest down with
 * it.
 */
export const envSchema = envSchemaWithoutCommuteThreshold.extend({
  COMMUTE_THRESHOLD_MINUTES: commuteThresholdSchema,
});

/**
 * The validated configuration.
 *
 * `commuteThresholdMinutes` is `null` exactly when the configured value was rejected (8.14). The
 * effective value is not decided here — `AppConfigService` resolves it against the last accepted
 * value in the `Setting` table and exposes a plain number to every consumer.
 */
export interface EnvConfig {
  readonly databaseUrl: string;
  readonly homeAddress: string;
  readonly commuteThresholdMinutes: number | null;
  readonly routingProvider: RoutingProvider;
  readonly routingApiKey: string;
  readonly anthropicApiKey: string;
  readonly anthropicModel: string;
  readonly relevanceEnabled: boolean;
  readonly relevanceConcurrency: number;
  readonly relevanceMaxPerRun: number;
  readonly enrichmentGraceMinutes: number;
  readonly userAgentContact: string;
  /** Whether an evaluated robots.txt prohibition gates a retrieval (14.10). */
  readonly robotsPolicy: RobotsPolicy;
  readonly apiPort: number;
  readonly webPort: number;
  /**
   * Whether the retrieval, the Routing_Provider and the AI_Provider are served from fixtures
   * (design, Testing Strategy).
   *
   * `false` in every normal installation, including when the key is absent entirely. `true` is the
   * E2E harness of task 21.1 and nothing else: it swaps the Playwright retrieval runtime for the
   * frozen Platform fixtures, the HeiGIT Routing_Provider for a deterministic double and the
   * Anthropic assessor for one as well, and it makes constructing any of the three real
   * implementations an error rather than a possibility — see `./fixture-mode.ts`.
   */
  readonly scraperFixtureMode: boolean;
}

/** Raw source of environment values; `process.env` satisfies it. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Outcome of validating an environment source. */
export type EnvParseResult =
  | { readonly outcome: 'valid'; readonly config: EnvConfig }
  /** At least one required key is missing or empty — no service starts (1.15). */
  | { readonly outcome: 'incomplete'; readonly missingKeys: readonly EnvKey[] }
  /** Every required key is present, but at least one unrecoverable value is invalid. */
  | { readonly outcome: 'invalid'; readonly invalidKeys: readonly EnvKeyName[] };

/** Trimmed view of the source, restricted to the required keys. A missing key becomes `''`. */
const pickEnvValues = (source: EnvSource): Record<EnvKey, string> =>
  Object.fromEntries(REQUIRED_ENV_KEYS.map((key) => [key, (source[key] ?? '').trim()])) as Record<
    EnvKey,
    string
  >;

/** The required keys that an issue list points at, in `.env.example` order and without repeats. */
const invalidKeysOf = (error: z.ZodError): readonly EnvKey[] => {
  const keys = new Set(
    error.issues
      .map((issue) => issue.path[0])
      .filter((key): key is EnvKey => REQUIRED_ENV_KEYS.includes(key as EnvKey)),
  );

  return REQUIRED_ENV_KEYS.filter((key) => keys.has(key));
};

/**
 * The fixture-mode switch of a source, or the key name when its value is unusable.
 *
 * Separated from the required-key pass because the two failure modes differ: an absent value is the
 * default rather than an omission, while a present value that spells neither state is a typo that
 * must not be read as "off".
 */
const parseFixtureMode = (source: EnvSource): boolean | OptionalEnvKey => {
  const raw = (source[SCRAPER_FIXTURE_MODE_KEY] ?? '').trim();

  if (raw === '') {
    return false;
  }

  const result = scraperFixtureModeSchema.safeParse(raw);

  return result.success ? result.data : SCRAPER_FIXTURE_MODE_KEY;
};

/**
 * Validates an environment source.
 *
 * The missing-key pass runs before the schema, so that a user who has not filled in the template
 * gets the list of keys to fill in rather than 14 type complaints about empty strings.
 */
export const parseEnvironment = (source: EnvSource): EnvParseResult => {
  const values = pickEnvValues(source);
  const missingKeys = REQUIRED_ENV_KEYS.filter((key) => values[key] === '');

  if (missingKeys.length > 0) {
    return { outcome: 'incomplete', missingKeys };
  }

  const fixtureMode = parseFixtureMode(source);
  // Reported after the required keys, which is where `.env.example` documents it as well.
  const invalidOptionalKeys: readonly OptionalEnvKey[] =
    typeof fixtureMode === 'string' ? [fixtureMode] : [];
  const base = envSchemaWithoutCommuteThreshold.safeParse(values);

  if (!base.success) {
    // The Commute_Threshold is reported together with the others here: the startup stops anyway,
    // so naming every invalid key at once saves the user a second attempt.
    const commuteThreshold = commuteThresholdSchema.safeParse(values.COMMUTE_THRESHOLD_MINUTES);
    const invalidKeys = invalidKeysOf(base.error);

    return {
      outcome: 'invalid',
      invalidKeys: [
        ...(commuteThreshold.success
          ? invalidKeys
          : REQUIRED_ENV_KEYS.filter(
              (key) => invalidKeys.includes(key) || key === 'COMMUTE_THRESHOLD_MINUTES',
            )),
        ...invalidOptionalKeys,
      ],
    };
  }

  if (invalidOptionalKeys.length > 0) {
    return { outcome: 'invalid', invalidKeys: invalidOptionalKeys };
  }

  const commuteThreshold = commuteThresholdSchema.safeParse(values.COMMUTE_THRESHOLD_MINUTES);

  return {
    outcome: 'valid',
    config: {
      databaseUrl: base.data.DATABASE_URL,
      homeAddress: base.data.HOME_ADDRESS,
      commuteThresholdMinutes: commuteThreshold.success ? commuteThreshold.data : null,
      routingProvider: base.data.ROUTING_PROVIDER,
      routingApiKey: base.data.ROUTING_API_KEY,
      anthropicApiKey: base.data.ANTHROPIC_API_KEY,
      anthropicModel: base.data.ANTHROPIC_MODEL,
      relevanceEnabled: base.data.RELEVANCE_ENABLED,
      relevanceConcurrency: base.data.RELEVANCE_CONCURRENCY,
      relevanceMaxPerRun: base.data.RELEVANCE_MAX_PER_RUN,
      enrichmentGraceMinutes: base.data.ENRICHMENT_GRACE_MINUTES,
      userAgentContact: base.data.USER_AGENT_CONTACT,
      robotsPolicy: base.data.ROBOTS_POLICY,
      apiPort: base.data.API_PORT,
      webPort: base.data.WEB_PORT,
      scraperFixtureMode: fixtureMode === true,
    },
  };
};

/**
 * A view of the configuration that is safe to log (14.9).
 *
 * Credentials are replaced with the fixed mask rather than shortened or partially shown: a prefix
 * of an API key is still key material. The remaining values are useful in a bug report, which is
 * why they are kept.
 */
export const describeEnvConfig = (
  config: EnvConfig,
): Readonly<Record<string, string | number | boolean | null>> => ({
  databaseUrl: SECRET_MASK,
  homeAddress: config.homeAddress,
  commuteThresholdMinutes: config.commuteThresholdMinutes,
  routingProvider: config.routingProvider,
  routingApiKey: SECRET_MASK,
  anthropicApiKey: SECRET_MASK,
  anthropicModel: config.anthropicModel,
  relevanceEnabled: config.relevanceEnabled,
  relevanceConcurrency: config.relevanceConcurrency,
  relevanceMaxPerRun: config.relevanceMaxPerRun,
  enrichmentGraceMinutes: config.enrichmentGraceMinutes,
  userAgentContact: config.userAgentContact,
  robotsPolicy: config.robotsPolicy,
  apiPort: config.apiPort,
  webPort: config.webPort,
  // Worth reporting precisely because it changes where the data comes from: a bug report from a
  // process that ran on fixtures is a different report from one that ran against the Platform.
  scraperFixtureMode: config.scraperFixtureMode,
});
