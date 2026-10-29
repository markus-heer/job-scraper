/**
 * What `playwright install --dry-run chromium` prints, as it really prints it.
 *
 * Kept verbatim and in one place: the parser of step 3 keys on the indentation and on the
 * `Install location:` label, and both the step's own suite and the orchestration suite need a plan
 * that step 3 accepts. Asking for `chromium` yields three file sets, not one — the browser, the
 * headless shell that is actually launched, and the FFmpeg helper.
 */

import { join } from 'node:path';

import { INSTALLATION_MARKER_FILE } from '../browser-step.mjs';

/** Where Playwright keeps its downloads on the developer machine this output came from. */
export const PLAYWRIGHT_CACHE = '/Users/example/Library/Caches/ms-playwright';

/** The plan output of `playwright install --dry-run chromium`. */
export const CHROMIUM_PLAN_OUTPUT = [
  'Chrome for Testing 156.0.8078.4 (playwright chromium v1248)',
  `  Install location:    ${PLAYWRIGHT_CACHE}/chromium-1248`,
  '  Download url:        https://cdn.playwright.dev/builds/cft/156.0.8078.4/mac-arm64/chrome-mac-arm64.zip',
  'FFmpeg (playwright ffmpeg v1013)',
  `  Install location:    ${PLAYWRIGHT_CACHE}/ffmpeg-1013`,
  '  Download url:        https://cdn.playwright.dev/builds/ffmpeg/1013/ffmpeg-mac-arm64.zip',
  '  Download fallback 1: https://playwright.download.prss.microsoft.com/builds/ffmpeg/1013/ffmpeg-mac-arm64.zip',
  'Chrome Headless Shell 156.0.8078.4 (playwright chromium-headless-shell v1248)',
  `  Install location:    ${PLAYWRIGHT_CACHE}/chromium_headless_shell-1248`,
  '  Download url:        https://cdn.playwright.dev/builds/cft/156.0.8078.4/mac-arm64/chrome-headless-shell-mac-arm64.zip',
  '',
].join('\n');

/** Every location that plan names, in the order it names them. */
export const CHROMIUM_PLAN_LOCATIONS = Object.freeze([
  `${PLAYWRIGHT_CACHE}/chromium-1248`,
  `${PLAYWRIGHT_CACHE}/ffmpeg-1013`,
  `${PLAYWRIGHT_CACHE}/chromium_headless_shell-1248`,
]);

/**
 * A filesystem in which exactly the given browser directories carry Playwright's completion marker.
 *
 * @param {readonly string[]} installedLocations
 * @returns {(path: string) => boolean}
 */
export function createInstalledBrowserFiles(installedLocations) {
  const markers = new Set(
    installedLocations.map((location) => join(location, INSTALLATION_MARKER_FILE)),
  );

  return (path) => markers.has(path);
}
