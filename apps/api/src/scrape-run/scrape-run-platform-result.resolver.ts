import { Parent, ResolveField, Resolver } from '@nestjs/graphql';

import { PLATFORM_STATUS_LABELS_DE } from '../common/error-mapping';
import type { ScrapeRunPlatformResult } from '../prisma/prisma.types';
import { ScrapeRunPlatformResultModel } from './models/scrape-run-platform-result.model';

/**
 * The one resolved field of `ScrapeRunPlatformResult`: the Platform_Status as German text (7.4,
 * 12.10).
 *
 * Requirement 7.4 asks the summary of a Scrape_Run to state exactly one Platform_Status per
 * requested Platform, and 12.10 asks for it next to that Platform's new and updated counts. A
 * Platform_Status is one of 14 values of a closed vocabulary, so what the user reads is a label and
 * not the enum value — and the 14 German labels live in `PLATFORM_STATUS_LABELS_DE` in
 * `../common/error-mapping.ts`, because the Log_Stream lines of 12.3 and the per-Platform summary
 * line already say them.
 *
 * Why that matters enough for a file: the ownership table in `apps/web/src/i18n/de.ts` records that
 * the Web_App holds *no* Platform_Status wording. A copy of a 14-value list in the browser would be
 * a second wording of something the glossary declares closed, and the one that drifts is whichever
 * is edited second. With this field the Web_App prints what arrives, the same way it prints
 * `JobPosting.bestCommuteLabelDe` and `ScrapeRun.runOutcomeLabelDe`.
 *
 * The enum stays published next to the label. A client that wants to branch on the Platform_Status
 * — to mark a Platform that did not complete, say — still can, while the client that only prints it
 * does not have to own a translation table.
 *
 * A resolver class of its own for the same reason as `./scrape-run-summary.resolver.ts`:
 * `ScrapeRunReadResolver` is declared `@Resolver(() => ScrapeRunModel)`, so a `@ResolveField` there
 * attaches to `ScrapeRun`. Nest merges both classes into the one object type, so the split costs
 * nothing in the schema.
 *
 * Requirements: 7.4, 12.10.
 */
@Resolver(() => ScrapeRunPlatformResultModel)
export class ScrapeRunPlatformResultResolver {
  /** The Platform_Status of this row as the German label a summary prints (7.4, 12.10). */
  @ResolveField(() => String, {
    name: 'platformStatusLabelDe',
    description:
      'The Platform_Status as German text, for a reader that prints it rather than branching on it.',
  })
  platformStatusLabelDe(@Parent() result: ScrapeRunPlatformResult): string {
    return PLATFORM_STATUS_LABELS_DE[result.platformStatus];
  }
}
