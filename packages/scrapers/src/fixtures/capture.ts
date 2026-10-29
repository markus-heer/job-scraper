/**
 * The one-off fixture capture of task 9.2 (design, Testing Strategy; 6.2, 14.5).
 *
 * One invocation performs **exactly one** real Result_Page retrieval and writes it to the fixture
 * folder of its Platform. Everything that makes that defensible is in here, not in the shell script
 * that calls it:
 *
 * - the retrieval goes through the production Playwright runtime (`../runtime/browser.ts`), so it
 *   carries the unchanged Job_Tool user agent of 14.5, the fresh storage state, the resource filter
 *   and the 30-second page limit of 6.2, and it structurally cannot sign in or answer a Captcha
 *   (7.5, 7.6);
 * - the robots.txt of the Platform is fetched and evaluated first and gates the retrieval (14.1 -
 *   14.3). A capture is a request like any other; the etiquette rules do not pause for tooling;
 * - exactly one page load is permitted. The guard of {@link singleRetrievalPage} turns a second one
 *   into an error rather than a second request;
 * - the capture refuses to run under a test runner or in CI ({@link assertCapturePermitted}), which
 *   is the design's "deliberately manual" requirement made enforceable rather than documented;
 * - the captured document is sanitized before it is written (`./sanitize-html.ts`), and an existing
 *   fixture is never overwritten without `--force`, so a mistyped case cannot silently replace a
 *   reviewed capture.
 *
 * Everything the function touches is injected — argv, the environment, the browser launcher, the
 * robots.txt fetch, the filesystem, the clock — so the whole flow is testable without a browser
 * binary and without a network, which is how it is tested in `./__tests__/capture.test.ts`.
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_SEARCH_PROFILE,
  type EffectiveSearchProfile,
  type Platform,
  PLATFORM_OVERRIDES,
  resolveSearchProfile,
} from '@job-scraper/domain';

import type { AdapterPage } from '../adapter/types.js';
import { adapterFor, type AdapterRegistry } from '../registry.js';
import { evaluateRobots, type RobotsFetch, robotsPlatformStatus } from '../robots/robots.js';
import { withScrapeRunBrowser } from '../runtime/browser.js';
import type { RuntimeBrowserType } from '../runtime/playwright-port.js';
import { buildUserAgent } from '../runtime/user-agent.js';
import { type FixtureCaptureMetadata, formatFixtureMetadata } from './fixture-metadata.js';
import {
  fixtureHtmlPath,
  fixtureMetadataPath,
  isFixtureCaseName,
  parsePlatformName,
  platformFixtureDir,
} from './fixture-paths.js';
import { sanitizeFixtureHtml } from './sanitize-html.js';

/** The default fixture case, which is the first Result_Page of a Platform. */
export const DEFAULT_FIXTURE_CASE = 'result-list-page-1';

/** The environment variable the contact detail of the user agent is read from (14.5). */
export const USER_AGENT_CONTACT_VARIABLE = 'USER_AGENT_CONTACT';

/**
 * Environment variables whose presence means "this is a test run or a CI run".
 *
 * `NODE_ENV=test` is checked separately, because only its value is telling.
 */
const TEST_RUNNER_VARIABLES = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'JENKINS_URL',
  'TF_BUILD',
  'VITEST',
  'VITEST_WORKER_ID',
  'JEST_WORKER_ID',
] as const;

/** What the command line asks for. */
export interface FixtureCaptureRequest {
  readonly platform: Platform;
  readonly fixtureCase: string;
  /** The 1-based Result_Page to retrieve (13.3). */
  readonly pageNumber: number;
  /** An explicit URL, which replaces the one the Platform_Adapter would build. */
  readonly url: string | undefined;
  /** An explicit output folder, which replaces the Platform's fixture folder. */
  readonly outputDir: string | undefined;
  /** Whether an existing fixture of this case may be replaced. */
  readonly force: boolean;
}

/** The usage text, printed by the shell script when the arguments do not parse. */
export const FIXTURE_CAPTURE_USAGE = `Usage: pnpm fixtures:capture --platform <stepstone|jobvector|glassdoor|indeed> [options]

Performs exactly one real Result_Page retrieval with the production user agent and writes the
sanitized HTML plus a capture sidecar into the fixture folder of that Platform.

Options:
  --platform <name>   Required. The Platform to capture from.
  --case <name>       Fixture case name in lowercase kebab-case. Default: ${DEFAULT_FIXTURE_CASE}.
  --page <number>     The 1-based Result_Page to retrieve. Default: 1.
  --url <url>         Retrieve this URL instead of the one the Platform_Adapter builds.
  --out <dir>         Write into this folder instead of the Platform's fixture folder.
  --force             Replace an existing fixture of this case.

Requires ${USER_AGENT_CONTACT_VARIABLE} in the environment or in .env, because every request
identifies the Job_Tool with a reachable contact detail (Requirement 14.5). Never runs in a test or
in CI: capturing issues real Platform requests.`;

/** The arguments do not describe a capture. */
export class FixtureCaptureUsageError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'FixtureCaptureUsageError';
  }
}

/** The capture was started in an environment that must not issue Platform requests. */
export class FixtureCaptureNotPermittedError extends Error {
  /** The environment variable that gave the run away. */
  readonly variable: string;

  constructor(variable: string) {
    super(
      `The fixture capture performs a real Platform request and therefore never runs under a test runner or in CI; ${variable} is set.`,
    );
    this.name = 'FixtureCaptureNotPermittedError';
    this.variable = variable;
  }
}

/** The capture was refused before any page request was sent. */
export class FixtureCaptureRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'FixtureCaptureRefusedError';
  }
}

/** A second page load was attempted within one capture. */
export class FixtureCaptureSecondRetrievalError extends Error {
  constructor() {
    super('A fixture capture performs exactly one Result_Page retrieval; a second was attempted.');
    this.name = 'FixtureCaptureSecondRetrievalError';
  }
}

/** The filesystem operations the capture needs, injected so a test writes nowhere. */
export interface FixtureFileSystem {
  ensureDirectory: (dir: string) => Promise<void>;
  exists: (file: string) => Promise<boolean>;
  write: (file: string, content: string) => Promise<void>;
}

/** The production filesystem. */
export const nodeFixtureFileSystem: FixtureFileSystem = {
  ensureDirectory: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  exists: async (file) => {
    try {
      await access(file);

      return true;
    } catch {
      return false;
    }
  },
  write: async (file, content) => {
    await writeFile(file, content, 'utf8');
  },
};

/** Everything {@link runFixtureCapture} depends on. Only `argv` and `env` have no default. */
export interface FixtureCaptureDependencies {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fileSystem?: FixtureFileSystem;
  /** The browser launcher. Defaults to Playwright's Chromium through the production runtime. */
  readonly launcher?: RuntimeBrowserType;
  /** The robots.txt retrieval. Defaults to the global `fetch`. */
  readonly fetch?: RobotsFetch;
  /** The Platform_Adapter registry the result list URL is built from. */
  readonly registry?: AdapterRegistry;
  /** The capture time source. */
  readonly now?: () => Date;
  /** Where progress is reported. Defaults to `console.log`. */
  readonly log?: (message: string) => void;
  /** Cancellation, for example from a `SIGINT` handler. */
  readonly signal?: AbortSignal;
  /** The package root the fixture folder is resolved against. */
  readonly packageRoot?: string;
}

/** What one capture produced. */
export interface FixtureCaptureOutcome {
  readonly htmlPath: string;
  readonly metadataPath: string;
  readonly metadata: FixtureCaptureMetadata;
}

/**
 * Refuses the capture when the environment says the run is automated.
 *
 * @throws A {@link FixtureCaptureNotPermittedError} naming the variable that gave it away.
 */
export function assertCapturePermitted(env: Readonly<Record<string, string | undefined>>): void {
  for (const variable of TEST_RUNNER_VARIABLES) {
    const value = env[variable];

    if (value !== undefined && value !== '' && value !== 'false' && value !== '0') {
      throw new FixtureCaptureNotPermittedError(variable);
    }
  }

  if (env.NODE_ENV === 'test') {
    throw new FixtureCaptureNotPermittedError('NODE_ENV=test');
  }
}

/**
 * Parses the command line.
 *
 * @throws A {@link FixtureCaptureUsageError} for a missing or unknown flag, an unknown Platform, a
 *   case name that is not kebab-case or a page number that is not a positive integer.
 */
export function parseCaptureArguments(argv: readonly string[]): FixtureCaptureRequest {
  let platform: Platform | undefined;
  let fixtureCase = DEFAULT_FIXTURE_CASE;
  let pageNumber = 1;
  let url: string | undefined;
  let outputDir: string | undefined;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';

    switch (argument) {
      case '--platform': {
        const value = requireValue(argv, index, '--platform');

        platform = parsePlatformName(value);

        if (platform === undefined) {
          throw new FixtureCaptureUsageError(`--platform names no known Platform: ${value}`);
        }

        index += 1;
        break;
      }

      case '--case': {
        fixtureCase = requireValue(argv, index, '--case');

        if (!isFixtureCaseName(fixtureCase)) {
          throw new FixtureCaptureUsageError(
            `--case must be a lowercase kebab-case name: ${fixtureCase}`,
          );
        }

        index += 1;
        break;
      }

      case '--page': {
        const value = requireValue(argv, index, '--page');
        const parsed = Number.parseInt(value, 10);

        if (!Number.isInteger(parsed) || parsed < 1) {
          throw new FixtureCaptureUsageError(`--page must be a positive integer: ${value}`);
        }

        pageNumber = parsed;
        index += 1;
        break;
      }

      case '--url': {
        url = requireValue(argv, index, '--url');
        index += 1;
        break;
      }

      case '--out': {
        outputDir = requireValue(argv, index, '--out');
        index += 1;
        break;
      }

      case '--force': {
        force = true;
        break;
      }

      default:
        throw new FixtureCaptureUsageError(`Unknown argument: ${argument}`);
    }
  }

  if (platform === undefined) {
    throw new FixtureCaptureUsageError('--platform is required.');
  }

  return { platform, fixtureCase, pageNumber, url, outputDir, force };
}

/**
 * The value that follows a flag.
 *
 * @throws A {@link FixtureCaptureUsageError} when the flag stands at the end of the command line, so
 *   a forgotten value is reported as a usage fault instead of silently becoming `undefined`.
 */
function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];

  if (value === undefined || value.startsWith('--')) {
    throw new FixtureCaptureUsageError(`${flag} needs a value.`);
  }

  return value;
}

/**
 * Wraps a page so that it performs at most one load.
 *
 * The capture flow loads once by construction; the guard is what makes "exactly one real retrieval"
 * a property of the code rather than of reading it.
 */
export function singleRetrievalPage(page: AdapterPage): AdapterPage {
  let loaded = false;

  return {
    load: async (url) => {
      if (loaded) {
        throw new FixtureCaptureSecondRetrievalError();
      }

      loaded = true;

      return page.load(url);
    },
    html: () => page.html(),
    close: () => page.close(),
  };
}

/**
 * The URL a capture retrieves: the explicit `--url`, otherwise the result list URL the registered
 * Platform_Adapter builds from the effective Search_Profile (5.1).
 *
 * @throws A {@link FixtureCaptureUsageError} when the Platform has no adapter yet and no `--url` was
 *   given, and a {@link FixtureCaptureRefusedError} when the effective Search_Profile of that
 *   Platform cannot be resolved (5.8) — capturing against an incomplete profile would freeze a result
 *   list nobody will ever request.
 */
export function captureUrl(
  request: FixtureCaptureRequest,
  registry: AdapterRegistry | undefined,
): string {
  if (request.url !== undefined) {
    return request.url;
  }

  const adapter = adapterFor(request.platform, registry);

  if (adapter === undefined) {
    throw new FixtureCaptureUsageError(
      `No Platform_Adapter is registered for ${request.platform} yet, so the result list URL cannot be built. Pass --url to capture a specific page.`,
    );
  }

  return adapter.resultListUrl(effectiveProfile(request.platform), request.pageNumber);
}

/** The effective Search_Profile of one Platform, resolved from the repository's criteria (5.1). */
function effectiveProfile(platform: Platform): EffectiveSearchProfile {
  const resolution = resolveSearchProfile(platform, DEFAULT_SEARCH_PROFILE, PLATFORM_OVERRIDES);

  if (!resolution.ok) {
    throw new FixtureCaptureRefusedError(
      `The effective Search_Profile of ${platform} is incomplete; unresolved mandatory fields: ${resolution.error.missingMandatoryFields.join(', ')}.`,
    );
  }

  return resolution.profile;
}

/**
 * Performs one fixture capture.
 *
 * @returns Where the fixture and its sidecar were written, plus the sidecar content.
 * @throws A {@link FixtureCaptureNotPermittedError} in a test or CI environment, a
 *   {@link FixtureCaptureUsageError} for unusable arguments, and a {@link FixtureCaptureRefusedError}
 *   when the contact detail is missing, the robots.txt forbids or cannot be evaluated, or the fixture
 *   exists and `--force` was not given.
 */
export async function runFixtureCapture(
  dependencies: FixtureCaptureDependencies,
): Promise<FixtureCaptureOutcome> {
  assertCapturePermitted(dependencies.env);

  const request = parseCaptureArguments(dependencies.argv);
  const fileSystem = dependencies.fileSystem ?? nodeFixtureFileSystem;
  const log =
    dependencies.log ??
    ((message: string) => {
      console.log(message);
    });
  const now = dependencies.now ?? (() => new Date());
  const signal = dependencies.signal ?? new AbortController().signal;
  const userAgent = buildUserAgent(contactDetail(dependencies.env));
  const url = captureUrl(request, dependencies.registry);
  const fixtureDir =
    request.outputDir ?? platformFixtureDir(request.platform, dependencies.packageRoot);
  const htmlPath = fixtureHtmlPath(fixtureDir, request.fixtureCase);
  const metadataPath = fixtureMetadataPath(fixtureDir, request.fixtureCase);

  if (!request.force && (await fileSystem.exists(htmlPath))) {
    throw new FixtureCaptureRefusedError(
      `${htmlPath} already exists. Review the stored fixture first and pass --force to replace it.`,
    );
  }

  await assertRobotsAllows({
    url,
    platform: request.platform,
    userAgent,
    signal,
    fetch: dependencies.fetch ?? globalFetch,
    log,
  });

  log(`Retrieving ${url} as ${userAgent}`);

  const captured = await retrieveOnce({
    url,
    platform: request.platform,
    userAgent,
    signal,
    launcher: dependencies.launcher,
  });
  const sanitized = sanitizeFixtureHtml(captured.html);
  const metadata: FixtureCaptureMetadata = {
    platform: request.platform,
    case: request.fixtureCase,
    capturedAt: now().toISOString(),
    pageNumber: request.pageNumber,
    requestUrl: url,
    finalUrl: captured.finalUrl,
    httpStatus: captured.status,
    userAgent,
    bytes: { raw: captured.html.length, sanitized: sanitized.html.length },
    sanitization: sanitized.report,
  };

  await fileSystem.ensureDirectory(fixtureDir);
  await fileSystem.write(htmlPath, sanitized.html);
  await fileSystem.write(metadataPath, formatFixtureMetadata(metadata));

  log(
    `Wrote ${path.basename(htmlPath)} (${String(sanitized.html.length)} bytes) and ${path.basename(metadataPath)}`,
  );
  log(
    `Removed ${String(sanitized.report.scriptsRemoved)} script, ${String(sanitized.report.stylesRemoved)} style and ${String(sanitized.report.trackingPixelsRemoved)} tracking elements; stripped parameters: ${sanitized.report.strippedParameters.join(', ') || 'none'}`,
  );

  return { htmlPath, metadataPath, metadata };
}

/** The contact detail of 14.5, read from the environment file. */
function contactDetail(env: Readonly<Record<string, string | undefined>>): string {
  const contact = env[USER_AGENT_CONTACT_VARIABLE];

  if (contact === undefined || contact.trim().length === 0) {
    throw new FixtureCaptureRefusedError(
      `${USER_AGENT_CONTACT_VARIABLE} is not set. Every Platform request carries a reachable contact detail (Requirement 14.5), so the capture sends none without it.`,
    );
  }

  return contact;
}

/** Arguments of the robots.txt gate. */
interface RobotsGateOptions {
  readonly url: string;
  readonly platform: Platform;
  readonly userAgent: string;
  readonly signal: AbortSignal;
  readonly fetch: RobotsFetch;
  readonly log: (message: string) => void;
}

/**
 * Evaluates the robots.txt of the Platform before the single page request (14.1).
 *
 * @throws A {@link FixtureCaptureRefusedError} when the robots.txt forbids the path (14.2) or cannot
 *   be evaluated (14.3). The capture has no Platform_Status to report, so the refusal carries the
 *   status the Scraper_Service would have reported, which keeps the reason recognisable.
 */
async function assertRobotsAllows(options: RobotsGateOptions): Promise<void> {
  const target = new URL(options.url);
  const decision = await evaluateRobots({
    origin: target.origin,
    intendedPaths: [`${target.pathname}${target.search}`],
    userAgent: options.userAgent,
    signal: options.signal,
    fetch: options.fetch,
  });
  const status = robotsPlatformStatus(decision);

  if (status !== null) {
    throw new FixtureCaptureRefusedError(
      `The robots.txt of ${options.platform} does not permit this capture (${status}).`,
    );
  }

  options.log(
    `robots.txt permits ${target.pathname}${target.search}; crawl delay: ${decision.crawlDelaySeconds === null ? 'none stated' : `${String(decision.crawlDelaySeconds)} s`}`,
  );
}

/** Arguments of the single retrieval. */
interface RetrieveOnceOptions {
  readonly url: string;
  readonly platform: Platform;
  readonly userAgent: string;
  readonly signal: AbortSignal;
  readonly launcher: RuntimeBrowserType | undefined;
}

/** What the single retrieval yielded. */
interface CapturedPage {
  readonly html: string;
  readonly finalUrl: string;
  readonly status: number | null;
}

/**
 * Performs the one page retrieval through the production runtime, which closes the page, the context
 * and the browser again in its own `finally` block (8.4).
 */
async function retrieveOnce(options: RetrieveOnceOptions): Promise<CapturedPage> {
  return withScrapeRunBrowser(
    { userAgent: options.userAgent, signal: options.signal, launcher: options.launcher },
    async (browser) => {
      const context = await browser.contextFor({ platform: options.platform });
      const page = singleRetrievalPage(await context.openPage());
      const response = await page.load(options.url);

      return { html: await page.html(), finalUrl: response.url, status: response.status };
    },
  );
}

/** The global `fetch` as the robots.txt retrieval port. */
const globalFetch: RobotsFetch = (url, init) => fetch(url, init);
