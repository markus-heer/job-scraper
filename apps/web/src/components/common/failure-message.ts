import { CombinedGraphQLErrors } from '@apollo/client/errors';

import { de } from '../../i18n/de';

/**
 * The German sentence to show for a refused write (2.5, 10.14).
 *
 * Shared by every control that sends a mutation, because the choice it makes is the German-text
 * ownership rule of `project-context.md` in three lines and a second copy of it would drift:
 *
 * - **A GraphQL error carries the sentence the API_Service worded**, and it is returned unchanged.
 *   `mapFailure` in `apps/api/src/common/error-mapping.ts` is where that wording lives, and the
 *   Web_App has no copy of it to put here instead.
 * - **No answer at all** means the mutation never reached a resolver, which is the API_Service not
 *   running: `de.errors.offline`, whose next step is the Start_Script.
 * - **An answer that arrived but held no message** is the residual case and gets
 *   `de.errors.unexpected`, which points at the Log_View.
 *
 * @param error Whatever the mutation promise rejected with.
 * @returns One German sentence, ready to be handed to `ErrorNotice` unchanged.
 */
export const failureMessageOf = (error: unknown): string => {
  if (CombinedGraphQLErrors.is(error)) {
    return error.errors.at(0)?.message ?? de.errors.unexpected;
  }

  return de.errors.offline;
};
