/**
 * What the AnthropicLocationNormalizer sends, what it does with an answer, and what it refuses to do
 * with the key (8.6, 8.7, 14.9).
 *
 * Every test stubs the HTTP port, so the suite is offline, free and deterministic. Four groups of
 * assertions, one per promise the Commute_Service builds on:
 *
 * - the request: the work location verbatim, nothing else about the Job_Posting, and the single
 *   forced `report_work_location` tool call (8.6);
 * - the three outcomes, `NORMALIZED`, `UNRESOLVABLE` and `FAILED`, and in particular which answers
 *   are *not* allowed to become `UNRESOLVABLE`, because that one is recorded permanently (8.7);
 * - the failures, all of which are a `FAILED` outcome rather than an exception;
 * - the key, which may appear in the `x-api-key` header and nowhere else (14.9).
 *
 * The at-most-once bound of 8.7 itself is not asserted here: the `LocationNormalization` row that
 * enforces it is the Commute_Service's, and this class performs exactly one request per call and
 * keeps no memory.
 *
 * Requirements: 8.6, 8.7, 8.8, 14.9.
 */

import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { EnvConfig } from '../../config/env.schema';
import { FixtureModeViolationError } from '../../config/fixture-mode';
import type { AnthropicFetch } from '../../relevance/anthropic-relevance.assessor';
import {
  ANTHROPIC_MESSAGES_PATH,
  ANTHROPIC_VERSION,
  DEFAULT_ANTHROPIC_MODEL,
} from '../../relevance/anthropic-relevance.assessor';
import {
  AnthropicLocationNormalizer,
  LOCATION_MAX_OUTPUT_TOKENS,
  LOCATION_SYSTEM_PROMPT,
} from '../anthropic-location.normalizer';
import { LOCATION_PLACE_NAME_MAX_LENGTH, LOCATION_TOOL_NAME } from '../anthropic-location.schema';

/** The key under test. A failing assertion that prints it prints this string, not a real secret. */
const API_KEY = 'sk-ant-test-key-4711';

/** The configured model alias. */
const MODEL = 'claude-sonnet-4-5';

/** The free-text work location of 8.6: no rule resolves it, and it does name a place. */
const RAW_LOCATION = 'Zentrale im Süden von München';

/** The environment as the normalizer sees it. */
const envWith = (anthropicApiKey: string, anthropicModel = MODEL): EnvConfig =>
  ({ anthropicApiKey, anthropicModel, scraperFixtureMode: false }) as unknown as EnvConfig;

/** A JSON response, as `fetch` would deliver it. */
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** A Messages API answer carrying one `report_work_location` tool call. */
const toolCallBody = (input: unknown): unknown => ({
  id: 'msg_01',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'toolu_01', name: LOCATION_TOOL_NAME, input }],
  usage: { input_tokens: 120, output_tokens: 20 },
});

/** One recorded request. */
interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** The single request a test expected the normalizer to send. */
const onlyCall = (calls: readonly Call[]): Call => {
  const call = calls[0];

  if (call === undefined || calls.length !== 1) {
    throw new Error(`expected exactly one request, recorded ${String(calls.length)}`);
  }

  return call;
};

/** The request body of a recorded call, as the normalizer serialized it. */
const bodyOf = (call: Call): Record<string, unknown> =>
  JSON.parse(String(call.init.body)) as Record<string, unknown>;

/** The user message of a recorded call. */
const userMessageOf = (call: Call): string => {
  const messages = bodyOf(call).messages as readonly { readonly content: string }[];

  return messages[0]?.content ?? '';
};

/** The headers of a recorded call, read case-insensitively. */
const headerOf = (call: Call, name: string): string | null =>
  new Headers(call.init.headers).get(name);

const normalizerWith = (
  answer: (call: Call) => Promise<Response> | Response,
  env: EnvConfig = envWith(API_KEY),
): { readonly normalizer: AnthropicLocationNormalizer; readonly calls: Call[] } => {
  const calls: Call[] = [];
  const http: AnthropicFetch = async (url, init) => {
    calls.push({ url, init });

    return answer({ url, init });
  };

  return { normalizer: new AnthropicLocationNormalizer(env, http), calls };
};

/** A normalizer that answers every request with the same tool input. */
const answeringNormalizer = (input: unknown = { outcome: 'PLACE', placeName: 'München' }) =>
  normalizerWith(() => jsonResponse(toolCallBody(input)));

const signal = (): AbortSignal => new AbortController().signal;

beforeAll(() => {
  // Every failure is reported through the Nest logger; a quiet test output is what makes a real
  // failure readable.
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('the request', () => {
  it('posts to the Messages endpoint with the version header and the forced tool call', async () => {
    const { normalizer, calls } = answeringNormalizer();

    await normalizer.normalize(RAW_LOCATION, signal());
    const call = onlyCall(calls);

    expect(call.url.endsWith(ANTHROPIC_MESSAGES_PATH)).toBe(true);
    expect(call.init.method).toBe('POST');
    expect(headerOf(call, 'anthropic-version')).toBe(ANTHROPIC_VERSION);

    const body = bodyOf(call);

    expect(body.model).toBe(MODEL);
    expect(body.system).toBe(LOCATION_SYSTEM_PROMPT);
    expect(body.max_tokens).toBe(LOCATION_MAX_OUTPUT_TOKENS);
    expect(body.tool_choice).toEqual({ type: 'tool', name: LOCATION_TOOL_NAME });
    expect(body.tools).toHaveLength(1);
  });

  it('transmits the work location verbatim and nothing else about the Job_Posting', async () => {
    const { normalizer, calls } = answeringNormalizer();

    await normalizer.normalize(RAW_LOCATION, signal());

    expect(userMessageOf(onlyCall(calls))).toBe(
      `<work_location>\n${RAW_LOCATION}\n</work_location>`,
    );
  });

  it('falls back to the default model when none is configured', async () => {
    const { normalizer, calls } = normalizerWith(
      () => jsonResponse(toolCallBody({ outcome: 'NO_PLACE' })),
      envWith(API_KEY, '   '),
    );

    await normalizer.normalize(RAW_LOCATION, signal());

    expect(bodyOf(onlyCall(calls)).model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(normalizer.name).toContain(DEFAULT_ANTHROPIC_MODEL);
  });
});

describe('a usable answer', () => {
  it('reports the place name of a PLACE answer', async () => {
    const { normalizer } = answeringNormalizer({ outcome: 'PLACE', placeName: 'Martinsried' });

    await expect(normalizer.normalize(RAW_LOCATION, signal())).resolves.toEqual({
      kind: 'NORMALIZED',
      placeName: 'Martinsried',
    });
  });

  it('trims the place name, because that is the value that gets geocoded and stored', async () => {
    const { normalizer } = answeringNormalizer({ outcome: 'PLACE', placeName: '  München \n' });

    await expect(normalizer.normalize(RAW_LOCATION, signal())).resolves.toEqual({
      kind: 'NORMALIZED',
      placeName: 'München',
    });
  });

  it('reports UNRESOLVABLE for an explicit NO_PLACE, which 8.7 records permanently', async () => {
    const { normalizer } = answeringNormalizer({ outcome: 'NO_PLACE' });

    await expect(normalizer.normalize('Remote nach Vereinbarung', signal())).resolves.toEqual({
      kind: 'UNRESOLVABLE',
    });
  });

  it('ignores a placeName the model added to a NO_PLACE answer', async () => {
    const { normalizer } = answeringNormalizer({ outcome: 'NO_PLACE', placeName: 'München' });

    await expect(normalizer.normalize(RAW_LOCATION, signal())).resolves.toEqual({
      kind: 'UNRESOLVABLE',
    });
  });
});

describe('an unusable answer', () => {
  it('fails rather than recording a dead end when PLACE carries no name', async () => {
    const { normalizer } = answeringNormalizer({ outcome: 'PLACE', placeName: '   ' });

    // Not `UNRESOLVABLE`: that is recorded permanently and would spend the one request 8.7 allows
    // this value, on an answer the model did not actually give.
    await expect(normalizer.normalize(RAW_LOCATION, signal())).resolves.toEqual({ kind: 'FAILED' });
  });

  it('fails on a verdict outside the permitted outcomes', async () => {
    const { normalizer } = answeringNormalizer({ outcome: 'MAYBE', placeName: 'München' });

    await expect(normalizer.normalize(RAW_LOCATION, signal())).resolves.toEqual({ kind: 'FAILED' });
  });

  it('fails on a place name longer than the bound', async () => {
    const { normalizer } = answeringNormalizer({
      outcome: 'PLACE',
      placeName: 'M'.repeat(LOCATION_PLACE_NAME_MAX_LENGTH + 1),
    });

    await expect(normalizer.normalize(RAW_LOCATION, signal())).resolves.toEqual({ kind: 'FAILED' });
  });

  it('fails when the model answered prose instead of calling the tool', async () => {
    const { normalizer } = normalizerWith(() =>
      jsonResponse({
        model: MODEL,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Das ist München.' }],
      }),
    );

    await expect(normalizer.normalize(RAW_LOCATION, signal())).resolves.toEqual({ kind: 'FAILED' });
  });

  it('fails when a different tool was called', async () => {
    const { normalizer } = normalizerWith(() =>
      jsonResponse({
        model: MODEL,
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'report_relevance', input: { outcome: 'NO_PLACE' } }],
      }),
    );

    await expect(normalizer.normalize(RAW_LOCATION, signal())).resolves.toEqual({ kind: 'FAILED' });
  });

  it('fails when the envelope is not a Messages API response', async () => {
    const { normalizer } = normalizerWith(() => jsonResponse({ content: 'not an array' }));

    await expect(normalizer.normalize(RAW_LOCATION, signal())).resolves.toEqual({ kind: 'FAILED' });
  });

  it('fails when a 2xx body cannot be read as JSON', async () => {
    const { normalizer } = normalizerWith(
      () => new Response('<html>proxy error</html>', { status: 200 }),
    );

    await expect(normalizer.normalize(RAW_LOCATION, signal())).resolves.toEqual({ kind: 'FAILED' });
  });
});

describe('a request that does not complete', () => {
  it('fails on an HTTP error status', async () => {
    const { normalizer } = normalizerWith(() => jsonResponse({ error: 'bad request' }, 400));

    await expect(normalizer.normalize(RAW_LOCATION, signal())).resolves.toEqual({ kind: 'FAILED' });
  });

  it('fails on a reported rate limit', async () => {
    const { normalizer } = normalizerWith(() => jsonResponse({ error: 'overloaded' }, 529));

    await expect(normalizer.normalize(RAW_LOCATION, signal())).resolves.toEqual({ kind: 'FAILED' });
  });

  it('fails on a transport error instead of rejecting', async () => {
    const { normalizer } = normalizerWith(() => {
      throw new TypeError('fetch failed');
    });

    await expect(normalizer.normalize(RAW_LOCATION, signal())).resolves.toEqual({ kind: 'FAILED' });
  });

  it('fails on an aborted Scrape_Run instead of rejecting', async () => {
    const controller = new AbortController();
    const { normalizer } = normalizerWith(() => {
      controller.abort();

      throw new DOMException('aborted', 'AbortError');
    });

    await expect(normalizer.normalize(RAW_LOCATION, controller.signal)).resolves.toEqual({
      kind: 'FAILED',
    });
  });

  it('sends no request at all without a configured key', async () => {
    const { normalizer, calls } = normalizerWith(
      () => jsonResponse(toolCallBody({ outcome: 'NO_PLACE' })),
      envWith(''),
    );

    await expect(normalizer.normalize(RAW_LOCATION, signal())).resolves.toEqual({ kind: 'FAILED' });
    expect(calls).toHaveLength(0);
  });
});

describe('the API key (14.9)', () => {
  it('travels in the x-api-key header and never in the URL or the body', async () => {
    const { normalizer, calls } = answeringNormalizer();

    await normalizer.normalize(RAW_LOCATION, signal());
    const call = onlyCall(calls);

    expect(headerOf(call, 'x-api-key')).toBe(API_KEY);
    expect(call.url).not.toContain(API_KEY);
    expect(String(call.init.body)).not.toContain(API_KEY);
  });

  it('never carries the key in the reported name', () => {
    const { normalizer } = answeringNormalizer();

    expect(normalizer.name).not.toContain(API_KEY);
  });

  it('masks a key echoed back inside the place name, before it is stored or geocoded', async () => {
    const { normalizer } = answeringNormalizer({
      outcome: 'PLACE',
      placeName: `München ${API_KEY}`,
    });
    const outcome = await normalizer.normalize(RAW_LOCATION, signal());

    expect(outcome.kind).toBe('NORMALIZED');
    expect(JSON.stringify(outcome)).not.toContain(API_KEY);
  });

  it('masks the key in a logged failure detail', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { normalizer } = normalizerWith(() => {
      throw new TypeError(`fetch failed for key ${API_KEY}`);
    });

    await normalizer.normalize(RAW_LOCATION, signal());

    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(API_KEY);
  });
});

describe('fixture mode', () => {
  it('refuses to be constructed, so no object can reach Anthropic (task 21.1)', () => {
    const env = {
      anthropicApiKey: API_KEY,
      anthropicModel: MODEL,
      scraperFixtureMode: true,
    } as unknown as EnvConfig;

    expect(() => new AnthropicLocationNormalizer(env)).toThrow(FixtureModeViolationError);
  });
});
