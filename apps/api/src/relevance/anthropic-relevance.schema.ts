/**
 * The Anthropic wire contract the {@link AnthropicRelevanceAssessor} speaks, and nothing else
 * (15.1, 15.12).
 *
 * Two shapes live here, both of them third-party and therefore both of them gated rather than
 * trusted:
 *
 * - {@link RELEVANCE_TOOL_DEFINITION}, the single tool the model is forced to call. It is the
 *   request side of the contract, and it is the reason a relevance answer is a structured value
 *   instead of German prose that would have to be parsed for a verdict.
 * - {@link anthropicMessageResponseSchema}, the envelope of a Messages API answer, reduced to the
 *   three fields the assessor reads: the model that answered, the content blocks and the stop
 *   reason. Everything else — usage counters, the message id, the role, per-block text — is dropped
 *   by Zod, because this schema is a gate and not a model of the API.
 *
 * The envelope is deliberately permissive where the API is allowed to grow and strict where the
 * assessor depends on it. A new block type, a new stop reason or an added top-level field must not
 * cost an assessment; a `content` that is not an array must, because then there is nowhere a tool
 * call could be.
 *
 * ## Why the tool schema is written out rather than generated from Zod
 *
 * `z.toJSONSchema(relevanceResponseSchema)` would produce the same two bounds from one source, but
 * it would also emit a `$schema` key the Messages API does not ask for and it cannot carry the one
 * thing the validator has no way to express: that the reason has to be German and has to name the
 * decisive factor (15.3, 15.4). The enum and the length bound are therefore *derived* from
 * {@link ASSESSED_RELEVANCE_VERDICTS} and {@link RELEVANCE_REASON_MAX_LENGTH} — so the tool the
 * model sees and the schema the answer is checked against cannot drift apart — while the wording
 * requirements sit in the field descriptions where the model reads them.
 *
 * Requirements: 15.1, 15.3, 15.4, 15.12.
 */

import { z } from 'zod';

import {
  ASSESSED_RELEVANCE_VERDICTS,
  RELEVANCE_REASON_MAX_LENGTH,
} from './relevance-assessor.port';

/** The one tool the model may call, named by the design document. */
export const ANTHROPIC_TOOL_NAME = 'report_relevance';

/** The block type that carries a tool call in a Messages API answer. */
export const ANTHROPIC_TOOL_USE_BLOCK_TYPE = 'tool_use';

/** A JSON Schema object as the `input_schema` of a tool definition, without reaching for `any`. */
export interface AnthropicToolInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
  /** No invented fields: the two properties are the whole answer (15.14). */
  readonly additionalProperties: false;
}

/** One tool as the Messages API takes it. */
export interface AnthropicToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: AnthropicToolInputSchema;
}

/**
 * The `report_relevance` tool (design, Relevance_Service).
 *
 * The descriptions are part of the prompt, not documentation: they are what the model reads while
 * filling the fields in, which is where the German requirement and the "name the concrete decisive
 * factor" requirement of 15.3 and 15.4 have to be repeated. The system prompt states both as well;
 * saying it twice costs a handful of tokens and buys the reason that 15.4 actually asks for.
 */
export const RELEVANCE_TOOL_DEFINITION: AnthropicToolDefinition = {
  name: ANTHROPIC_TOOL_NAME,
  description:
    'Reports the relevance of one job advertisement against the given search profile. Call this tool exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: [...ASSESSED_RELEVANCE_VERDICTS],
        description:
          'RELEVANT when the advertisement matches the search profile, NOT_RELEVANT when it clearly does not, UNCERTAIN when the advertisement does not state enough to decide.',
      },
      reason: {
        type: 'string',
        maxLength: RELEVANCE_REASON_MAX_LENGTH,
        description: `The justification, written in German, at most ${String(RELEVANCE_REASON_MAX_LENGTH)} characters, naming the concrete decisive factor (for example the deviating field of expertise, the deviating seniority level, a work location outside the search area, or a staffing-agency placement instead of permanent employment).`,
      },
    },
    required: ['verdict', 'reason'],
    additionalProperties: false,
  },
};

/**
 * One content block of an answer, reduced to what identifies a tool call.
 *
 * `name` is optional and `input` is `unknown` because a text block carries neither. `input` stays
 * `unknown` all the way to `parseRelevanceResponse`: it is the `input` property of a third-party
 * tool-use block, with no guarantee beyond having been JSON, and typing it as anything else here
 * would be a claim this file cannot back.
 */
export const anthropicContentBlockSchema = z.object({
  type: z.string(),
  name: z.string().optional(),
  // `.optional()` is load-bearing: a bare `z.unknown()` key is *required* in Zod 4 and would reject
  // every text block, which is the shape a model answers with when it narrates before calling the
  // tool. That would turn a usable answer into a `SCHEMA_VIOLATION`.
  input: z.unknown().optional(),
});

/** One content block, after the parse. */
export type AnthropicContentBlock = z.infer<typeof anthropicContentBlockSchema>;

/**
 * The envelope of a Messages API answer.
 *
 * `model` is optional so that an answer that omits it still counts: the assessor then stores the
 * configured model name instead of discarding a usable verdict over a missing label. `stop_reason`
 * is read for the Log_Stream only — a `max_tokens` stop with no tool call is already covered by
 * there being no tool call.
 */
export const anthropicMessageResponseSchema = z.object({
  model: z.string().min(1).optional(),
  stop_reason: z.string().nullish(),
  content: z.array(anthropicContentBlockSchema),
});

/** A Messages API answer, after the parse. */
export type AnthropicMessageResponse = z.infer<typeof anthropicMessageResponseSchema>;

/**
 * The input of the first tool call of an answer that announces the given tool name.
 *
 * `undefined` when the model answered without calling that tool — prose, a refusal, an output cut
 * short by the token limit — which the caller maps to `SCHEMA_VIOLATION` (15.12). The block name is
 * checked rather than assumed: `tool_choice` forces one tool, but acting on a block that announces
 * a different name would mean reading an answer to a question that was not asked.
 *
 * Generic in the tool name because 15.17 permits the AI_Provider for two uses, and the second one —
 * the work location normalization of 8.6 behind `LOCATION_NORMALIZER` — reads its answer out of the
 * same envelope with a different tool. Writing the lookup twice would be two chances to forget the
 * name check.
 */
export const anthropicToolInput = (response: AnthropicMessageResponse, toolName: string): unknown =>
  response.content.find(
    (block) => block.type === ANTHROPIC_TOOL_USE_BLOCK_TYPE && block.name === toolName,
  )?.input;

/**
 * The input of the first `report_relevance` tool call of an answer.
 *
 * `undefined` when the model answered without calling the tool, which the caller maps to
 * `SCHEMA_VIOLATION` (15.12).
 */
export const reportRelevanceToolInput = (response: AnthropicMessageResponse): unknown =>
  anthropicToolInput(response, ANTHROPIC_TOOL_NAME);
