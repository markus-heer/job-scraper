/**
 * The Anthropic wire contract the {@link AnthropicLocationNormalizer} speaks, and nothing else
 * (8.6, 8.7).
 *
 * The sibling of `../relevance/anthropic-relevance.schema.ts`, built the same way and for the same
 * reason: the request side is one forced tool call, so the answer is a structured value instead of
 * German prose that would have to be read for a place name, and the answer side is gated by Zod
 * rather than trusted. The Messages API envelope itself is not restated here — it is the same
 * envelope, so {@link anthropicMessageResponseSchema} and {@link anthropicToolInput} are taken from
 * the relevance schema. 15.17 permits the AI_Provider for exactly these two uses, and one envelope
 * for both is the honest expression of that.
 *
 * ## Why the answer carries an explicit `outcome` rather than just a name
 *
 * Because the two answers have opposite retry semantics and only an explicit one can be told apart
 * from a confused model. `NO_PLACE` is a *result*: the Commute_Service records it and the value is
 * never sent again (8.7). A `PLACE` whose `placeName` is missing or blank is not an answer at all,
 * so it is a schema violation and therefore `FAILED` — nothing is recorded, and the value keeps its
 * single chance for the next Scrape_Run. Collapsing the two into one nullable field would make an
 * empty string mean "no place exists" permanently, which is too strong a conclusion to draw from a
 * field the model simply left empty.
 *
 * Requirements: 8.6, 8.7, 15.17.
 */

import { z } from 'zod';

import {
  type AnthropicMessageResponse,
  type AnthropicToolDefinition,
  anthropicToolInput,
} from '../relevance/anthropic-relevance.schema';

/** The one tool the model may call for a normalization. */
export const LOCATION_TOOL_NAME = 'report_work_location';

/**
 * Maximum length of a returned place name.
 *
 * A geocodable place name is a town, a district or a town pair — "Martinsried", "München", "Nürnberg"
 * — never a sentence. 120 characters leaves room for the longest German compound place name with a
 * qualifier and still makes a model that answered with prose fail the schema instead of being handed
 * to the geocoder and stored under `LocationNormalization.normalizedName`.
 */
export const LOCATION_PLACE_NAME_MAX_LENGTH = 120;

/** What the model may report about a free-text work location. */
export const LOCATION_OUTCOME_KINDS = ['PLACE', 'NO_PLACE'] as const;

/** One reported outcome. */
export type LocationOutcomeKind = (typeof LOCATION_OUTCOME_KINDS)[number];

/**
 * The `report_work_location` tool (8.6).
 *
 * The descriptions are prompt, not documentation: they are what the model reads while filling the
 * fields in, so the one rule that matters — answer a place a geocoder can find, or say there is
 * none, and invent nothing in between — is stated where it is read.
 */
export const LOCATION_TOOL_DEFINITION: AnthropicToolDefinition = {
  name: LOCATION_TOOL_NAME,
  description:
    'Reports the geocodable place name contained in one free-text work location, or that it contains none. Call this tool exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        enum: [...LOCATION_OUTCOME_KINDS],
        description:
          'PLACE when the value names a settlement, district or address a geocoder could find; NO_PLACE when it names nothing below country level, for example a work arrangement, a country, a region or a vague statement.',
      },
      placeName: {
        type: 'string',
        maxLength: LOCATION_PLACE_NAME_MAX_LENGTH,
        description:
          'Required when outcome is PLACE: the place name alone, without a work arrangement, an employer, a street number or any extra words. Omit it when outcome is NO_PLACE. Never guess a place that the value does not contain.',
      },
    },
    required: ['outcome'],
    additionalProperties: false,
  },
};

/**
 * Schema of one usable normalization answer.
 *
 * `placeName` is optional here and checked against `outcome` by {@link parseLocationResponse}: the
 * tool schema cannot express "required only when", and a model that omits it for `NO_PLACE` has
 * answered correctly. Unknown properties are stripped rather than rejected, as on the relevance
 * side — a model that adds a field it was not asked for has still answered the question.
 */
export const locationResponseSchema = z.object({
  outcome: z.enum(LOCATION_OUTCOME_KINDS),
  placeName: z.string().max(LOCATION_PLACE_NAME_MAX_LENGTH).optional(),
});

/** One usable normalization answer, after the parse and the cross-field check. */
export type LocationResponse =
  { readonly outcome: 'PLACE'; readonly placeName: string } | { readonly outcome: 'NO_PLACE' };

/**
 * Parses the input of a `report_work_location` tool call and turns every violation into "no usable
 * answer".
 *
 * Total over `unknown`, like `parseRelevanceResponse`: reading any answer yields either a place name
 * the geocoder can be asked about, the explicit "no place", or `null`. `null` becomes
 * `{ kind: 'FAILED' }`, which records nothing and so leaves the value its single chance of 8.7.
 *
 * A `PLACE` whose name is blank after trimming is a violation rather than a `NO_PLACE`; see the file
 * comment. The trimmed name is what is returned, because it is what gets geocoded and stored.
 */
export const parseLocationResponse = (toolInput: unknown): LocationResponse | null => {
  const result = locationResponseSchema.safeParse(toolInput);

  if (!result.success) {
    return null;
  }

  if (result.data.outcome === 'NO_PLACE') {
    return { outcome: 'NO_PLACE' };
  }

  const placeName = (result.data.placeName ?? '').trim();

  return placeName === '' ? null : { outcome: 'PLACE', placeName };
};

/** The input of the first `report_work_location` tool call of an answer. */
export const reportWorkLocationToolInput = (response: AnthropicMessageResponse): unknown =>
  anthropicToolInput(response, LOCATION_TOOL_NAME);
