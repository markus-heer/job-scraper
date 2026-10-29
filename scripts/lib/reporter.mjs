/**
 * What the Start_Script writes to the console.
 *
 * 1.2 asks for *exactly one* German progress line per step, which is a counting rule, so it is enforced
 * by the writer rather than trusted to the steps:
 *
 * - a step announces itself with `progress(step)`, which takes no text. The German sentence comes from
 *   `start.messages.mjs`, keyed by step id, so a step cannot invent a second wording;
 * - a second `progress` call for the same step is a defect and throws. The step runners call it once at
 *   their start, and the Vitest suite asserts the count per step;
 * - a step the message module has no text for throws as well, which is what kept the then unimplemented
 *   steps 4 to 7 from printing anything and now keeps a step id nobody declared from printing;
 * - progress lines go to stdout, warnings and errors go to stderr. So stdout carries the progress lines
 *   and nothing else, which is a structural form of the counting rule rather than a promise, and the
 *   warnings of 1.3 and 1.4 cannot be mistaken for a step announcement.
 *
 * `info` is the one exception to that last point, and it exists for exactly one sentence: 1.9 asks the
 * Start_Script to print the callable address of the Web_App, which is a result and not a step
 * announcement, and which the user has to be able to copy out of stdout. It is deliberately a separate
 * method rather than a second `progress`, so the counting rule of 1.2 keeps counting steps only.
 *
 * Requirements: 1.2, 1.3, 1.4, 1.6, 1.7, 1.9.
 */

import { STEP_PROGRESS_TEXT_DE, stepProgressLine } from './start.messages.mjs';

/** A step announced itself twice, or announced itself without a German text. A defect, not a failure. */
export class ProgressLineError extends Error {
  /**
   * @param {string} message English: this is read by a developer, never by the user.
   */
  constructor(message) {
    super(message);
    this.name = 'ProgressLineError';
  }
}

/**
 * What the steps report through.
 *
 * @typedef {object} Reporter
 * @property {(step: import('./steps.mjs').StartStep) => void} progress The single line of 1.2.
 * @property {(line: string) => void} info A result the user reads on stdout; the URL line of 1.9.
 * @property {(line: string) => void} warn A non-fatal deviation; the start continues (1.3, 1.4).
 * @property {(line: string) => void} error A fatal failure; the start ends (1.6, 1.7).
 * @property {() => readonly string[]} announcedSteps The step ids announced so far, in order.
 */

/**
 * Creates the Reporter.
 *
 * @param {object} [options]
 * @param {(line: string) => void} [options.writeOut] Defaults to stdout.
 * @param {(line: string) => void} [options.writeError] Defaults to stderr.
 * @returns {Reporter}
 */
export function createReporter({
  writeOut = (line) => {
    console.log(line);
  },
  writeError = (line) => {
    console.error(line);
  },
} = {}) {
  /** @type {string[]} */
  const announced = [];

  return {
    progress(step) {
      if (announced.includes(step.id)) {
        throw new ProgressLineError(
          `Step ${step.id} already printed its progress line; 1.2 allows exactly one per step.`,
        );
      }

      const text = STEP_PROGRESS_TEXT_DE[step.id];

      if (text === undefined) {
        throw new ProgressLineError(
          `Step ${step.id} has no German progress text in start.messages.mjs and must not announce itself.`,
        );
      }

      announced.push(step.id);
      writeOut(stepProgressLine(step, text));
    },

    info(line) {
      writeOut(line);
    },

    warn(line) {
      writeError(line);
    },

    error(line) {
      writeError(line);
    },

    announcedSteps() {
      return [...announced];
    },
  };
}
