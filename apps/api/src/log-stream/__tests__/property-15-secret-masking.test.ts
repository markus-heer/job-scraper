/**
 * Property 15 of the job-search-tool design: secrets never reach the Log_Stream or the Web_App
 * unmasked.
 *
 * Requirement 14.9 is absolute and therefore a property rather than a list of cases: for *every*
 * log payload and *every* configured credential value, the serialized output that is persisted to
 * the Posting_Store and published to subscribers carries the fixed mask and never the credential,
 * at any nesting depth. The named cases — a credential as a whole value, inside a longer string, as
 * an object key, under a key that merely reads like a credential — live in `secret-masking.test.ts`;
 * what is established here is that no payload shape at all gets a credential through.
 *
 * The oracle is the serialized output, not the structure: `JSON.stringify` of the masked value is
 * searched for the credential. That is deliberately the same form the Posting_Store stores in its
 * JSON column and the GraphQL layer sends to the Web_App, so a credential hiding in an object *key*
 * or inside a nested array is caught by the same check as one sitting in a plain field. The second
 * half of the oracle asserts the mask is actually present whenever the input contained a credential,
 * which rules out the degenerate masker that drops the offending field altogether and would leave
 * the Log_View with no hint that something was removed.
 *
 * Two subjects, because 14.9 names two destinations. The pure masker is driven directly, and then
 * the same payloads go through `LogStreamService.emit` — the masking only satisfies the Requirement
 * if it sits in front of the write and the publication, so the rows the store received and the
 * messages a live subscriber received are both checked.
 *
 * Credentials are generated with recognisable prefixes and a hex body of at least 16 characters, so
 * a generated payload string cannot collide with one by accident, and every assertion about
 * "contained a credential" is computed from the actual input rather than assumed.
 */

// Feature: job-search-tool, Property 15 - Secrets never reach the Log_Stream or the Web_App unmasked

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type EnvConfig, SECRET_MASK } from '../../config/env.schema';
import type { LogMessage } from '../../prisma/prisma.types';
import { type LogMessageStore, LogStreamService } from '../log-stream.service';
import { createSecretMasker, maskSecretsInDetail, secretValuesOf } from '../secret-masking';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

const RUN = 'run-1';

/** A field name that matches no part of `SECRET_KEY_PATTERN`, so its value has to survive. */
const SURVIVING_KEY = 'hinweis';

/** The value under {@link SURVIVING_KEY}; masking must not turn the whole detail into a mask. */
const SURVIVING_VALUE = 'Abruf fehlgeschlagen';

/**
 * The realistic shapes a credential leaks in.
 *
 * A tidy `{ apiKey: … }` field is the case everybody remembers; the ones that actually leak are a
 * key pasted into a request URL, a bearer header echoed back by a failing provider and a connection
 * string in a driver error. Each template buries the credential inside a longer string, which is
 * what forces substring masking rather than whole-value comparison.
 */
const CREDENTIAL_TEMPLATES: readonly ((secret: string) => string)[] = [
  (secret) => secret,
  (secret) => `https://api.openrouteservice.org/v2/directions?api_key=${secret}&units=m`,
  (secret) => `Bearer ${secret}`,
  (secret) => `Verbindung fehlgeschlagen: ${secret} (401)`,
];

/** Buries a credential in one of the shapes above; the index is reduced into range by the caller. */
const embedCredential = (secret: string, template: number): string => {
  const shape = CREDENTIAL_TEMPLATES[template % CREDENTIAL_TEMPLATES.length];

  // The modulo keeps the index inside the array, so the fallback is unreachable; it is spelled out
  // because the compiler checks indexed access and a silent `!` would hide a real gap later.
  return shape === undefined ? secret : shape(secret);
};

/** The alphabet of a generated credential body. */
const HEX_DIGITS = [...'0123456789abcdef'];

/**
 * A credential value: a fixed prefix plus a hex body no payload string can collide with.
 *
 * The prefix is per configuration key, which also keeps the three generated credentials distinct
 * without a uniqueness filter.
 */
const credentialArbitrary = (prefix: string) =>
  fc
    .string({ unit: fc.constantFrom(...HEX_DIGITS), minLength: 16, maxLength: 32 })
    .map((body) => `${prefix}${body}`);

/**
 * A validated configuration carrying generated credentials.
 *
 * Going through `EnvConfig` and `secretValuesOf` rather than handing the masker a bare list keeps
 * the property on the path the running service takes: the credentials it masks are exactly the ones
 * the configuration declares secret.
 */
const envConfigArbitrary = fc
  .record({
    databaseUrl: credentialArbitrary('postgresql://jobs:'),
    routingApiKey: credentialArbitrary('ors-'),
    anthropicApiKey: credentialArbitrary('sk-ant-api03-'),
  })
  .map(({ databaseUrl, routingApiKey, anthropicApiKey }): EnvConfig => ({
    databaseUrl,
    homeAddress: 'Hörkherstraße 1d, 80689 München',
    commuteThresholdMinutes: 60,
    routingProvider: 'heigit',
    routingApiKey,
    anthropicApiKey,
    anthropicModel: 'claude-sonnet-4-5',
    relevanceEnabled: true,
    relevanceConcurrency: 2,
    relevanceMaxPerRun: 50,
    enrichmentGraceMinutes: 10,
    userAgentContact: 'kontakt@example.org',
    robotsPolicy: 'respect',
    apiPort: 4000,
    webPort: 5173,
    // The masking has nothing to do with the fixture switch; it is here because `EnvConfig` is
    // total and a partial one would not type-check.
    scraperFixtureMode: false,
  }));

/** An arbitrary JSON-shaped payload, as a component may hand it to `emit` as its `detail`. */
const { payload: payloadArbitrary } = fc.letrec<{ payload: unknown }>((tie) => ({
  payload: fc.oneof(
    { maxDepth: 3, depthSize: 'small' },
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('payload'), { maxLength: 4 }),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), tie('payload'), { maxKeys: 4 }),
  ),
}));

/** The structured context of a message: a record of arbitrary JSON-shaped values. */
const detailArbitrary = fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), payloadArbitrary, {
  maxKeys: 5,
});

/**
 * Where and how one credential is planted in a payload.
 *
 * `steps` is walked down the generated structure, so the credential lands at a depth and in a
 * container the generator chose rather than at a fixed place. `asKey` plants it as a property name,
 * which is part of the serialized output just like a value is. `template` decides whether it sits
 * bare or inside a longer string.
 */
interface InjectionPlan {
  readonly steps: readonly number[];
  readonly asKey: boolean;
  readonly template: number;
}

const injectionPlanArbitrary = fc.record<InjectionPlan>({
  steps: fc.array(fc.nat({ max: 7 }), { maxLength: 4 }),
  asKey: fc.boolean(),
  template: fc.nat({ max: CREDENTIAL_TEMPLATES.length - 1 }),
});

/** One plan per configured credential; `null` leaves that credential out of this payload. */
const injectionPlansArbitrary = fc.array(fc.option(injectionPlanArbitrary, { nil: null }), {
  minLength: 3,
  maxLength: 3,
});

/** Which credential the German message text carries, in which shape; `null` for a clean text. */
const textPlanArbitrary = fc.option(
  fc.record({
    credential: fc.nat({ max: 2 }),
    template: fc.nat({ max: CREDENTIAL_TEMPLATES.length - 1 }),
  }),
  { nil: null },
);

type Container = Record<string, unknown> | unknown[];

/**
 * Follows `steps` into the payload and answers the container the credential is planted in.
 *
 * A step that runs into a scalar or an empty container stops the descent, so every plan addresses a
 * real place in this particular generated structure instead of being discarded.
 */
const containerAt = (root: Record<string, unknown>, steps: readonly number[]): Container => {
  let current: Container = root;

  for (const step of steps) {
    const keys: (string | number)[] = Array.isArray(current)
      ? current.map((_entry, index) => index)
      : Object.keys(current);

    if (keys.length === 0) {
      break;
    }

    const key = keys[step % keys.length];

    if (key === undefined) {
      break;
    }

    const next = (current as Record<string | number, unknown>)[key];

    if (next === null || typeof next !== 'object') {
      break;
    }

    current = next as Container;
  }

  return current;
};

/** Plants one credential string in a container, as a value or as a property name. */
const plant = (container: Container, text: string, asKey: boolean, index: number): void => {
  if (Array.isArray(container)) {
    container.push(asKey ? { [text]: 'wert' } : text);

    return;
  }

  if (asKey) {
    container[text] = 'wert';

    return;
  }

  container[`kontext${index}`] = text;
};

/**
 * A detail object with the planned credentials planted in it.
 *
 * The generated structure is cloned first, so the arbitrary stays reusable across the two
 * properties and the immutability assertion has an untouched reference point.
 */
const buildDetail = (
  detail: Record<string, unknown>,
  secrets: readonly string[],
  plans: readonly (InjectionPlan | null)[],
): PrismaJson.LogMessageDetailJson => {
  const built = JSON.parse(JSON.stringify(detail)) as Record<string, unknown>;

  built[SURVIVING_KEY] = SURVIVING_VALUE;

  // One plan per credential, paired by position: a credential whose plan is absent stays out of
  // this payload, which is what makes "contained a credential" a generated condition rather than a
  // constant one.
  secrets.forEach((secret, index) => {
    const plan = plans[index] ?? null;

    if (plan === null) {
      return;
    }

    plant(
      containerAt(built, plan.steps),
      embedCredential(secret, plan.template),
      plan.asKey,
      index,
    );
  });

  return built as PrismaJson.LogMessageDetailJson;
};

/** The German text of the message, with or without a credential in it. */
const buildText = (
  secrets: readonly string[],
  plan: { readonly credential: number; readonly template: number } | null,
): string => {
  const secret = plan === null ? undefined : secrets[plan.credential % secrets.length];

  if (plan === null || secret === undefined) {
    return 'Der Abruf der Plattform ist fehlgeschlagen.';
  }

  return `Der Abruf ist fehlgeschlagen: ${embedCredential(secret, plan.template)}`;
};

/**
 * Asserts the two halves of the oracle on one serialized output.
 *
 * `serialized` is what leaves the Job_Tool — the JSON column of the Posting_Store or the GraphQL
 * payload of the Web_App. No credential may appear in it, and the mask has to appear whenever the
 * input carried one.
 */
const expectMasked = (serialized: string, rawSerialized: string, secrets: readonly string[]) => {
  for (const secret of secrets) {
    expect(serialized).not.toContain(secret);
  }

  if (secrets.some((secret) => rawSerialized.includes(secret))) {
    expect(serialized).toContain(SECRET_MASK);
  }
};

interface CreateData {
  readonly runId: string;
  readonly sequence: number;
  readonly createdAt: Date;
  readonly level: LogMessage['level'];
  readonly code: string;
  readonly messageDe: string;
  readonly platform?: LogMessage['platform'];
  readonly detail?: PrismaJson.LogMessageDetailJson;
}

/** In-memory stand-in for the `LogMessage` delegate, recording what reached the Posting_Store. */
const createStore = () => {
  const rows: LogMessage[] = [];

  const logMessage = {
    create: ({ data }: { data: CreateData }) => {
      const row: LogMessage = {
        id: `log-${rows.length + 1}`,
        runId: data.runId,
        sequence: data.sequence,
        createdAt: data.createdAt,
        platform: data.platform ?? null,
        level: data.level,
        code: data.code,
        messageDe: data.messageDe,
        detail: data.detail ?? null,
      };

      rows.push(row);

      return Promise.resolve(row);
    },
    aggregate: () => Promise.resolve({ _max: { sequence: null } }),
  };

  return { store: { logMessage } as unknown as LogMessageStore, rows };
};

/** Yields to the microtask queue, so a started stream has established its subscription. */
const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

/** Reads `count` messages from a stream and then stops iterating, releasing the subscription. */
const take = async (
  stream: AsyncIterableIterator<LogMessage>,
  count: number,
): Promise<LogMessage[]> => {
  const received: LogMessage[] = [];

  for await (const message of stream) {
    received.push(message);

    if (received.length === count) {
      break;
    }
  }

  return received;
};

describe('Property 15: Secrets never reach the Log_Stream or the Web_App unmasked', () => {
  /**
   * **Validates: Requirements 14.9**
   *
   * For all JSON-shaped log payloads and for all configured credential values planted at an
   * arbitrary path — bare, inside a longer string or as an object key — the serialized masked
   * payload contains no credential and contains the fixed mask whenever the input did. The caller's
   * object is left untouched, so a component that keeps a reference to its detail does not see it
   * change under itself.
   */
  it('removes every configured credential from a payload at any nesting depth', () => {
    fc.assert(
      fc.property(
        envConfigArbitrary,
        detailArbitrary,
        injectionPlansArbitrary,
        textPlanArbitrary,
        (env, generatedDetail, plans, textPlan) => {
          const secrets = secretValuesOf(env);
          const detail = buildDetail(generatedDetail, secrets, plans);
          const rawSerialized = JSON.stringify(detail);

          const masked = maskSecretsInDetail(detail, secrets);

          expectMasked(JSON.stringify(masked), rawSerialized, secrets);

          // The mask replaces credentials, it does not flatten the payload: a field whose name and
          // value carry nothing secret arrives unchanged, which is what keeps the Log_View useful.
          expect(masked[SURVIVING_KEY]).toBe(SURVIVING_VALUE);

          // Masking answers with a copy; the input the caller still holds is unchanged.
          expect(JSON.stringify(detail)).toBe(rawSerialized);

          const text = buildText(secrets, textPlan);

          expectMasked(createSecretMasker(secrets).maskText(text), text, secrets);
        },
      ),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 14.9**
   *
   * The same payloads through `emit`: for all log payloads and all configured credential values,
   * neither the row that reached the Posting_Store nor the message a live subscriber received
   * contains a credential — in the German text or anywhere in the structured context. A message
   * without a structured context goes through the same emission, so the masking cannot be satisfied
   * by rejecting `undefined` details.
   */
  it('lets no credential reach the Posting_Store or a live subscriber', async () => {
    await fc.assert(
      fc.asyncProperty(
        envConfigArbitrary,
        detailArbitrary,
        injectionPlansArbitrary,
        textPlanArbitrary,
        async (env, generatedDetail, plans, textPlan) => {
          const secrets = secretValuesOf(env);
          const detail = buildDetail(generatedDetail, secrets, plans);
          const text = buildText(secrets, textPlan);
          const rawSerialized = JSON.stringify({ detail, text });

          const { store, rows } = createStore();
          const service = new LogStreamService(store, createSecretMasker(secrets));

          const stream = service.stream(RUN);
          const collecting = take(stream, 2);

          // The subscription has to exist before the first emission, or the published message would
          // be missed and the subscriber side of the oracle would pass without having seen anything.
          await tick();

          await service.emit({
            runId: RUN,
            level: 'ERROR',
            code: 'platform.pageFetchFailed',
            messageDe: text,
            platform: 'STEPSTONE',
            detail,
          });

          await service.emit({
            runId: RUN,
            level: 'INFO',
            code: 'run.finished',
            messageDe: text,
          });

          const published = await collecting;

          expect(rows).toHaveLength(2);
          expect(published).toHaveLength(2);

          expectMasked(JSON.stringify(rows), rawSerialized, secrets);
          expectMasked(JSON.stringify(published), rawSerialized, secrets);
        },
      ),
      PROPERTY_RUNS,
    );
  });
});
