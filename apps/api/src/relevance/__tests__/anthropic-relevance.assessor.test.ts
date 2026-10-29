/**
 * What the AnthropicRelevanceAssessor sends, what it does with an answer, and what it refuses to do
 * with the key.
 *
 * Every test stubs the HTTP port, so the suite is offline, free and deterministic; the one real
 * request lives in `./anthropic-relevance.live.smoke.test.ts` behind an opt-in.
 *
 * Four groups of assertions, one per promise the Relevance_Service builds on:
 *
 * - the request: the five posting fields and the benchmark Search_Profile, an absent optional stated
 *   as "unknown", the description passed through at the length the caller truncated it to, and the
 *   single forced `report_relevance` tool call (15.2);
 * - the happy path: a verdict and a reason, with the model that *answered* reported rather than the
 *   configured alias (15.1);
 * - the failures, all of which are a `FAILED` outcome rather than an exception, with the retriable
 *   codes and the final ones kept apart (15.11, 15.12);
 * - the key, which may appear in the `x-api-key` header and nowhere else (14.9).
 *
 * The retry chain, the run budget and the German wording are not asserted here: they belong to the
 * Relevance_Service (tasks 14.3, 14.4), and this class performs exactly one request per call.
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.12, 14.9.
 */

import type { EffectiveSearchProfile } from '@job-scraper/domain';
import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { EnvConfig } from '../../config/env.schema';
import {
  ANTHROPIC_MESSAGES_PATH,
  ANTHROPIC_VERSION,
  type AnthropicFetch,
  AnthropicRelevanceAssessor,
  DEFAULT_ANTHROPIC_MODEL,
  RELEVANCE_SYSTEM_PROMPT,
} from '../anthropic-relevance.assessor';
import { ANTHROPIC_TOOL_NAME } from '../anthropic-relevance.schema';
import {
  RELEVANCE_DESCRIPTION_MAX_LENGTH,
  RELEVANCE_REASON_MAX_LENGTH,
  type RelevanceRequest,
  truncateDescription,
} from '../relevance-assessor.port';

/** The key under test. A failing assertion that prints it prints this string, not a real secret. */
const API_KEY = 'sk-ant-test-key-4711';

/** The configured model alias. */
const MODEL = 'claude-sonnet-4-5';

/** The dated snapshot a provider-side alias resolves to; this is what must be stored (15.1). */
const ANSWERING_MODEL = 'claude-sonnet-4-5-20250929';

const PROFILE: EffectiveSearchProfile = {
  platform: 'STEPSTONE',
  criteria: [
    { field: 'jobTitle', value: 'Pflegefachkraft', provenance: 'DEFAULT' },
    { field: 'searchLocation', value: 'München', provenance: 'OVERRIDE' },
    { field: 'titleSynonyms', value: ['Pflegekraft', 'Krankenpflege'], provenance: 'DEFAULT' },
  ],
};

/** A fully populated request. */
const REQUEST: RelevanceRequest = {
  title: 'Pflegefachkraft (m/w/d)',
  employer: 'Klinikum München',
  workLocation: 'München',
  publishedAt: new Date('2026-03-02T07:30:00.000Z'),
  descriptionText: truncateDescription('Wir suchen eine Pflegefachkraft in Festanstellung.'),
  profile: PROFILE,
};

/** A Job_Posting whose optional fields the Platform did not supply (6.8). */
const SPARSE_REQUEST: RelevanceRequest = {
  title: 'Pflegefachkraft (m/w/d)',
  employer: null,
  workLocation: null,
  publishedAt: null,
  descriptionText: truncateDescription(null),
  profile: PROFILE,
};

/** The environment as the assessor sees it: the key, the model and nothing else of interest. */
const envWith = (anthropicApiKey: string, anthropicModel = MODEL): EnvConfig =>
  ({ anthropicApiKey, anthropicModel }) as unknown as EnvConfig;

/** A JSON response, as `fetch` would deliver it. */
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** A Messages API answer carrying one `report_relevance` tool call. */
const toolCallBody = (input: unknown, model: string = ANSWERING_MODEL): unknown => ({
  id: 'msg_01',
  type: 'message',
  role: 'assistant',
  model,
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: 'toolu_01', name: ANTHROPIC_TOOL_NAME, input }],
  usage: { input_tokens: 700, output_tokens: 60 },
});

/** One recorded request. */
interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** The single request a test expected the assessor to send. */
const onlyCall = (calls: readonly Call[]): Call => {
  const call = calls[0];

  if (call === undefined || calls.length !== 1) {
    throw new Error(`expected exactly one request, recorded ${String(calls.length)}`);
  }

  return call;
};

/** The request body of a recorded call, as the assessor serialized it. */
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

const assessorWith = (
  answer: (call: Call) => Promise<Response> | Response,
  env: EnvConfig = envWith(API_KEY),
): { readonly assessor: AnthropicRelevanceAssessor; readonly calls: Call[] } => {
  const calls: Call[] = [];
  const http: AnthropicFetch = async (url, init) => {
    calls.push({ url, init });

    return answer({ url, init });
  };

  return { assessor: new AnthropicRelevanceAssessor(env, http), calls };
};

/** An assessor that answers every request with the same usable verdict. */
const answeringAssessor = (
  input: unknown = { verdict: 'RELEVANT', reason: 'Fachgebiet und Arbeitsort passen.' },
) => assessorWith(() => jsonResponse(toolCallBody(input)));

const signal = (): AbortSignal => new AbortController().signal;

beforeAll(() => {
  // Every failure is reported through the Nest logger; a quiet test output is what makes a real
  // failure readable.
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('the request', () => {
  it('posts to the Messages endpoint with the version header and the forced tool call', async () => {
    const { assessor, calls } = answeringAssessor();

    await assessor.assess(REQUEST, signal());
    const call = onlyCall(calls);

    expect(call.url.endsWith(ANTHROPIC_MESSAGES_PATH)).toBe(true);
    expect(call.init.method).toBe('POST');
    expect(headerOf(call, 'anthropic-version')).toBe(ANTHROPIC_VERSION);

    const body = bodyOf(call);

    expect(body.model).toBe(MODEL);
    expect(body.system).toBe(RELEVANCE_SYSTEM_PROMPT);
    expect(body.tool_choice).toEqual({ type: 'tool', name: ANTHROPIC_TOOL_NAME });
    expect(body.tools).toHaveLength(1);
  });

  it('transmits the five posting fields and the Search_Profile as the benchmark', async () => {
    const { assessor, calls } = answeringAssessor();

    await assessor.assess(REQUEST, signal());
    const message = userMessageOf(onlyCall(calls));

    expect(message).toContain('<title>Pflegefachkraft (m/w/d)</title>');
    expect(message).toContain('<employer>Klinikum München</employer>');
    expect(message).toContain('<work_location>München</work_location>');
    expect(message).toContain('<publication_date>2026-03-02</publication_date>');
    expect(message).toContain('Wir suchen eine Pflegefachkraft in Festanstellung.');
    expect(message).toContain('- jobTitle: "Pflegefachkraft"');
    expect(message).toContain('- searchLocation: "München"');
    expect(message).toContain('- titleSynonyms: ["Pflegekraft","Krankenpflege"]');
  });

  it('states an absent optional as "unknown" instead of omitting the line', async () => {
    const { assessor, calls } = answeringAssessor();

    await assessor.assess(SPARSE_REQUEST, signal());
    const message = userMessageOf(onlyCall(calls));

    expect(message).toContain('<employer>unknown</employer>');
    expect(message).toContain('<work_location>unknown</work_location>');
    expect(message).toContain('<publication_date>unknown</publication_date>');
    expect(message).toContain('<description>\nunknown\n</description>');
  });

  it('sends the description at the length the caller truncated it to, and no more', async () => {
    const { assessor, calls } = answeringAssessor();
    const descriptionText = truncateDescription('ä'.repeat(RELEVANCE_DESCRIPTION_MAX_LENGTH + 500));

    await assessor.assess({ ...REQUEST, descriptionText }, signal());
    const message = userMessageOf(onlyCall(calls));

    expect(descriptionText).toHaveLength(RELEVANCE_DESCRIPTION_MAX_LENGTH);
    expect(message).toContain(`<description>\n${descriptionText}\n</description>`);
  });
});

describe('a usable answer', () => {
  it('reports the verdict, the reason and the model that actually answered', async () => {
    const { assessor } = answeringAssessor();

    await expect(assessor.assess(REQUEST, signal())).resolves.toEqual({
      kind: 'ASSESSED',
      response: { verdict: 'RELEVANT', reason: 'Fachgebiet und Arbeitsort passen.' },
      model: ANSWERING_MODEL,
    });
  });

  it('falls back to the configured model when the answer carries none', async () => {
    const { assessor } = assessorWith(() =>
      jsonResponse({
        content: [
          {
            type: 'tool_use',
            name: ANTHROPIC_TOOL_NAME,
            input: { verdict: 'UNCERTAIN', reason: 'Die Anzeige nennt kein Fachgebiet.' },
          },
        ],
      }),
    );

    await expect(assessor.assess(REQUEST, signal())).resolves.toEqual({
      kind: 'ASSESSED',
      response: { verdict: 'UNCERTAIN', reason: 'Die Anzeige nennt kein Fachgebiet.' },
      model: MODEL,
    });
  });

  it('reads the tool call of a model that narrated a sentence first', async () => {
    const { assessor } = assessorWith(() =>
      jsonResponse({
        model: ANSWERING_MODEL,
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Ich prüfe die Anzeige gegen das Profil.' },
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: ANTHROPIC_TOOL_NAME,
            input: { verdict: 'RELEVANT', reason: 'Fachgebiet und Arbeitsort passen.' },
          },
        ],
      }),
    );

    await expect(assessor.assess(REQUEST, signal())).resolves.toMatchObject({ kind: 'ASSESSED' });
  });

  it('accepts a reason of exactly 300 characters and discards one of 301', async () => {
    const reason = 'ä'.repeat(RELEVANCE_REASON_MAX_LENGTH);
    const accepted = answeringAssessor({ verdict: 'NOT_RELEVANT', reason });
    const rejected = answeringAssessor({ verdict: 'NOT_RELEVANT', reason: `${reason}ä` });

    await expect(accepted.assessor.assess(REQUEST, signal())).resolves.toMatchObject({
      kind: 'ASSESSED',
      response: { reason },
    });
    await expect(rejected.assessor.assess(REQUEST, signal())).resolves.toEqual({
      kind: 'FAILED',
      code: 'SCHEMA_VIOLATION',
    });
  });

  it('takes the model name from the environment, with the Claude Sonnet default for an empty value', () => {
    expect(new AnthropicRelevanceAssessor(envWith(API_KEY, 'claude-opus-4-1')).model).toBe(
      'claude-opus-4-1',
    );
    expect(new AnthropicRelevanceAssessor(envWith(API_KEY, '  ')).model).toBe(
      DEFAULT_ANTHROPIC_MODEL,
    );
  });
});

describe('an unusable answer', () => {
  it('discards a verdict outside the permitted value list without a second request', async () => {
    const { assessor, calls } = answeringAssessor({ verdict: 'MAYBE', reason: 'Unklar.' });

    await expect(assessor.assess(REQUEST, signal())).resolves.toEqual({
      kind: 'FAILED',
      code: 'SCHEMA_VIOLATION',
    });
    expect(calls).toHaveLength(1);
  });

  it('discards NOT_ASSESSED, which no model may claim', async () => {
    const { assessor } = answeringAssessor({
      verdict: 'NOT_ASSESSED',
      reason: 'Keine Bewertung möglich.',
    });

    await expect(assessor.assess(REQUEST, signal())).resolves.toEqual({
      kind: 'FAILED',
      code: 'SCHEMA_VIOLATION',
    });
  });

  it('discards a missing field instead of filling it in', async () => {
    const { assessor } = answeringAssessor({ verdict: 'RELEVANT' });

    await expect(assessor.assess(REQUEST, signal())).resolves.toEqual({
      kind: 'FAILED',
      code: 'SCHEMA_VIOLATION',
    });
  });

  it('treats prose without a tool call as a schema violation', async () => {
    const { assessor } = assessorWith(() =>
      jsonResponse({
        model: ANSWERING_MODEL,
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Die Stelle passt gut zum Profil.' }],
      }),
    );

    await expect(assessor.assess(REQUEST, signal())).resolves.toEqual({
      kind: 'FAILED',
      code: 'SCHEMA_VIOLATION',
    });
  });

  it('treats a tool call under another name as no tool call', async () => {
    const { assessor } = assessorWith(() =>
      jsonResponse({
        content: [
          {
            type: 'tool_use',
            name: 'report_something_else',
            input: { verdict: 'RELEVANT', reason: 'Passt.' },
          },
        ],
      }),
    );

    await expect(assessor.assess(REQUEST, signal())).resolves.toEqual({
      kind: 'FAILED',
      code: 'SCHEMA_VIOLATION',
    });
  });

  it('treats an envelope that is not a Messages answer as a schema violation', async () => {
    const { assessor } = assessorWith(() => jsonResponse({ content: 'tool_use' }));

    await expect(assessor.assess(REQUEST, signal())).resolves.toEqual({
      kind: 'FAILED',
      code: 'SCHEMA_VIOLATION',
    });
  });
});

describe('a request that produced no answer', () => {
  it('reports a rate limit and an overload as RATE_LIMIT', async () => {
    for (const status of [429, 529]) {
      const { assessor } = assessorWith(() =>
        jsonResponse({ type: 'error', error: { type: 'rate_limit_error' } }, status),
      );

      await expect(assessor.assess(REQUEST, signal())).resolves.toEqual({
        kind: 'FAILED',
        code: 'RATE_LIMIT',
      });
    }
  });

  it('reports a rejected key and a server error as TRANSPORT', async () => {
    for (const status of [401, 403, 500]) {
      const { assessor } = assessorWith(() =>
        jsonResponse({ type: 'error', error: { type: 'authentication_error' } }, status),
      );

      await expect(assessor.assess(REQUEST, signal())).resolves.toEqual({
        kind: 'FAILED',
        code: 'TRANSPORT',
      });
    }
  });

  it('reports a connection failure as TRANSPORT rather than throwing', async () => {
    const { assessor } = assessorWith(() => {
      throw new TypeError('fetch failed');
    });

    await expect(assessor.assess(REQUEST, signal())).resolves.toEqual({
      kind: 'FAILED',
      code: 'TRANSPORT',
    });
  });

  it('reports a 2xx whose body is not JSON as TRANSPORT, because the request did not complete', async () => {
    const { assessor } = assessorWith(
      () => new Response('<html>proxy error</html>', { status: 200 }),
    );

    await expect(assessor.assess(REQUEST, signal())).resolves.toEqual({
      kind: 'FAILED',
      code: 'TRANSPORT',
    });
  });

  it('reports an aborted Scrape_Run as TIMEOUT rather than rejecting', async () => {
    const controller = new AbortController();
    const { assessor, calls } = assessorWith(() => {
      controller.abort();

      // What `fetch` does when the signal it was handed fires mid-flight.
      throw new DOMException('This operation was aborted', 'AbortError');
    });

    await expect(assessor.assess(REQUEST, controller.signal)).resolves.toEqual({
      kind: 'FAILED',
      code: 'TIMEOUT',
    });
    expect(calls).toHaveLength(1);
  });

  it('reports a timed-out request as TIMEOUT', async () => {
    const { assessor } = assessorWith(() => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    });

    await expect(assessor.assess(REQUEST, signal())).resolves.toEqual({
      kind: 'FAILED',
      code: 'TIMEOUT',
    });
  });

  it('hands the request a signal that the caller can still abort', async () => {
    const controller = new AbortController();
    const { assessor, calls } = answeringAssessor();

    await assessor.assess(REQUEST, controller.signal);
    const sent = onlyCall(calls).init.signal;

    // The 30-second bound of 15.11 is combined with the caller's signal rather than replacing it,
    // so a cancelled Scrape_Run still ends a pending request immediately.
    expect(sent).toBeInstanceOf(AbortSignal);
    expect(sent?.aborted).toBe(false);
    controller.abort();
    expect(sent?.aborted).toBe(true);
  });
});

describe('the API key (14.9)', () => {
  it('sends the key in the x-api-key header and nowhere else', async () => {
    const { assessor, calls } = answeringAssessor();

    await assessor.assess(REQUEST, signal());
    const call = onlyCall(calls);

    expect(headerOf(call, 'x-api-key')).toBe(API_KEY);
    expect(call.url).not.toContain(API_KEY);
    expect(String(call.init.body)).not.toContain(API_KEY);
    expect(assessor.model).not.toContain(API_KEY);
  });

  it('masks the key in a logged failure detail', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { assessor } = assessorWith(() => {
      throw new Error(`request to api.anthropic.com failed with key ${API_KEY}`);
    });

    await assessor.assess(REQUEST, signal());
    const logged = warn.mock.calls.flat().map(String).join(' ');

    expect(logged).not.toContain(API_KEY);
    expect(logged).toContain('***');
  });

  it('masks the key in a reason and in a model name the provider echoed back', async () => {
    const { assessor } = assessorWith(() =>
      jsonResponse(
        toolCallBody(
          { verdict: 'RELEVANT', reason: `Passt fachlich, Schlüssel ${API_KEY} stand im Text.` },
          `claude-${API_KEY}-sonnet`,
        ),
      ),
    );

    const outcome = await assessor.assess(REQUEST, signal());

    expect(JSON.stringify(outcome)).not.toContain(API_KEY);
    expect(outcome).toMatchObject({ kind: 'ASSESSED', model: 'claude-***-sonnet' });
  });

  it('sends no request at all without a key', async () => {
    const { assessor, calls } = assessorWith(
      () => jsonResponse(toolCallBody({ verdict: 'RELEVANT', reason: 'Passt.' })),
      envWith(''),
    );

    await expect(assessor.assess(REQUEST, signal())).resolves.toEqual({
      kind: 'FAILED',
      code: 'NO_API_KEY',
    });
    expect(calls).toHaveLength(0);
  });
});
