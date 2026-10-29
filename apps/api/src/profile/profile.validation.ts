/**
 * Fail-fast check of the Default_Search_Profile at startup (3.5, 3.6).
 *
 * The constant lives in `packages/domain` and is validated by a pure function there; what this
 * module adds is the consequence. An invalid profile has to stop the startup *before the first
 * request is accepted* (3.6), because a Scrape_Run started against an out-of-range criterion would
 * either produce a silently wrong result list or fail per Platform at a point where the user can no
 * longer tell a configuration mistake from a blocked Platform.
 *
 * The console is used directly, as in the configuration check: the Start_Script reads these lines
 * and shows them to the user, and at this point there is no Log_Stream to carry them. Output is
 * German (3.6); the `code` of every issue stays English (16.8).
 *
 * Requirements: 3.5, 3.6.
 */

import {
  DEFAULT_SEARCH_PROFILE,
  type ProfileValidationIssue,
  type SearchProfile,
  validateDefaultSearchProfile,
} from '@job-scraper/domain';

import { invalidDefaultProfileMessageDe } from './profile.messages';

/**
 * Exit code of a failed Default_Search_Profile check — any non-zero value satisfies 3.6.
 *
 * Deliberately the same value as the failed configuration check: both are "the API_Service cannot
 * start with what it was given", and the Start_Script distinguishes them by the printed message,
 * not by the code.
 */
export const PROFILE_FAILURE_EXIT_CODE = 1;

/** Result of validating the Default_Search_Profile. */
export type DefaultProfileCheckOutcome =
  | { readonly ok: true; readonly profile: SearchProfile }
  | {
      readonly ok: false;
      readonly issues: readonly ProfileValidationIssue[];
      readonly messageLinesDe: readonly string[];
    };

/**
 * Validates the Default_Search_Profile without printing or exiting.
 *
 * Separate from {@link validateDefaultSearchProfileOrExit} so that the decision ("stop the
 * process") can be tested apart from the data ("these fields are out of range"), and so that the
 * read-only criteria view of a later task can reuse the same outcome.
 *
 * @param profile The profile to check; the Default_Search_Profile constant by default.
 * @returns The profile when every range holds, otherwise the issues and the German console lines.
 */
export const checkDefaultSearchProfile = (
  profile: SearchProfile = DEFAULT_SEARCH_PROFILE,
): DefaultProfileCheckOutcome => {
  const issues = validateDefaultSearchProfile(profile);

  if (issues.length === 0) {
    return { ok: true, profile };
  }

  return { ok: false, issues, messageLinesDe: invalidDefaultProfileMessageDe(issues) };
};

/**
 * The validated Default_Search_Profile, or a stopped process (3.6).
 *
 * @param profile The profile to check; the Default_Search_Profile constant by default.
 * @returns The profile, when the process is still running.
 */
export const validateDefaultSearchProfileOrExit = (
  profile: SearchProfile = DEFAULT_SEARCH_PROFILE,
): SearchProfile => {
  const outcome = checkDefaultSearchProfile(profile);

  if (!outcome.ok) {
    for (const line of outcome.messageLinesDe) {
      console.error(line);
    }

    process.exit(PROFILE_FAILURE_EXIT_CODE);
  }

  return outcome.profile;
};
