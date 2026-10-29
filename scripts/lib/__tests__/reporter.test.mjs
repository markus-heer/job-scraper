/**
 * The counting rule of 1.2: exactly one German progress line per step, on stdout, and nothing else on
 * stdout.
 */

import { describe, expect, it } from 'vitest';

import { createReporter, ProgressLineError } from '../reporter.mjs';
import { STEP_PROGRESS_TEXT_DE } from '../start.messages.mjs';
import { START_STEPS, TOTAL_STEP_COUNT } from '../steps.mjs';
import { createRecordingReporter } from './fake-command-runner.mjs';

describe('createReporter', () => {
  it('prints one line per step, numbered within the seven steps of 1.1', () => {
    const { reporter, out } = createRecordingReporter(createReporter);

    for (const step of Object.values(START_STEPS)) {
      reporter.progress(step);
    }

    expect(out).toHaveLength(TOTAL_STEP_COUNT);
    expect(out.every((line) => line.startsWith('Schritt ') && line.includes(' von 7: '))).toBe(
      true,
    );
    expect(reporter.announcedSteps()).toStrictEqual([
      'GIT_PULL',
      'DEPENDENCY_INSTALL',
      'BROWSER_BINARIES',
      'POSTGRES_CONTAINER',
      'PRISMA_MIGRATIONS',
      'API_SERVICE',
      'WEB_APP',
    ]);
  });

  it('refuses a second progress line for the same step', () => {
    const { reporter, out } = createRecordingReporter(createReporter);

    reporter.progress(START_STEPS.GIT_PULL);

    expect(() => reporter.progress(START_STEPS.GIT_PULL)).toThrow(ProgressLineError);
    expect(out).toHaveLength(1);
  });

  it('refuses a step it has no German progress text for', () => {
    const { reporter, out } = createRecordingReporter(createReporter);
    // Every step of 1.1 has its text now, so the guard is shown with a step id that is not one of the
    // seven. That is the case it has to catch from here on: a renamed or invented step id.
    const notAStep = Object.freeze({ id: 'DATABASE_SEED', number: 8 });

    expect(() => reporter.progress(notAStep)).toThrow(ProgressLineError);
    expect(out).toHaveLength(0);
  });

  it('keeps warnings and errors off stdout, so stdout carries the progress lines alone', () => {
    const { reporter, out, errorLines } = createRecordingReporter(createReporter);

    reporter.progress(START_STEPS.GIT_PULL);
    reporter.warn('Hinweis: Die Aktualisierung wird übersprungen.');
    reporter.error('Fehler: Der Start wird abgebrochen.');

    expect(out).toHaveLength(1);
    expect(errorLines).toHaveLength(2);
  });

  it('has a German progress text for every step of 1.1 and for no other', () => {
    expect(Object.keys(STEP_PROGRESS_TEXT_DE)).toStrictEqual(Object.keys(START_STEPS));
    expect(Object.keys(STEP_PROGRESS_TEXT_DE)).toHaveLength(TOTAL_STEP_COUNT);
  });

  it('puts the address line of 1.9 on stdout, without counting it as a step', () => {
    const { reporter, out, errorLines } = createRecordingReporter(createReporter);

    reporter.progress(START_STEPS.WEB_APP);
    reporter.info('Fertig: Die Oberfläche ist unter http://127.0.0.1:5173/ erreichbar.');

    expect(out).toHaveLength(2);
    expect(errorLines).toHaveLength(0);
    expect(reporter.announcedSteps()).toStrictEqual(['WEB_APP']);
  });
});
