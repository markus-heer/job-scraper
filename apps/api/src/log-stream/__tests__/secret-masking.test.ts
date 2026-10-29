/**
 * Secret masking of the Log_Stream (14.9).
 *
 * Two subjects. The pure masker is tested directly: a credential is replaced wherever it occurs —
 * as a whole value, inside a longer string, at any nesting depth, inside an array and even as an
 * object key — and a value sitting under a key that reads like a credential is dropped whatever
 * its shape. The service is then tested through `emit`, because 14.9 is only satisfied if the
 * masking actually sits in front of the write and the publication rather than being available to
 * callers who remember to use it.
 *
 * The exhaustive version of this — every payload, every credential, every nesting depth — is
 * Property 15 in task 6.5. What is asserted here are the named cases that have to hold and the
 * wiring that the property test cannot see.
 *
 * Requirements: 14.9.
 */

import { Global, type INestApplicationContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENV_CONFIG } from '../../config/env.config';
import { type EnvConfig, SECRET_ENV_KEYS, SECRET_MASK } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';
import type { LogMessage } from '../../prisma/prisma.types';
import { LogStreamModule } from '../log-stream.module';
import { type LogMessageStore, LogStreamService } from '../log-stream.service';
import {
  CIRCULAR_MARKER,
  createSecretMasker,
  maskSecretsInText,
  type SecretMasker,
  secretValuesOf,
} from '../secret-masking';

const DATABASE_URL = 'postgresql://jobs:s3cr3t-pw@localhost:5432/jobs';
const ROUTING_KEY = 'ors-5f3a9c21b7e4';
const ANTHROPIC_KEY = 'sk-ant-api03-ZmFrZWtleQ';

/** A validated configuration with recognisable credentials, so a leak is visible in a failure. */
const envConfig: EnvConfig = {
  databaseUrl: DATABASE_URL,
  homeAddress: 'Hörkherstraße 1d, 80689 München',
  commuteThresholdMinutes: 60,
  routingProvider: 'heigit',
  routingApiKey: ROUTING_KEY,
  anthropicApiKey: ANTHROPIC_KEY,
  anthropicModel: 'claude-sonnet-4-5',
  relevanceEnabled: true,
  relevanceConcurrency: 2,
  relevanceMaxPerRun: 50,
  enrichmentGraceMinutes: 10,
  userAgentContact: 'kontakt@example.org',
  apiPort: 4000,
  webPort: 5173,
  scraperFixtureMode: false,
};

const RUN = 'run-1';

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

/** Records what reached the Posting_Store, which is what 14.9 constrains. */
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

let masker: SecretMasker;

beforeEach(() => {
  masker = createSecretMasker(secretValuesOf(envConfig));
});

describe('secretValuesOf', () => {
  it('yields a value for every key declared as a credential', () => {
    // Guards the join between `SECRET_ENV_KEYS` and `EnvConfig`: a key declared secret without a
    // value to read would leave that credential unmasked, which this count catches.
    expect(secretValuesOf(envConfig)).toHaveLength(SECRET_ENV_KEYS.length);
  });

  it('yields the database password and both API keys', () => {
    expect([...secretValuesOf(envConfig)].sort()).toEqual(
      [DATABASE_URL, ROUTING_KEY, ANTHROPIC_KEY].sort(),
    );
  });

  it('yields no non-credential configuration value', () => {
    const values = secretValuesOf(envConfig);

    expect(values).not.toContain(envConfig.homeAddress);
    expect(values).not.toContain(envConfig.anthropicModel);
    expect(values).not.toContain(envConfig.userAgentContact);
  });
});

describe('maskText', () => {
  it('replaces a credential that is the whole text', () => {
    expect(masker.maskText(ANTHROPIC_KEY)).toBe(SECRET_MASK);
  });

  it('replaces a credential embedded in a longer string', () => {
    expect(
      masker.maskText(`GET https://api.openrouteservice.org/v2?api_key=${ROUTING_KEY}&x=1`),
    ).toBe(`GET https://api.openrouteservice.org/v2?api_key=${SECRET_MASK}&x=1`);
  });

  it('replaces every occurrence, not only the first', () => {
    const masked = masker.maskText(`${ROUTING_KEY} und nochmal ${ROUTING_KEY}`);

    expect(masked).toBe(`${SECRET_MASK} und nochmal ${SECRET_MASK}`);
    expect(masked).not.toContain(ROUTING_KEY);
  });

  it('replaces the database password by replacing the connection string that carries it', () => {
    expect(masker.maskText(`Verbindung zu ${DATABASE_URL} fehlgeschlagen.`)).toBe(
      `Verbindung zu ${SECRET_MASK} fehlgeschlagen.`,
    );
  });

  it('leaves a German message without credentials unchanged', () => {
    const message = 'Die Seitengrenze von 10 Seiten wurde für StepStone erreicht.';

    expect(masker.maskText(message)).toBe(message);
  });

  it('changes nothing when no credential is configured', () => {
    expect(maskSecretsInText('kein Geheimnis hier', [])).toBe('kein Geheimnis hier');
  });

  it('does not shred the text over an empty credential value', () => {
    expect(maskSecretsInText('kein Geheimnis hier', [''])).toBe('kein Geheimnis hier');
  });
});

describe('maskDetail', () => {
  it('replaces a credential at any nesting depth', () => {
    const masked = masker.maskDetail({
      request: { headers: { 'x-trace': `trace-${ANTHROPIC_KEY}` } },
      attempts: [{ url: `https://api.anthropic.com?k=${ANTHROPIC_KEY}` }],
    });

    expect(masked).toEqual({
      request: { headers: { 'x-trace': `trace-${SECRET_MASK}` } },
      attempts: [{ url: `https://api.anthropic.com?k=${SECRET_MASK}` }],
    });
    expect(JSON.stringify(masked)).not.toContain(ANTHROPIC_KEY);
  });

  it('replaces a credential that appears as an object key', () => {
    const masked = masker.maskDetail({ [ROUTING_KEY]: 'verbraucht' });

    expect(Object.keys(masked)).toEqual([SECRET_MASK]);
    expect(JSON.stringify(masked)).not.toContain(ROUTING_KEY);
  });

  it('replaces the value of a key that reads like a credential, whatever it contains', () => {
    const masked = masker.maskDetail({
      apiKey: 'unbekannter-laufzeitwert',
      access_token: 12_345,
      clientSecret: { rotated: true },
      Authorization: ['Bearer abc'],
    });

    expect(masked).toEqual({
      apiKey: SECRET_MASK,
      access_token: SECRET_MASK,
      clientSecret: SECRET_MASK,
      Authorization: SECRET_MASK,
    });
  });

  it('replaces a credential-named value nested inside a plain structure', () => {
    expect(
      masker.maskDetail({ provider: { name: 'heigit', credentials: { token: 'runtime-token' } } }),
    ).toEqual({ provider: { name: 'heigit', credentials: { token: SECRET_MASK } } });
  });

  it('keeps the context that makes a message useful', () => {
    const detail = {
      platform: 'STEPSTONE',
      page: 10,
      durationMs: 1_234,
      truncated: false,
      reason: null,
    };

    expect(masker.maskDetail(detail)).toEqual(detail);
  });

  it('leaves an absent value absent instead of masking it', () => {
    expect(masker.maskDetail({ apiKey: null })).toEqual({ apiKey: null });
  });

  it('keeps a timestamp readable rather than flattening it', () => {
    const assessedAt = new Date('2026-01-15T08:30:00.000Z');

    expect(masker.maskDetail({ assessedAt })).toEqual({ assessedAt });
  });

  it('does not modify the detail object the caller still holds', () => {
    const detail = { url: `https://x.test?key=${ROUTING_KEY}` };

    masker.maskDetail(detail);

    expect(detail.url).toContain(ROUTING_KEY);
  });

  it('survives a detail object that refers back to itself', () => {
    const detail: Record<string, unknown> = { code: 'relevance.failed' };
    detail.self = detail;

    expect(masker.maskDetail(detail)).toEqual({ code: 'relevance.failed', self: CIRCULAR_MARKER });
  });

  it('masks the same object twice when it appears side by side', () => {
    const shared = { url: `https://x.test?key=${ROUTING_KEY}` };

    expect(masker.maskDetail({ first: shared, second: shared })).toEqual({
      first: { url: `https://x.test?key=${SECRET_MASK}` },
      second: { url: `https://x.test?key=${SECRET_MASK}` },
    });
  });
});

describe('emit', () => {
  it('masks the German text and the structured context before persistence', async () => {
    const stored = createStore();
    const service = new LogStreamService(stored.store, masker);

    await service.emit({
      runId: RUN,
      level: 'ERROR',
      code: 'relevance.providerUnreachable',
      messageDe: `Die Anfrage an ${ANTHROPIC_KEY} ist fehlgeschlagen.`,
      detail: { request: { url: `https://api.anthropic.com?key=${ANTHROPIC_KEY}` }, apiKey: 'x' },
    });

    const row = stored.rows[0];

    expect(row?.messageDe).toBe(`Die Anfrage an ${SECRET_MASK} ist fehlgeschlagen.`);
    expect(row?.detail).toEqual({
      request: { url: `https://api.anthropic.com?key=${SECRET_MASK}` },
      apiKey: SECRET_MASK,
    });
    expect(JSON.stringify(stored.rows)).not.toContain(ANTHROPIC_KEY);
  });

  it('hands the masked message to a live subscriber as well', async () => {
    const stored = createStore();
    const service = new LogStreamService(stored.store, masker);
    const stream = service.stream(RUN);
    const received = (async () => {
      for await (const message of stream) {
        return message;
      }

      return null;
    })();

    await Promise.resolve();
    await Promise.resolve();

    await service.emit({
      runId: RUN,
      level: 'ERROR',
      code: 'commute.providerUnreachable',
      messageDe: `Routing mit ${ROUTING_KEY} nicht möglich.`,
      detail: { token: 'bearer-xyz' },
    });

    const message = await received;

    expect(message?.messageDe).toBe(`Routing mit ${SECRET_MASK} nicht möglich.`);
    expect(message?.detail).toEqual({ token: SECRET_MASK });
  });

  it('leaves a message without credentials untouched', async () => {
    const stored = createStore();
    const service = new LogStreamService(stored.store, masker);

    const message = await service.emit({
      runId: RUN,
      level: 'INFO',
      code: 'run.started',
      messageDe: 'Der Suchlauf wurde gestartet.',
    });

    expect(message.messageDe).toBe('Der Suchlauf wurde gestartet.');
    expect(stored.rows[0]?.detail).toBeNull();
  });
});

describe('LogStreamModule', () => {
  let context: INestApplicationContext | undefined;

  afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  /**
   * Stands in for the two global modules of the running API_Service.
   *
   * `ConfigModule` would read the real environment file and `PrismaModule` would open a connection
   * to the Posting_Store; both are replaced by the values this test wants to observe. What stays
   * real is the resolution path: `LogStreamModule` takes the configuration through `ENV_CONFIG` and
   * the store through the `PrismaService` token, exactly as it does in production.
   */
  const infrastructure = (store: LogMessageStore) => {
    @Global()
    @Module({
      providers: [
        { provide: ENV_CONFIG, useValue: envConfig },
        { provide: PrismaService, useValue: store },
      ],
      exports: [ENV_CONFIG, PrismaService],
    })
    class TestInfrastructureModule {}

    @Module({ imports: [TestInfrastructureModule, LogStreamModule] })
    class RootModule {}

    return RootModule;
  };

  it('masks the credentials of the running configuration, without any caller asking for it', async () => {
    const stored = createStore();

    context = await NestFactory.createApplicationContext(infrastructure(stored.store), {
      logger: false,
    });

    // The service is taken out of the container rather than constructed, so a masker that was
    // never registered or that was wired to the wrong configuration fails here.
    await context.get(LogStreamService, { strict: false }).emit({
      runId: RUN,
      level: 'ERROR',
      code: 'commute.providerUnreachable',
      messageDe: `Routing mit ${ROUTING_KEY} nicht möglich.`,
      detail: { databaseUrl: DATABASE_URL, provider: { apiKey: ANTHROPIC_KEY } },
    });

    expect(stored.rows[0]?.messageDe).toBe(`Routing mit ${SECRET_MASK} nicht möglich.`);
    expect(stored.rows[0]?.detail).toEqual({
      databaseUrl: SECRET_MASK,
      provider: { apiKey: SECRET_MASK },
    });

    const serialized = JSON.stringify(stored.rows);

    for (const secret of [DATABASE_URL, ROUTING_KEY, ANTHROPIC_KEY]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
