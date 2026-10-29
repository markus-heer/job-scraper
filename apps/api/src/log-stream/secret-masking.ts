/**
 * Secret masking for the Log_Stream (14.9).
 *
 * This file is pure: it takes a value and a list of credential values and answers with a copy in
 * which no credential is left. Nothing here reads `process.env`, the configuration or the clock —
 * the values to mask arrive as an argument, which is what makes the masking testable without a
 * Nest context and what keeps a second source of truth for "what is secret" from appearing.
 *
 * 14.9 is absolute: no API key and no database password may appear in an output to the Log_Stream
 * or to the Web_App. The Log_Stream persists what it publishes, so masking in front of the write
 * covers both sides at once. Two rules do the work, and they overlap on purpose:
 *
 * - *By value*: every occurrence of a configured credential is replaced, at any nesting depth and
 *   also inside a longer string — a key pasted into a URL query parameter or an error message from
 *   a provider library is the realistic leak, not a tidy `{ apiKey: … }` object.
 * - *By key name*: every value under a key matching {@link SECRET_KEY_PATTERN} is replaced
 *   wholesale. This catches the credential nobody configured here: a bearer token minted at
 *   runtime, a session cookie, a provider's `Authorization` header echoed back in a failure.
 *
 * Replacement is total rather than partial. A prefix of an API key is still key material, so the
 * mask is the fixed {@link SECRET_MASK} and never a shortened or hinted form.
 *
 * Object *keys* are masked too, not just values. A credential can end up as a property name — a
 * map keyed by token, a response object keyed by the query that produced it — and a key is part of
 * the serialized output just like a value is.
 *
 * Requirements: 14.9.
 */

import { type EnvConfig, type EnvKey, SECRET_ENV_KEYS, SECRET_MASK } from '../config/env.schema';

/**
 * Key names whose value is treated as a credential regardless of what it contains.
 *
 * Substring matching, not a whole-word match: `apiKey`, `api_key`, `accessToken`, `clientSecret`
 * and `Authorization` all have to be caught, and the cost of a false positive — a masked
 * `keyword` or `monkey` field in a debug detail — is a lost debugging hint, while the cost of a
 * false negative is a leaked credential.
 */
export const SECRET_KEY_PATTERN = /key|token|secret|authorization/i;

/**
 * Stands in for a value that refers back to its own container.
 *
 * A cyclic `detail` object is a caller mistake — the column is JSON and could not store it — but
 * the Log_Stream is the channel that reports mistakes, so it must not be the thing that overflows
 * the stack while doing so.
 */
export const CIRCULAR_MARKER = '[circular]';

/** Masks the text and the structured context of a message against one fixed credential set. */
export interface SecretMasker {
  /** The German message text, with every credential occurrence replaced. */
  readonly maskText: (text: string) => string;
  /** The structured context, masked by value and by key name at any nesting depth. */
  readonly maskDetail: (detail: PrismaJson.LogMessageDetailJson) => PrismaJson.LogMessageDetailJson;
}

/**
 * Where in the validated configuration the value of each credential key lives.
 *
 * `SECRET_ENV_KEYS` names the keys; `EnvConfig` holds the values under camel-cased names. This map
 * is the join between the two. It is deliberately `Partial`, because the non-credential keys have
 * no entry — and the completeness of the credential side is asserted by a unit test rather than by
 * a runtime throw, since a missing entry must not be able to take the Log_Stream down.
 */
const secretValueByEnvKey = (env: EnvConfig): Partial<Record<EnvKey, string>> => ({
  DATABASE_URL: env.databaseUrl,
  ROUTING_API_KEY: env.routingApiKey,
  ANTHROPIC_API_KEY: env.anthropicApiKey,
});

/** Drops empty and duplicate credentials and orders the rest by descending length. */
const normaliseSecrets = (secretValues: readonly string[]): readonly string[] =>
  [...new Set(secretValues)]
    // An empty credential would make `split('')` explode every string into its characters; no
    // configuration reaches this point with one, because every credential key is required (1.15).
    .filter((value) => value !== '')
    .sort((left, right) => right.length - left.length);

/**
 * The credential values of a configuration, longest first.
 *
 * Longest first matters when one credential contains another: replacing the longer value first
 * leaves no remainder of it behind that a later, shorter replacement could cut in half.
 */
export const secretValuesOf = (env: EnvConfig): readonly string[] => {
  const valueByKey = secretValueByEnvKey(env);

  return normaliseSecrets(SECRET_ENV_KEYS.map((key) => valueByKey[key] ?? ''));
};

/**
 * Every occurrence of every credential in a string, replaced by the fixed mask.
 *
 * Expects an already normalised credential list, which is why it is not exported: it is called
 * once per string and per key of a traversal, so normalising here would repeat work that the entry
 * points have already done.
 */
const replaceSecrets = (text: string, secrets: readonly string[]): string =>
  secrets.reduce((masked, secret) => masked.split(secret).join(SECRET_MASK), text);

/** Every occurrence of every credential in a string, replaced by the fixed mask. */
export const maskSecretsInText = (text: string, secrets: readonly string[]): string =>
  replaceSecrets(text, normaliseSecrets(secrets));

/** Whether a string carries a credential anywhere inside it. */
const containsSecret = (text: string, secrets: readonly string[]): boolean =>
  secrets.some((secret) => text.includes(secret));

/**
 * Masks one value of the structured context.
 *
 * `keyIsSecret` is the verdict about the key this value sits under: when it is `true` the whole
 * value is dropped, whatever its shape, because a credential under `authorization` can be a
 * string, a number or an object full of headers and partial masking would defeat the point.
 *
 * `path` holds the containers currently being walked, so only a genuine cycle is cut short; the
 * same object appearing twice side by side is masked twice.
 */
const maskValue = (
  value: unknown,
  secrets: readonly string[],
  keyIsSecret: boolean,
  path: WeakSet<object>,
): unknown => {
  if (value === null || value === undefined) {
    // Nothing to leak, and inventing a mask here would turn an absent field into a present one.
    return value;
  }

  if (keyIsSecret) {
    return SECRET_MASK;
  }

  if (typeof value === 'string') {
    return replaceSecrets(value, secrets);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    // A credential that is spelled as digits is a pathological configuration, but the serialized
    // output would still contain it, so the stringified form is checked rather than assumed safe.
    return containsSecret(String(value), secrets) ? SECRET_MASK : value;
  }

  if (typeof value !== 'object') {
    // A function or a symbol: not storable in the JSON column and not inspectable for credentials
    // without stringifying its source. It is dropped rather than carried along.
    return SECRET_MASK;
  }

  if (value instanceof Date) {
    // A timestamp carries no credential, and walking it as an object would flatten it to `{}`.
    return value;
  }

  if (path.has(value)) {
    return CIRCULAR_MARKER;
  }

  path.add(value);

  const masked = Array.isArray(value)
    ? value.map((entry) => maskValue(entry, secrets, false, path))
    : maskRecord(value, secrets, path);

  path.delete(value);

  return masked;
};

/** Masks every key and every value of one object level. */
const maskRecord = (
  record: object,
  secrets: readonly string[],
  path: WeakSet<object>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      replaceSecrets(key, secrets),
      maskValue(value, secrets, SECRET_KEY_PATTERN.test(key), path),
    ]),
  );

/**
 * The structured context of a message with every credential removed, at any nesting depth.
 *
 * A copy is returned; the caller's object is never modified, so a detail object a caller still
 * holds a reference to does not change under it.
 */
export const maskSecretsInDetail = (
  detail: PrismaJson.LogMessageDetailJson,
  secrets: readonly string[],
): PrismaJson.LogMessageDetailJson =>
  // The detail object itself starts out on the path, so a field pointing back at the top level is
  // cut short at the first encounter rather than one level deeper.
  maskRecord(detail, normaliseSecrets(secrets), new WeakSet([detail]));

/**
 * A masker bound to one credential set.
 *
 * The set is fixed at construction because the configuration is fixed for the lifetime of the
 * process (1.12): the environment file is read once at startup, so re-reading it per message would
 * buy nothing and would make every emission depend on the configuration service.
 */
export const createSecretMasker = (secretValues: readonly string[]): SecretMasker => {
  const secrets = normaliseSecrets(secretValues);

  return {
    maskText: (text) => replaceSecrets(text, secrets),
    maskDetail: (detail) => maskRecord(detail, secrets, new WeakSet([detail])),
  };
};
