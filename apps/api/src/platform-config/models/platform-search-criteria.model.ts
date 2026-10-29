import type { CriterionField, FieldProvenance, Platform } from '@job-scraper/domain';
import { Field, ObjectType } from '@nestjs/graphql';

import { PlatformEnumRef, PlatformStatusEnumRef } from '../../graphql/domain-enums';
import type { StartupPlatformStatus } from '../platform-config.resolve';
import type { CriterionView, PlatformCriteriaView } from '../platform-criteria-view';
import { FieldProvenanceEnumRef } from './field-provenance.enum';

/**
 * One resolved Criterion_Field of one Platform (4.11, 4.12).
 *
 * `field` is the English Criterion_Field identifier — `jobTitle`, `searchRadiusKm` — and is published
 * as a `String` rather than as an enum, because `@job-scraper/domain` declares `CriterionField` as
 * `keyof SearchProfile` and has no value list to register one from. Adding a tuple there to publish
 * an enum here would mean two declarations of the same key set, which is the one thing the domain
 * types avoid everywhere else.
 *
 * `valueText` is the resolved value as one German line — "Festanstellung", "50 km" — built by
 * `../criterion-value-text.ts`; see `../platform-criteria-view.ts` for why the view renders it
 * instead of publishing its shape.
 *
 * Requirements: 4.11, 4.12.
 */
@ObjectType('EffectiveCriterion', {
  description: 'One resolved search criterion of one Platform.',
})
export class EffectiveCriterionModel implements CriterionView {
  @Field(() => String, {
    description:
      'Name of the Criterion_Field, as an English identifier. Only the Criterion_Field the Platform supports appear.',
  })
  field: CriterionField;

  @Field(() => String, {
    description: 'The resolved value as one line of text; a list of values is joined with ", ".',
  })
  valueText: string;

  @Field(() => FieldProvenanceEnumRef, {
    description:
      'Which source supplied the value: the Default_Search_Profile or the Platform_Override.',
  })
  provenance: FieldProvenance;
}

/**
 * The effective Search_Profile of one Platform, read-only (4.11, 4.12, 4.13).
 *
 * The answer to `searchCriteria` is one of these per supported Platform, and it carries the state
 * next to the criteria on purpose: 19.1 shows a deactivated Platform and one whose mandatory fields
 * did not resolve, and neither has a useful criteria list — the Platform_Status and the missing field
 * names are what the user needs there (4.7, 4.9, 4.10).
 *
 * The state arrives in German as well as as an enum, the same way `ScrapeRunPlatformResult`
 * publishes `platformStatusLabelDe`: the label of a 14-value closed vocabulary and the sentence that
 * explains a configuration state are the API_Service's, so a client that only prints them holds no
 * translation table. The enum stays next to them for a client that branches on it.
 *
 * Read-only in the schema as well: there is no input type and no mutation that writes any of this.
 * The Default_Search_Profile, the Platform_Override and the activation flags are TypeScript
 * constants a developer edits and restarts (3.9), which is what 4.13 asks the Web_App to refer the
 * user to the Steering_Docs for.
 *
 * `implements PlatformCriteriaView` is the load-bearing part of this declaration, as on every other
 * model here: the view in `../platform-criteria-view.ts` owns the values and this class publishes
 * them, so the two cannot drift apart without `pnpm check-types` failing.
 *
 * Requirements: 4.7, 4.9, 4.10, 4.11, 4.12, 4.13.
 */
@ObjectType('PlatformSearchCriteria', {
  description: 'The effective, read-only search criteria of one Platform.',
})
export class PlatformSearchCriteriaModel implements PlatformCriteriaView {
  @Field(() => PlatformEnumRef, { description: 'The Platform these criteria belong to.' })
  platform: Platform;

  @Field(() => Boolean, {
    description: 'Whether the source code marks this Platform as activated (4.6).',
  })
  activated: boolean;

  @Field(() => PlatformStatusEnumRef, {
    description:
      'The configuration state of this Platform before the first Scrape_Run: ready, deactivated in the source code, or incomplete configuration.',
  })
  platformStatus: StartupPlatformStatus;

  @Field(() => String, {
    description:
      'The Platform_Status as German text, for a reader that prints it rather than branching on it.',
  })
  platformStatusLabelDe: string;

  @Field(() => String, {
    nullable: true,
    description:
      'Why this Platform is in that configuration state, as one German sentence: deactivated in the source code (4.7), or incomplete configuration with the missing field names (4.9). Null for a Platform that is configured and will be queried.',
  })
  configurationHintDe: string | null;

  @Field(() => [EffectiveCriterionModel], {
    description:
      'Exactly one entry per Criterion_Field this Platform supports. Empty where the mandatory Criterion_Field did not resolve.',
  })
  criteria: readonly CriterionView[];

  @Field(() => [String], {
    description:
      'The mandatory Criterion_Field that neither the Default_Search_Profile nor the Platform_Override resolved. Empty unless the Platform_Status is "incomplete configuration" (4.10).',
  })
  missingMandatoryFields: readonly CriterionField[];
}
