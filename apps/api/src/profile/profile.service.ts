import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { defaultProfileSummaryDe } from './profile.messages';
import { validateDefaultSearchProfileOrExit } from './profile.validation';

/**
 * The Default_Search_Profile check in the startup sequence (3.5, 3.6).
 *
 * `onModuleInit` is what makes the timing requirement hold: Nest runs every module's init hook
 * inside `NestFactory.create`, which `main.ts` awaits before it calls `app.listen`. An invalid
 * Default_Search_Profile therefore costs a German console message and a non-zero exit code instead
 * of a listener that accepts a `startScrapeRun` mutation against an out-of-range criterion (3.6).
 *
 * The validation itself stays in `@job-scraper/domain` and the exit decision in
 * `profile.validation.ts`; this class only binds them to a lifecycle. That is deliberate — the hook
 * is the one part that cannot be exercised without a Nest module, so it holds as little logic as
 * possible.
 *
 * Requirements: 3.5, 3.6, 3.7.
 */
@Injectable()
export class DefaultProfileService implements OnModuleInit {
  private readonly logger = new Logger(DefaultProfileService.name);

  /**
   * Validates the Default_Search_Profile before the HTTP listener binds, then records it.
   *
   * On success the profile is written out with the value of every Criterion_Field (3.7), so the
   * criteria a later Scrape_Run applies are traceable from the start of the process. The Nest
   * logger is the interim sink: the Log_Stream that 3.7 names is persisted per Scrape_Run and no
   * run exists at startup, so `LogStreamService` takes this line over once it is in place.
   */
  onModuleInit(): void {
    const profile = validateDefaultSearchProfileOrExit();

    this.logger.log(`Standard-Suchprofil: ${defaultProfileSummaryDe(profile)}`);
  }
}
