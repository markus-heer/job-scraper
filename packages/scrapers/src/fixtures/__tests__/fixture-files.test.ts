import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InvalidFixtureCaseError,
  listFixtureCases,
  readFixture,
  readFixtureHtml,
} from '../fixture-files.js';
import {
  fixtureCapturedAt,
  type FixtureCaptureMetadata,
  formatFixtureMetadata,
  InvalidFixtureMetadataError,
  parseFixtureMetadata,
} from '../fixture-metadata.js';

const HTML = '<ol class="results"><li data-posting-id="1">Projektmanagerin</li></ol>';

const METADATA: FixtureCaptureMetadata = {
  platform: 'STEPSTONE',
  case: 'result-list-page-1',
  capturedAt: '2026-01-15T10:30:00.000Z',
  pageNumber: 1,
  requestUrl: 'https://www.stepstone.de/jobs?page=1',
  finalUrl: 'https://www.stepstone.de/jobs?page=1',
  httpStatus: 200,
  userAgent: 'JobTool/0.1 (private use; contact: job.tool@example.com)',
  bytes: { raw: 200, sanitized: 120 },
  sanitization: {
    scriptsRemoved: 1,
    stylesRemoved: 0,
    trackingPixelsRemoved: 0,
    strippedParameters: ['sessionId'],
  },
};

let fixtureDir: string;

beforeEach(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'job-scraper-fixtures-'));
});

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('readFixture', () => {
  it('reads a captured document together with its sidecar', async () => {
    await writeFile(path.join(fixtureDir, 'result-list-page-1.html'), HTML, 'utf8');
    await writeFile(
      path.join(fixtureDir, 'result-list-page-1.capture.json'),
      formatFixtureMetadata(METADATA),
      'utf8',
    );

    const fixture = await readFixture({
      platform: 'STEPSTONE',
      fixtureCase: 'result-list-page-1',
      fixtureDir,
    });

    expect(fixture.html).toBe(HTML);
    expect(fixture.metadata?.capturedAt).toBe(METADATA.capturedAt);
    expect(fixtureCapturedAt(METADATA).getUTCFullYear()).toBe(2026);
  });

  it('reads a hand-authored fixture that has no sidecar', async () => {
    await writeFile(path.join(fixtureDir, 'captcha.html'), HTML, 'utf8');

    const fixture = await readFixture({
      platform: 'STEPSTONE',
      fixtureCase: 'captcha',
      fixtureDir,
    });

    expect(fixture.metadata).toBeUndefined();
    expect(
      await readFixtureHtml({ platform: 'STEPSTONE', fixtureCase: 'captcha', fixtureDir }),
    ).toBe(HTML);
  });

  it('rejects a case name that is no kebab-case name', async () => {
    await expect(
      readFixture({ platform: 'STEPSTONE', fixtureCase: '../../etc/passwd', fixtureDir }),
    ).rejects.toBeInstanceOf(InvalidFixtureCaseError);
  });

  it('fails loudly when the fixture does not exist', async () => {
    await expect(
      readFixture({ platform: 'STEPSTONE', fixtureCase: 'relative-dates', fixtureDir }),
    ).rejects.toThrow(/ENOENT/);
  });

  it('fails loudly on a malformed sidecar instead of pretending there is none', async () => {
    await writeFile(path.join(fixtureDir, 'rate-limited.html'), HTML, 'utf8');
    await writeFile(path.join(fixtureDir, 'rate-limited.capture.json'), '{ oops', 'utf8');

    await expect(
      readFixture({ platform: 'STEPSTONE', fixtureCase: 'rate-limited', fixtureDir }),
    ).rejects.toBeInstanceOf(InvalidFixtureMetadataError);
  });
});

describe('listFixtureCases', () => {
  it('lists the captured documents of a folder, sorted, ignoring everything else', async () => {
    await writeFile(path.join(fixtureDir, 'sign-in-wall.html'), HTML, 'utf8');
    await writeFile(path.join(fixtureDir, 'captcha.html'), HTML, 'utf8');
    await writeFile(path.join(fixtureDir, 'captcha.capture.json'), '{}', 'utf8');
    await writeFile(path.join(fixtureDir, 'notes.md'), 'nichts', 'utf8');

    expect(await listFixtureCases(fixtureDir)).toEqual(['captcha', 'sign-in-wall']);
  });

  it('reports no cases for a folder that does not exist yet', async () => {
    expect(await listFixtureCases(path.join(fixtureDir, 'missing'))).toEqual([]);
  });
});

describe('fixture metadata', () => {
  it('round-trips through the sidecar format', () => {
    expect(parseFixtureMetadata(formatFixtureMetadata(METADATA))).toEqual(METADATA);
  });

  it('ends the sidecar with a newline', () => {
    expect(formatFixtureMetadata(METADATA).endsWith('\n')).toBe(true);
  });

  it('rejects a sidecar without a known Platform or without a usable date', () => {
    expect(() => parseFixtureMetadata('[]')).toThrow(InvalidFixtureMetadataError);
    expect(() => parseFixtureMetadata('{"platform":"LINKEDIN"}')).toThrow(
      /names no known Platform/,
    );
    expect(() =>
      parseFixtureMetadata('{"platform":"STEPSTONE","capturedAt":"irgendwann"}'),
    ).toThrow(/no parsable date/);
  });
});
