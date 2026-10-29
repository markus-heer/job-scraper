/**
 * Step 2 of the Start_Script: the install of 1.1, its single progress line (1.2) and the fatal failure
 * of 1.6.
 */

import { describe, expect, it } from 'vitest';

import { PNPM_INSTALL_COMMAND, runDependencyInstallStep } from '../dependency-step.mjs';
import { EXIT_CODES, StartStepError } from '../errors.mjs';
import { DEPENDENCY_INSTALL_OUTCOMES } from '../outcomes.mjs';
import { createReporter } from '../reporter.mjs';
import {
  commandKey,
  createFakeCommandRunner,
  createRecordingReporter,
  failure,
  success,
} from './fake-command-runner.mjs';

const INSTALL_KEY = commandKey(PNPM_INSTALL_COMMAND);

describe('runDependencyInstallStep', () => {
  it('installs once and prints exactly one progress line', async () => {
    const run = createFakeCommandRunner({ [INSTALL_KEY]: success('Done in 3.2s\n') });
    const { reporter, out, errorLines } = createRecordingReporter(createReporter);

    const result = await runDependencyInstallStep({ run, reporter });

    expect(result.outcome).toBe(DEPENDENCY_INSTALL_OUTCOMES.INSTALLED);
    expect(run.keys()).toStrictEqual(['pnpm install']);
    expect(out).toStrictEqual(['Schritt 2 von 7: Abhängigkeiten installieren …']);
    expect(errorLines).toHaveLength(0);
  });

  it('ends the start with a German error naming the cause and a non-zero exit code', async () => {
    const run = createFakeCommandRunner({
      [INSTALL_KEY]: failure({
        code: 1,
        stderr:
          'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date\n',
      }),
    });
    const { reporter } = createRecordingReporter(createReporter);

    const error = await runDependencyInstallStep({ run, reporter }).catch((caught) => caught);

    expect(error).toBeInstanceOf(StartStepError);
    expect(error.code).toBe('DEPENDENCY_INSTALL_FAILED');
    expect(error.exitCode).toBe(EXIT_CODES.DEPENDENCY_INSTALL_FAILED);
    expect(error.exitCode).not.toBe(EXIT_CODES.SUCCESS);
    expect(error.messageDe).toContain('ERR_PNPM_OUTDATED_LOCKFILE');
    expect(error.messageDe).toContain('Der Start wird abgebrochen');
    expect(error.messageDe).toContain('Nächster Schritt:');
  });

  it('reports a pnpm that is not installed as the cause', async () => {
    const run = createFakeCommandRunner({
      [INSTALL_KEY]: { ok: false, code: null, spawnFailed: true, stderr: 'spawn pnpm ENOENT' },
    });
    const { reporter } = createRecordingReporter(createReporter);

    const error = await runDependencyInstallStep({ run, reporter }).catch((caught) => caught);

    expect(error.messageDe).toContain('spawn pnpm ENOENT');
    expect(error.messageDe).toContain('ohne Rückmeldung beendet');
  });
});
