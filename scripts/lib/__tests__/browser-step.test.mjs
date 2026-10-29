/**
 * Step 3 of the Start_Script: the browser check of 1.1, its single progress line (1.2) and the fatal
 * failures of 1.7.
 *
 * The plan output comes from `playwright-plan.fixture.mjs` and is the real output of `playwright
 * install --dry-run chromium`, kept verbatim because the parser keys on its indentation and on the
 * `Install location:` label. It lives in a fixture rather than here because the orchestration suite
 * needs a plan step 3 accepts as well.
 */

import { describe, expect, it } from 'vitest';

import {
  parseInstallPlan,
  PLAYWRIGHT_INSTALL_COMMAND,
  PLAYWRIGHT_PLAN_COMMAND,
  runBrowserBinaryStep,
  selectMissingBinaries,
} from '../browser-step.mjs';
import { EXIT_CODES, StartStepError } from '../errors.mjs';
import { BROWSER_BINARY_OUTCOMES } from '../outcomes.mjs';
import { createReporter } from '../reporter.mjs';
import {
  commandKey,
  createFakeCommandRunner,
  createRecordingReporter,
  failure,
  success,
} from './fake-command-runner.mjs';
import {
  CHROMIUM_PLAN_LOCATIONS,
  CHROMIUM_PLAN_OUTPUT,
  createInstalledBrowserFiles,
  PLAYWRIGHT_CACHE,
} from './playwright-plan.fixture.mjs';

const PLAN_KEY = commandKey(PLAYWRIGHT_PLAN_COMMAND);
const INSTALL_KEY = commandKey(PLAYWRIGHT_INSTALL_COMMAND);

const CACHE = PLAYWRIGHT_CACHE;
const PLAN_OUTPUT = CHROMIUM_PLAN_OUTPUT;
const ALL_LOCATIONS = CHROMIUM_PLAN_LOCATIONS;
const createExists = createInstalledBrowserFiles;

describe('parseInstallPlan', () => {
  it('reads the three file sets playwright places for chromium', () => {
    expect(parseInstallPlan(PLAN_OUTPUT)).toStrictEqual([
      {
        title: 'Chrome for Testing 156.0.8078.4 (playwright chromium v1248)',
        location: `${CACHE}/chromium-1248`,
      },
      { title: 'FFmpeg (playwright ffmpeg v1013)', location: `${CACHE}/ffmpeg-1013` },
      {
        title: 'Chrome Headless Shell 156.0.8078.4 (playwright chromium-headless-shell v1248)',
        location: `${CACHE}/chromium_headless_shell-1248`,
      },
    ]);
  });

  it('reads no file set from an empty output', () => {
    expect(parseInstallPlan('')).toStrictEqual([]);
  });
});

describe('selectMissingBinaries', () => {
  it('counts a directory without the completion marker as missing', () => {
    const planned = parseInstallPlan(PLAN_OUTPUT);
    const missing = selectMissingBinaries(planned, {
      exists: createExists([`${CACHE}/chromium-1248`, `${CACHE}/ffmpeg-1013`]),
    });

    expect(missing.map((binary) => binary.location)).toStrictEqual([
      `${CACHE}/chromium_headless_shell-1248`,
    ]);
  });

  it('counts nothing as missing when every marker is present', () => {
    expect(
      selectMissingBinaries(parseInstallPlan(PLAN_OUTPUT), { exists: createExists(ALL_LOCATIONS) }),
    ).toStrictEqual([]);
  });
});

describe('runBrowserBinaryStep', () => {
  it('installs nothing when every browser file is present, and prints one progress line', async () => {
    const run = createFakeCommandRunner({ [PLAN_KEY]: success(PLAN_OUTPUT) });
    const { reporter, out, errorLines } = createRecordingReporter(createReporter);

    const result = await runBrowserBinaryStep({
      run,
      reporter,
      exists: createExists(ALL_LOCATIONS),
    });

    expect(result.outcome).toBe(BROWSER_BINARY_OUTCOMES.ALREADY_COMPLETE);
    expect(run.keys()).toStrictEqual([PLAN_KEY]);
    expect(out).toStrictEqual([
      'Schritt 3 von 7: Browserdateien für die Suche prüfen und fehlende nachladen …',
    ]);
    expect(errorLines).toHaveLength(0);
  });

  it('installs once when a browser file is missing and verifies it afterwards', async () => {
    const run = createFakeCommandRunner({
      [PLAN_KEY]: success(PLAN_OUTPUT),
      [INSTALL_KEY]: success('downloaded\n'),
    });
    const { reporter, out } = createRecordingReporter(createReporter);
    let installed = false;
    const presentAfterInstall = createExists(ALL_LOCATIONS);
    const presentBeforeInstall = createExists([`${CACHE}/chromium-1248`, `${CACHE}/ffmpeg-1013`]);

    const result = await runBrowserBinaryStep({
      run: (spec) => {
        if (commandKey(spec) === INSTALL_KEY) {
          installed = true;
        }

        return run(spec);
      },
      reporter,
      exists: (path) => (installed ? presentAfterInstall(path) : presentBeforeInstall(path)),
    });

    expect(result.outcome).toBe(BROWSER_BINARY_OUTCOMES.INSTALLED);
    expect(result.installed.map((binary) => binary.location)).toStrictEqual([
      `${CACHE}/chromium_headless_shell-1248`,
    ]);
    expect(run.keys()).toStrictEqual([PLAN_KEY, INSTALL_KEY]);
    expect(out).toHaveLength(1);
  });

  it('asks playwright only for chromium, never for firefox or webkit', () => {
    expect(PLAYWRIGHT_INSTALL_COMMAND.args).toContain('chromium');
    expect(PLAYWRIGHT_INSTALL_COMMAND.args).not.toContain('firefox');
    expect(PLAYWRIGHT_INSTALL_COMMAND.args).not.toContain('webkit');
    expect(PLAYWRIGHT_PLAN_COMMAND.args).toContain('--dry-run');
  });

  it('ends the start when the check itself fails', async () => {
    const run = createFakeCommandRunner({
      [PLAN_KEY]: failure({
        code: 1,
        stderr: 'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command failed\n',
      }),
    });
    const { reporter } = createRecordingReporter(createReporter);

    const error = await runBrowserBinaryStep({
      run,
      reporter,
      exists: createExists(ALL_LOCATIONS),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(StartStepError);
    expect(error.exitCode).toBe(EXIT_CODES.BROWSER_BINARY_CHECK_FAILED);
    expect(error.messageDe).toContain('konnten nicht geprüft werden');
    expect(run.keys()).toStrictEqual([PLAN_KEY]);
  });

  it('ends the start when the check output names no browser file', async () => {
    const run = createFakeCommandRunner({ [PLAN_KEY]: success('\n') });
    const { reporter } = createRecordingReporter(createReporter);

    const error = await runBrowserBinaryStep({
      run,
      reporter,
      exists: createExists([]),
    }).catch((caught) => caught);

    expect(error.exitCode).toBe(EXIT_CODES.BROWSER_BINARY_CHECK_FAILED);
    expect(run.keys()).toStrictEqual([PLAN_KEY]);
  });

  it('ends the start with a German error naming the affected browser when the install fails', async () => {
    const run = createFakeCommandRunner({
      [PLAN_KEY]: success(PLAN_OUTPUT),
      [INSTALL_KEY]: failure({
        code: 1,
        stderr: 'Error: Download failure, code=7, url=https://cdn.playwright.dev/\n',
      }),
    });
    const { reporter } = createRecordingReporter(createReporter);

    const error = await runBrowserBinaryStep({
      run,
      reporter,
      exists: createExists([]),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(StartStepError);
    expect(error.code).toBe('BROWSER_BINARY_INSTALL_FAILED');
    expect(error.exitCode).toBe(EXIT_CODES.BROWSER_BINARY_INSTALL_FAILED);
    expect(error.exitCode).not.toBe(EXIT_CODES.SUCCESS);
    expect(error.messageDe).toContain('Chrome for Testing 156.0.8078.4');
    expect(error.messageDe).toContain('Download failure');
    expect(error.messageDe).toContain('Nächster Schritt:');
  });

  it('ends the start when the install reports success but a file is still missing', async () => {
    const run = createFakeCommandRunner({
      [PLAN_KEY]: success(PLAN_OUTPUT),
      [INSTALL_KEY]: success('downloaded\n'),
    });
    const { reporter } = createRecordingReporter(createReporter);

    const error = await runBrowserBinaryStep({
      run,
      reporter,
      exists: createExists([`${CACHE}/chromium-1248`, `${CACHE}/ffmpeg-1013`]),
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(StartStepError);
    expect(error.exitCode).toBe(EXIT_CODES.BROWSER_BINARY_INSTALL_FAILED);
    expect(error.messageDe).toContain('Chrome Headless Shell 156.0.8078.4');
  });
});
