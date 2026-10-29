import path from 'node:path';

import { PLATFORM_CAPABILITIES } from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import type { AdapterPage } from '../../adapter/types.js';
import type { AdapterRegistry, PlatformAdapterFor } from '../../registry.js';
import type { RobotsFetch } from '../../robots/robots.js';
import { FakeBrowserType } from '../../runtime/__tests__/fake-playwright.js';
import { buildUserAgent } from '../../runtime/user-agent.js';
import {
  captureUrl,
  type FixtureCaptureDependencies,
  FixtureCaptureNotPermittedError,
  FixtureCaptureRefusedError,
  FixtureCaptureSecondRetrievalError,
  FixtureCaptureUsageError,
  type FixtureFileSystem,
  parseCaptureArguments,
  runFixtureCapture,
  singleRetrievalPage,
} from '../capture.js';
import { parseFixtureMetadata } from '../fixture-metadata.js';

const CONTACT = 'job.tool@example.com';

const USER_AGENT = buildUserAgent(CONTACT);

const RESULT_LIST_URL = 'https://www.stepstone.de/jobs/projektmanagerin?page=1';

const CAPTURED_HTML = `<html lang="de"><head><script>track()</script></head><body>
<ol class="results"><li><a href="/job--12345.html?sessionId=abc123def456ghi789">Projektmanagerin</a></li></ol>
</body></html>`;

const CAPTURE_TIME = new Date('2026-01-15T10:30:00.000Z');

/** An environment that is neither a test runner nor CI, which is what the capture insists on. */
const MANUAL_ENV = { USER_AGENT_CONTACT: CONTACT } as const;

/** A robots.txt that permits everything. */
const allowAll: RobotsFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => 'User-agent: *\nAllow: /\n',
});

/** A robots.txt that forbids everything (14.2). */
const disallowAll: RobotsFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => 'User-agent: *\nDisallow: /\n',
});

/** A filesystem in memory, so no test writes into the source tree. */
function memoryFileSystem(initial: Readonly<Record<string, string>> = {}): {
  files: Map<string, string>;
  directories: string[];
  fileSystem: FixtureFileSystem;
} {
  const files = new Map<string, string>(Object.entries(initial));
  const directories: string[] = [];

  return {
    files,
    directories,
    fileSystem: {
      ensureDirectory: async (dir) => {
        directories.push(dir);
      },
      exists: async (file) => files.has(file),
      write: async (file, content) => {
        files.set(file, content);
      },
    },
  };
}

/** A capture against a fake browser and a fake robots.txt, writing into memory. */
function captureDependencies(
  overrides: Partial<FixtureCaptureDependencies> = {},
  behaviourHtml: string = CAPTURED_HTML,
) {
  const launcher = new FakeBrowserType({
    html: behaviourHtml,
    navigate: () => ({ kind: 'RESPONSE', status: 200, headers: { 'Content-Type': 'text/html' } }),
  });
  const memory = memoryFileSystem();
  const logs: string[] = [];

  return {
    launcher,
    memory,
    logs,
    dependencies: {
      argv: ['--platform', 'stepstone', '--url', RESULT_LIST_URL, '--out', '/tmp/fixtures'],
      env: MANUAL_ENV,
      fileSystem: memory.fileSystem,
      launcher,
      fetch: allowAll,
      now: () => CAPTURE_TIME,
      log: (message: string) => logs.push(message),
      ...overrides,
    } satisfies FixtureCaptureDependencies,
  };
}

describe('parseCaptureArguments', () => {
  it('defaults the case to the first Result_Page and the page number to 1', () => {
    expect(parseCaptureArguments(['--platform', 'stepstone'])).toEqual({
      platform: 'STEPSTONE',
      fixtureCase: 'result-list-page-1',
      pageNumber: 1,
      url: undefined,
      outputDir: undefined,
      force: false,
    });
  });

  it('reads every flag', () => {
    expect(
      parseCaptureArguments([
        '--platform',
        'jobvector',
        '--case',
        'sign-in-wall',
        '--page',
        '3',
        '--url',
        'https://www.jobvector.de/jobs',
        '--out',
        '/tmp/f',
        '--force',
      ]),
    ).toEqual({
      platform: 'JOBVECTOR',
      fixtureCase: 'sign-in-wall',
      pageNumber: 3,
      url: 'https://www.jobvector.de/jobs',
      outputDir: '/tmp/f',
      force: true,
    });
  });

  it('rejects a missing Platform, an unknown Platform and an unknown flag', () => {
    expect(() => parseCaptureArguments([])).toThrow(FixtureCaptureUsageError);
    expect(() => parseCaptureArguments(['--platform', 'linkedin'])).toThrow(
      FixtureCaptureUsageError,
    );
    expect(() => parseCaptureArguments(['--platform', 'stepstone', '--all'])).toThrow(
      FixtureCaptureUsageError,
    );
  });

  it('rejects a case name that could leave the fixture folder and a non-numeric page', () => {
    expect(() =>
      parseCaptureArguments(['--platform', 'stepstone', '--case', '../secrets']),
    ).toThrow(FixtureCaptureUsageError);
    expect(() => parseCaptureArguments(['--platform', 'stepstone', '--page', 'zwei'])).toThrow(
      FixtureCaptureUsageError,
    );
  });

  it('rejects a flag without its value', () => {
    expect(() => parseCaptureArguments(['--platform'])).toThrow(FixtureCaptureUsageError);
  });
});

describe('captureUrl', () => {
  const stepstone: PlatformAdapterFor<'STEPSTONE'> = {
    capability: PLATFORM_CAPABILITIES.STEPSTONE,
    resultListUrl: (profile, pageNumber) =>
      `https://www.stepstone.de/jobs?criteria=${String(profile.criteria.length)}&page=${String(pageNumber)}`,
    fetch: async () => {
      throw new Error('The capture never calls the adapter.');
    },
  };
  const registry: AdapterRegistry = { STEPSTONE: stepstone };

  it('builds the result list URL from the effective Search_Profile of that Platform', () => {
    const url = captureUrl(
      parseCaptureArguments(['--platform', 'stepstone', '--page', '2']),
      registry,
    );

    expect(url).toMatch(/^https:\/\/www\.stepstone\.de\/jobs\?criteria=\d+&page=2$/);
  });

  it('prefers an explicit --url', () => {
    expect(
      captureUrl(
        parseCaptureArguments(['--platform', 'stepstone', '--url', 'https://example.com/x']),
        registry,
      ),
    ).toBe('https://example.com/x');
  });

  it('asks for --url while a Platform has no adapter yet', () => {
    expect(() => captureUrl(parseCaptureArguments(['--platform', 'indeed']), registry)).toThrow(
      /--url/,
    );
  });
});

describe('singleRetrievalPage', () => {
  it('permits exactly one Result_Page retrieval', async () => {
    const loads: string[] = [];
    const page: AdapterPage = {
      load: async (url) => {
        loads.push(url);

        return { url, status: 200, headers: {} };
      },
      html: async () => CAPTURED_HTML,
      close: async () => undefined,
    };
    const guarded = singleRetrievalPage(page);

    await guarded.load(RESULT_LIST_URL);

    await expect(guarded.load(RESULT_LIST_URL)).rejects.toBeInstanceOf(
      FixtureCaptureSecondRetrievalError,
    );
    expect(loads).toEqual([RESULT_LIST_URL]);
  });
});

describe('runFixtureCapture', () => {
  it('performs exactly one retrieval with the production user agent and writes the fixture', async () => {
    const { dependencies, launcher, memory } = captureDependencies();

    const outcome = await runFixtureCapture(dependencies);

    expect(launcher.recorder.navigations).toEqual([
      { url: RESULT_LIST_URL, timeout: 30_000, waitUntil: 'domcontentloaded' },
    ]);
    expect(launcher.recorder.contextOptions[0]?.userAgent).toBe(USER_AGENT);
    expect(launcher.recorder.browserCloseCount).toBe(1);
    expect(outcome.htmlPath).toBe(path.join('/tmp/fixtures/result-list-page-1.html'));
    expect(memory.directories).toEqual(['/tmp/fixtures']);
    expect([...memory.files.keys()].sort()).toEqual([
      '/tmp/fixtures/result-list-page-1.capture.json',
      '/tmp/fixtures/result-list-page-1.html',
    ]);
  });

  it('writes the sanitized document rather than the retrieved one', async () => {
    const { dependencies, memory } = captureDependencies();

    const outcome = await runFixtureCapture(dependencies);
    const stored = memory.files.get(outcome.htmlPath) ?? '';

    expect(stored).not.toContain('<script');
    expect(stored).not.toContain('sessionId');
    expect(stored).toContain('>Projektmanagerin</a>');
  });

  it('records the capture date, the provenance and the user agent in the sidecar', async () => {
    const { dependencies, memory } = captureDependencies();

    const outcome = await runFixtureCapture(dependencies);
    const sidecar = parseFixtureMetadata(memory.files.get(outcome.metadataPath) ?? '');

    expect(sidecar).toMatchObject({
      platform: 'STEPSTONE',
      case: 'result-list-page-1',
      capturedAt: CAPTURE_TIME.toISOString(),
      pageNumber: 1,
      requestUrl: RESULT_LIST_URL,
      finalUrl: RESULT_LIST_URL,
      httpStatus: 200,
      userAgent: USER_AGENT,
    });
    expect(sidecar.sanitization).toMatchObject({
      scriptsRemoved: 1,
      strippedParameters: ['sessionId'],
    });
    expect(sidecar.bytes.sanitized).toBeLessThan(sidecar.bytes.raw);
  });

  it('refuses to run under a test runner or in CI', async () => {
    const { dependencies } = captureDependencies({ env: { ...MANUAL_ENV, VITEST: 'true' } });

    await expect(runFixtureCapture(dependencies)).rejects.toBeInstanceOf(
      FixtureCaptureNotPermittedError,
    );
  });

  it('sends nothing without a contact detail for the user agent (14.5)', async () => {
    const { dependencies, launcher } = captureDependencies({ env: {} });

    await expect(runFixtureCapture(dependencies)).rejects.toThrow(/USER_AGENT_CONTACT/);
    expect(launcher.recorder.navigations).toEqual([]);
  });

  it('does not retrieve a page the robots.txt forbids (14.1, 14.2)', async () => {
    const { dependencies, launcher } = captureDependencies({ fetch: disallowAll });

    await expect(runFixtureCapture(dependencies)).rejects.toThrow(/EXCLUDED_BY_ROBOTS_TXT/);
    expect(launcher.recorder.navigations).toEqual([]);
  });

  it('keeps a stored fixture unless --force is given', async () => {
    const existing = { '/tmp/fixtures/result-list-page-1.html': '<html>reviewed</html>' };
    const memory = memoryFileSystem(existing);
    const { dependencies, launcher } = captureDependencies({ fileSystem: memory.fileSystem });

    await expect(runFixtureCapture(dependencies)).rejects.toBeInstanceOf(
      FixtureCaptureRefusedError,
    );
    expect(launcher.recorder.navigations).toEqual([]);
    expect(memory.files.get('/tmp/fixtures/result-list-page-1.html')).toBe(
      existing['/tmp/fixtures/result-list-page-1.html'],
    );
  });

  it('replaces a stored fixture with --force', async () => {
    const memory = memoryFileSystem({
      '/tmp/fixtures/result-list-page-1.html': '<html>old</html>',
    });
    const { dependencies } = captureDependencies({
      fileSystem: memory.fileSystem,
      argv: [
        '--platform',
        'stepstone',
        '--url',
        RESULT_LIST_URL,
        '--out',
        '/tmp/fixtures',
        '--force',
      ],
    });

    await runFixtureCapture(dependencies);

    expect(memory.files.get('/tmp/fixtures/result-list-page-1.html')).toContain('class="results"');
  });

  it('writes into the fixture folder of the Platform when no output folder is given', async () => {
    const { dependencies } = captureDependencies({
      argv: ['--platform', 'stepstone', '--url', RESULT_LIST_URL, '--case', 'captcha'],
      packageRoot: '/repo/packages/scrapers',
    });

    const outcome = await runFixtureCapture(dependencies);

    expect(outcome.htmlPath).toBe(
      path.join('/repo/packages/scrapers/src/adapters/stepstone/__fixtures__/captcha.html'),
    );
  });
});
