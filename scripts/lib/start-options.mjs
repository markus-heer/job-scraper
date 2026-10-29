/**
 * What the user asked of the Start_Script on the command line (1.8).
 *
 * 1.8 asks for one switch: skip step 1 and step 2, begin with step 3, so that the Job_Tool starts
 * without a network connection. Those are exactly the two steps that need the network — the pull and
 * the install — and steps 3 to 7 need none, because the browser files are then already present, the
 * container image is local and both services bind the loopback interface.
 *
 * `--offline` is the name, because that is the situation the requirement describes rather than the
 * mechanism it uses: a user in a train knows they are offline, and does not know that the Job_Tool
 * calls the first two steps "pull" and "install". It stays an English identifier like every other one
 * (16.8); only what the console prints about it is German.
 *
 * Parsing is a pure function over an argument list so that the orchestrator stays free of decisions and
 * the suite can state what each argument list means. An argument that is not understood is *reported*
 * rather than ignored: a mistyped `--ofline` would otherwise silently do the opposite of what the user
 * wanted, which is to attempt a network operation that cannot work.
 *
 * Requirements: 1.8, 16.8.
 */

import { START_STEPS } from './steps.mjs';

/** The switch of 1.8. Used as `pnpm start --offline`. */
export const OFFLINE_FLAG = '--offline';

/** The steps the switch skips (1.8). Step 3 is where the start then begins. */
export const OFFLINE_SKIPPED_STEPS = Object.freeze([
  START_STEPS.GIT_PULL,
  START_STEPS.DEPENDENCY_INSTALL,
]);

/**
 * The options of one start.
 *
 * @typedef {object} StartOptions
 * @property {boolean} offline Whether steps 1 and 2 are skipped (1.8).
 * @property {readonly string[]} unknownArguments Arguments the Start_Script does not understand.
 */

/**
 * Reads the options out of the arguments the user passed.
 *
 * @param {readonly string[]} args Everything after the script name, that is `process.argv.slice(2)`.
 * @returns {StartOptions}
 */
export function parseStartOptions(args) {
  const recognised = new Set([OFFLINE_FLAG]);
  // `--` is how pnpm forwards arguments to the script and is not an argument of its own.
  const passed = args.filter((argument) => argument !== '' && argument !== '--');

  return {
    offline: passed.includes(OFFLINE_FLAG),
    unknownArguments: Object.freeze(passed.filter((argument) => !recognised.has(argument))),
  };
}
