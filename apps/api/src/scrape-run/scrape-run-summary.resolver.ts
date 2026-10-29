import { Parent, ResolveField, Resolver } from '@nestjs/graphql';

import { RUN_OUTCOME_LABELS_DE } from '../common/error-mapping';
import { ScrapeRunSummaryModel } from './models/scrape-run-summary.model';
import type { ScrapeRunSummary } from './scrape-run-read.service';

/**
 * The one resolved field of `ScrapeRunSummary`: the Run_Outcome as German text (11.5).
 *
 * Requirement 11.5 asks the posting overview to state the Run_Outcome of the most recently
 * completed Scrape_Run, and a Run_Outcome is one of three values of a closed vocabulary — so what
 * the user reads is a label, not the enum value. The label belongs here and not in the Web_App for
 * the reason the ownership table in `apps/web/src/i18n/de.ts` already records: `RUN_OUTCOME_LABELS_DE`
 * in `../common/error-mapping.ts` is where those three German words live, because the Log_Stream
 * lines and the rejected cancellation of 12.14 already say them. A second copy in the Web_App would
 * be a second wording of a list the glossary declares closed, and the one that drifts is whichever
 * is edited second.
 *
 * The same arrangement as `JobPosting.bestCommuteLabelDe`: the enum value stays published next to
 * the label, so a reader that wants to branch on the Run_Outcome still can, while the reader that
 * only wants to print it does not have to own a translation table.
 *
 * A resolver class of its own, because `ScrapeRunReadResolver` is declared
 * `@Resolver(() => ScrapeRunModel)` and a `@ResolveField` there attaches to `ScrapeRun`, not to
 * this type. Nest merges both into the one object type, so the split costs nothing in the schema.
 *
 * `ScrapeRun` carries a label of the same name since the end-of-run summary of 12.10, and the two
 * are not a duplicated translation: both read `RUN_OUTCOME_LABELS_DE`, and they differ in exactly
 * the way the two types differ — there the field is nullable, because a running Scrape_Run has no
 * Run_Outcome yet, while here it is not, because `runOutcome` is always "completed" (11.7).
 *
 * Requirements: 11.5.
 */
@Resolver(() => ScrapeRunSummaryModel)
export class ScrapeRunSummaryResolver {
  /** The Run_Outcome of this Scrape_Run as the German label the overview prints (11.5). */
  @ResolveField(() => String, {
    name: 'runOutcomeLabelDe',
    description:
      'The Run_Outcome as German text, for a reader that prints it rather than branching on it.',
  })
  runOutcomeLabelDe(@Parent() summary: ScrapeRunSummary): string {
    return RUN_OUTCOME_LABELS_DE[summary.runOutcome];
  }
}
