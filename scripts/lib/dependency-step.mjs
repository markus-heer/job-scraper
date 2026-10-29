/**
 * Step 2: install the workspace dependencies (1.1, 1.2, 1.6).
 *
 * The shortest of the three steps, and the only interesting decision is the one 1.6 makes for it: a
 * failed install is fatal. Nothing that follows can work without it — step 3 reaches Playwright through
 * the installed workspace, step 5 reaches Prisma the same way — so continuing would turn one honest
 * German sentence into a cascade of confusing ones.
 *
 * `pnpm install` and no flag: the command is the one Requirement 1.6 names, and the user running the
 * Start_Script is the owner of the lockfile. `--frozen-lockfile` would be the CI choice and would fail
 * the start whenever the user themselves changed a dependency.
 *
 * No timeout: a first install on a fresh machine legitimately takes minutes, and a start that kills it
 * halfway would leave a partially installed store behind.
 *
 * Requirements: 1.1, 1.2, 1.6.
 */

import { extractFailureDetail } from './command-runner.mjs';
import { EXIT_CODES, StartStepError } from './errors.mjs';
import { DEPENDENCY_INSTALL_OUTCOMES } from './outcomes.mjs';
import { dependencyInstallFailedError } from './start.messages.mjs';
import { START_STEPS } from './steps.mjs';

/** The command of step 2. */
export const PNPM_INSTALL_COMMAND = Object.freeze({
  command: 'pnpm',
  args: Object.freeze(['install']),
});

/**
 * Runs step 2: one progress line, then one install.
 *
 * @param {object} dependencies
 * @param {import('./command-runner.mjs').CommandRunner} dependencies.run
 * @param {import('./reporter.mjs').Reporter} dependencies.reporter
 * @returns {Promise<{ outcome: string }>}
 * @throws {StartStepError} When the install fails (1.6). The orchestrator prints `messageDe` and exits
 *   with `exitCode`, so none of the remaining steps runs.
 */
export async function runDependencyInstallStep({ run, reporter }) {
  reporter.progress(START_STEPS.DEPENDENCY_INSTALL);

  const result = await run(PNPM_INSTALL_COMMAND);

  if (result.ok) {
    return { outcome: DEPENDENCY_INSTALL_OUTCOMES.INSTALLED };
  }

  throw new StartStepError({
    message: 'pnpm install failed; the Start_Script runs none of the remaining steps (1.6).',
    messageDe: dependencyInstallFailedError({
      detail: extractFailureDetail(result),
      exitCode: result.code,
    }),
    code: 'DEPENDENCY_INSTALL_FAILED',
    exitCode: EXIT_CODES.DEPENDENCY_INSTALL_FAILED,
  });
}
