/**
 * The typed JSON columns of the Posting_Store.
 *
 * `prisma-json-types-generator` reads the `/// [TypeName]` annotation above a `Json` column in
 * `prisma/schema.prisma` and rewrites that column's type in the generated client to
 * `PrismaJson.TypeName`. Both annotated columns are declared here:
 *
 * - `ScrapeRunPlatformResult.effectiveProfile` — the effective Search_Profile applied to one
 *   Platform in one Scrape_Run (3.8). It is history, not configuration: the Default_Search_Profile
 *   and every Platform_Override stay TypeScript constants in `@job-scraper/domain`, so a past run
 *   remains reproducible after those constants change.
 * - `LogMessage.detail` — the structured context of a Log_Stream message, with every secret already
 *   masked before it is persisted (14.9).
 *
 * The field vocabulary is not restated here: `Platform`, `CriterionField` and the per-field value
 * types come from `@job-scraper/domain`, which is the single place the closed value lists and the
 * Search_Profile shape are declared. The resolver that produces these snapshots lands with the
 * Profile_Resolver task; its `EffectiveSearchProfile` is structurally the type declared below, so
 * the snapshot it writes is accepted without a cast.
 */

import type { CriterionField, Platform, SearchProfile } from '@job-scraper/domain';

declare global {
  namespace PrismaJson {
    /** Where a resolved criterion value came from (5.2, 5.3, 5.6). */
    type FieldProvenanceJson = 'DEFAULT' | 'OVERRIDE';

    /** One resolved Criterion_Field with its value and its provenance. */
    type EffectiveCriterionJson = {
      readonly field: CriterionField;
      readonly value: SearchProfile[CriterionField];
      readonly provenance: FieldProvenanceJson;
    };

    /**
     * The effective Search_Profile of one Platform in one Scrape_Run: exactly one entry per
     * Criterion_Field that Platform supports, in `supportedFields` order (5.4, 5.7).
     */
    type EffectiveSearchProfileJson = {
      readonly platform: Platform;
      readonly criteria: readonly EffectiveCriterionJson[];
    };

    /**
     * Structured context of a Log_Stream message. Intentionally open: each message code carries its
     * own keys (platform name, source URL, missing field names, attempt counts). Values are
     * `unknown` so that reading code has to narrow before it uses them.
     */
    type LogMessageDetailJson = Readonly<Record<string, unknown>>;
  }
}
