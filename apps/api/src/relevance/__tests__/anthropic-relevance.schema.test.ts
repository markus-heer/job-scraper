/**
 * The Anthropic wire gate: what the model is told to return, and what counts as a tool call.
 *
 * Two things are worth pinning independently of the assessor. The tool definition must state the
 * same verdict list and the same reason bound that the response schema enforces — a tool that
 * advertised a fourth verdict would spend assessments on answers the parser then discards (15.12).
 * And the envelope must let the API grow without costing a verdict: an added field, a new block type
 * and a text block alongside the tool call are all normal answers.
 *
 * Requirements: 15.3, 15.4, 15.12.
 */

import { describe, expect, it } from 'vitest';

import {
  ANTHROPIC_TOOL_NAME,
  ANTHROPIC_TOOL_USE_BLOCK_TYPE,
  anthropicMessageResponseSchema,
  RELEVANCE_TOOL_DEFINITION,
  reportRelevanceToolInput,
} from '../anthropic-relevance.schema';
import {
  ASSESSED_RELEVANCE_VERDICTS,
  parseRelevanceResponse,
  RELEVANCE_REASON_MAX_LENGTH,
} from '../relevance-assessor.port';

/** One tool-use block, as a Messages answer carries it. */
const toolUseBlock = (name: string, input: unknown): unknown => ({
  type: ANTHROPIC_TOOL_USE_BLOCK_TYPE,
  id: 'toolu_01',
  name,
  input,
});

/** An answer body built from the given content blocks. */
const answerWith = (...content: readonly unknown[]): unknown => ({
  id: 'msg_01',
  model: 'claude-sonnet-4-5-20250929',
  stop_reason: 'tool_use',
  content,
});

describe('RELEVANCE_TOOL_DEFINITION', () => {
  it('advertises exactly the verdicts and the reason bound the response schema enforces', () => {
    const { properties, required, additionalProperties } = RELEVANCE_TOOL_DEFINITION.input_schema;

    expect(RELEVANCE_TOOL_DEFINITION.name).toBe(ANTHROPIC_TOOL_NAME);
    expect(properties.verdict).toMatchObject({ enum: [...ASSESSED_RELEVANCE_VERDICTS] });
    expect(properties.reason).toMatchObject({ maxLength: RELEVANCE_REASON_MAX_LENGTH });
    expect(required).toEqual(['verdict', 'reason']);
    expect(additionalProperties).toBe(false);
  });

  it('states the German wording requirement the schema cannot check (15.3, 15.4)', () => {
    const reason = RELEVANCE_TOOL_DEFINITION.input_schema.properties.reason as {
      readonly description: string;
    };

    expect(reason.description).toContain('German');
    expect(reason.description).toContain('decisive factor');
  });
});

describe('reportRelevanceToolInput', () => {
  it('finds the tool input next to a text block the model added', () => {
    const input = { verdict: 'RELEVANT', reason: 'Fachgebiet passt.' };
    const parsed = anthropicMessageResponseSchema.parse(
      answerWith(
        { type: 'text', text: 'Ich prüfe die Anzeige.' },
        toolUseBlock(ANTHROPIC_TOOL_NAME, input),
      ),
    );

    expect(parseRelevanceResponse(reportRelevanceToolInput(parsed))).toEqual(input);
  });

  it('answers undefined for an answer that called no tool, which is a schema violation', () => {
    const parsed = anthropicMessageResponseSchema.parse(
      answerWith({ type: 'text', text: 'Die Stelle passt gut.' }),
    );

    expect(reportRelevanceToolInput(parsed)).toBe(undefined);
    expect(parseRelevanceResponse(reportRelevanceToolInput(parsed))).toBe(null);
  });

  it('ignores a tool call that announces a different name', () => {
    const parsed = anthropicMessageResponseSchema.parse(
      answerWith(toolUseBlock('report_commute', { verdict: 'RELEVANT', reason: 'Passt.' })),
    );

    expect(reportRelevanceToolInput(parsed)).toBe(undefined);
  });
});

describe('anthropicMessageResponseSchema', () => {
  it('accepts an answer with added fields and an unknown block type', () => {
    const result = anthropicMessageResponseSchema.safeParse({
      ...(answerWith({ type: 'server_tool_use_v2', id: 'x' }) as Record<string, unknown>),
      usage: { input_tokens: 700, output_tokens: 60 },
      container: null,
    });

    expect(result.success).toBe(true);
  });

  it('accepts an answer that omits the model and the stop reason', () => {
    const result = anthropicMessageResponseSchema.safeParse({ content: [] });

    expect(result.success).toBe(true);
  });

  it('rejects a body in which no tool call could be', () => {
    expect(anthropicMessageResponseSchema.safeParse({ content: 'tool_use' }).success).toBe(false);
    expect(anthropicMessageResponseSchema.safeParse({}).success).toBe(false);
    expect(anthropicMessageResponseSchema.safeParse(null).success).toBe(false);
  });
});
