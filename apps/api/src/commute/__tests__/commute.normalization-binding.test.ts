/**
 * The 8.6 path through the real object graph: `CommuteModule` as Nest wires it, with no stand-in
 * between the Commute_Service and the bound Location_Normalizer (8.5, 8.6, 8.7).
 *
 * `./commute.service.test.ts` drives the same requirements through `stubNormalizer`, which is the
 * right tool for asserting call counts and outcome handling. What it cannot prove is that the
 * Commute_Service ever *reaches* a normalizer in a running Job_Tool — and for the whole time task
 * 13.4 was marked done, it did not: `LOCATION_NORMALIZER` was bound in no module, so the
 * `@Optional()` injection always saw `undefined` and the 8.6 branch was dead code. This suite is the
 * test that would have caught that.
 *
 * The two HTTP seams of the graph are bound to stubs, so the suite is offline: `ANTHROPIC_FETCH` for
 * the normalization, `HEIGIT_FETCH` for the geocoding and the two routes. Everything between them is
 * production code — the factory in `commute.module.ts`, `AnthropicLocationNormalizer`, the
 * `LocationNormalization` bookkeeping of 8.7 and `HeigitRoutingProvider`.
 *
 * Requirements: 8.5, 8.6, 8.7, 8.8, 15.17.
 */

import { Global, type INestApplicationContext, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppConfigService } from '../../config/config.service';
import { ENV_CONFIG } from '../../config/env.config';
import type { EnvConfig } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { ANTHROPIC_FETCH, type AnthropicFetch } from '../../relevance/anthropic-relevance.assessor';
import { LOCATION_TOOL_NAME } from '../anthropic-location.schema';
import { CommuteModule } from '../commute.module';
import { CommuteService } from '../commute.service';
import {
  HEIGIT_DIRECTIONS_PATH,
  HEIGIT_FETCH,
  HEIGIT_GEOCODE_PATH,
  type HeigitFetch,
} from '../heigit-routing.provider';
import { type CommuteStoreFixture, createCommuteStore } from './commute-store.fixture';

/** The Home_Address every route starts from (8.10). */
const HOME = 'Hörkherstraße 1d, 80689 München';

/** Free text the rules cannot turn into a place name — the one case 8.6 permits an AI request for. */
const UNRECOGNIZED_LOCATION = 'unsere Zentrale im schönen Süden der Landeshauptstadt';

/** The place name the stubbed AI_Provider answers with, and the one the geocoder is asked about. */
const NORMALIZED_PLACE = 'Martinsried';

/** A JSON response, as `fetch` would deliver it. */
const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** A Messages API answer carrying one `report_work_location` tool call. */
const normalizationAnswer = (input: unknown): Response =>
  jsonResponse({
    model: 'claude-sonnet-4-5-20250929',
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_01', name: LOCATION_TOOL_NAME, input }],
  });

/** One Pelias feature, in the shape the geocoding endpoint answers with. */
const peliasBody = (lon: number, lat: number): unknown => ({
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { layer: 'address', label: 'Martinsried, Bayern, Deutschland' },
    },
  ],
});

/** A HeiGIT client that geocodes anything and answers one bicycle duration. */
const heigitStub = (): { readonly http: HeigitFetch; readonly urls: readonly string[] } => {
  const urls: string[] = [];
  const http: HeigitFetch = async (url) => {
    urls.push(url);

    if (url.includes(HEIGIT_GEOCODE_PATH)) {
      return jsonResponse(peliasBody(11.58, 48.15));
    }

    if (url.includes(HEIGIT_DIRECTIONS_PATH)) {
      return jsonResponse({ routes: [{ summary: { duration: 1_800 } }] });
    }

    // The transit endpoint: no journey, so the Best_Commute_Time is the bicycle value (8.2).
    return jsonResponse({ request: {}, response: { journeys: [] } });
  };

  return { http, urls };
};

/** The configuration of an activated Relevance_Service, overridable per branch. */
const envWith = (overrides: Partial<EnvConfig> = {}): EnvConfig =>
  ({
    homeAddress: HOME,
    routingApiKey: 'routing-key',
    databaseUrl: 'postgresql://localhost:5432/job_tool',
    anthropicApiKey: 'sk-ant-test-key-4711',
    anthropicModel: 'claude-sonnet-4-5',
    relevanceEnabled: true,
    scraperFixtureMode: false,
    ...overrides,
  }) as unknown as EnvConfig;

/** Boots `CommuteModule` over the stand-in store and the two stubbed HTTP seams. */
const bootWith = async (
  fixture: CommuteStoreFixture,
  anthropic: AnthropicFetch,
  env: EnvConfig = envWith(),
): Promise<INestApplicationContext> => {
  const { http } = heigitStub();

  @Global()
  @Module({
    providers: [
      { provide: PrismaService, useValue: fixture.store },
      { provide: ENV_CONFIG, useValue: env },
      { provide: AppConfigService, useValue: { homeAddress: env.homeAddress } },
      { provide: ANTHROPIC_FETCH, useValue: anthropic },
      { provide: HEIGIT_FETCH, useValue: http },
    ],
    exports: [PrismaService, ENV_CONFIG, AppConfigService, ANTHROPIC_FETCH, HEIGIT_FETCH],
  })
  class StubInfrastructureModule {}

  @Module({ imports: [StubInfrastructureModule, CommuteModule] })
  class RootModule {}

  return NestFactory.createApplicationContext(RootModule, { logger: false });
};

/** A `fetch` that answers every normalization request the same way, and counts them (8.7). */
const countingAnthropic = (
  answer: () => Response,
): { readonly http: AnthropicFetch; readonly bodies: readonly string[] } => {
  const bodies: string[] = [];
  const http: AnthropicFetch = async (_url, init) => {
    bodies.push(String(init.body));

    return answer();
  };

  return { http, bodies };
};

const openSignal = (): AbortSignal => new AbortController().signal;

let context: INestApplicationContext | undefined;

beforeAll(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  await context?.close();
  context = undefined;
});

describe('the bound Location_Normalizer, through the real graph', () => {
  it('turns a free-text work location into a Best_Commute_Time (8.6)', async () => {
    const fixture = createCommuteStore();

    fixture.seedPosting({
      id: 'p1',
      title: 'Projektmanagerin',
      workLocation: UNRECOGNIZED_LOCATION,
    });

    const anthropic = countingAnthropic(() =>
      normalizationAnswer({ outcome: 'PLACE', placeName: NORMALIZED_PLACE }),
    );

    context = await bootWith(fixture, anthropic.http);

    const service = context.get(CommuteService, { strict: false });
    const result = await service.enrich('p1', openSignal());

    expect(result.bestCommuteMinutes).toBe(30);
    expect(result.reason).toBeNull();
    expect(anthropic.bodies).toHaveLength(1);
    expect(anthropic.bodies[0]).toContain(UNRECOGNIZED_LOCATION);
    // The single chance of 8.7 is spent, and the row is what records it.
    expect(fixture.normalizationOf(UNRECOGNIZED_LOCATION)).toMatchObject({
      normalizedName: NORMALIZED_PLACE,
      source: 'AI_PROVIDER',
    });
  });

  it('asks once per distinct value, across two Job_Posting (8.7)', async () => {
    const fixture = createCommuteStore();

    fixture.seedPosting({ id: 'p1', title: 'A', workLocation: UNRECOGNIZED_LOCATION });
    fixture.seedPosting({ id: 'p2', title: 'B', workLocation: UNRECOGNIZED_LOCATION });

    const anthropic = countingAnthropic(() =>
      normalizationAnswer({ outcome: 'PLACE', placeName: NORMALIZED_PLACE }),
    );

    context = await bootWith(fixture, anthropic.http);

    const service = context.get(CommuteService, { strict: false });

    await service.enrich('p1', openSignal());
    await service.enrich('p2', openSignal());

    expect(anthropic.bodies).toHaveLength(1);
  });

  it('records a "no place" answer, so the value is never sent again (8.7)', async () => {
    const fixture = createCommuteStore();

    fixture.seedPosting({ id: 'p1', title: 'A', workLocation: UNRECOGNIZED_LOCATION });

    const anthropic = countingAnthropic(() => normalizationAnswer({ outcome: 'NO_PLACE' }));

    context = await bootWith(fixture, anthropic.http);

    const result = await context.get(CommuteService, { strict: false }).enrich('p1', openSignal());

    expect(result.reason).toBe('LOCATION_UNRECOGNIZED');
    expect(fixture.normalizationOf(UNRECOGNIZED_LOCATION)).toMatchObject({
      normalizedName: null,
      source: 'AI_PROVIDER',
    });
  });

  it('records nothing when the one request got no answer (8.7, 8.8)', async () => {
    const fixture = createCommuteStore();

    fixture.seedPosting({ id: 'p1', title: 'A', workLocation: UNRECOGNIZED_LOCATION });

    const anthropic = countingAnthropic(
      () => new Response('{"error":"overloaded"}', { status: 529 }),
    );

    context = await bootWith(fixture, anthropic.http);

    const result = await context.get(CommuteService, { strict: false }).enrich('p1', openSignal());

    expect(result.reason).toBe('NORMALIZATION_FAILED');
    expect(anthropic.bodies).toHaveLength(1);
    expect(fixture.normalizationOf(UNRECOGNIZED_LOCATION)).toBeUndefined();
  });

  it('sends no request and records nothing with the Relevance_Service off (8.5)', async () => {
    const fixture = createCommuteStore();

    fixture.seedPosting({ id: 'p1', title: 'A', workLocation: UNRECOGNIZED_LOCATION });

    const anthropic = countingAnthropic(() =>
      normalizationAnswer({ outcome: 'PLACE', placeName: NORMALIZED_PLACE }),
    );

    context = await bootWith(fixture, anthropic.http, envWith({ relevanceEnabled: false }));

    const result = await context.get(CommuteService, { strict: false }).enrich('p1', openSignal());

    expect(result.reason).toBe('LOCATION_UNRECOGNIZED');
    expect(result.bestCommuteMinutes).toBeNull();
    expect(anthropic.bodies).toStrictEqual([]);
    expect(fixture.normalizationOf(UNRECOGNIZED_LOCATION)).toBeUndefined();
  });
});
