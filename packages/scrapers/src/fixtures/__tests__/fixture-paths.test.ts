import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  fixtureCaseFromFileName,
  fixtureHtmlPath,
  fixtureMetadataPath,
  isFixtureCaseName,
  missingFixtureCases,
  parsePlatformName,
  platformFixtureDir,
  REQUIRED_FIXTURE_CASES,
  scrapersPackageRoot,
} from '../fixture-paths.js';

describe('parsePlatformName', () => {
  it('accepts the lowercase CLI spelling of every Platform', () => {
    expect(parsePlatformName('stepstone')).toBe('STEPSTONE');
    expect(parsePlatformName('Jobvector')).toBe('JOBVECTOR');
    expect(parsePlatformName(' INDEED ')).toBe('INDEED');
  });

  it('rejects anything that is no Platform', () => {
    expect(parsePlatformName('linkedin')).toBeUndefined();
    expect(parsePlatformName('')).toBeUndefined();
  });
});

describe('isFixtureCaseName', () => {
  it('accepts the required case names', () => {
    for (const fixtureCase of REQUIRED_FIXTURE_CASES) {
      expect(isFixtureCaseName(fixtureCase)).toBe(true);
    }
  });

  it('rejects names that could leave the fixture folder', () => {
    expect(isFixtureCaseName('../../../etc/passwd')).toBe(false);
    expect(isFixtureCaseName('page.1')).toBe(false);
    expect(isFixtureCaseName('Page-1')).toBe(false);
    expect(isFixtureCaseName('')).toBe(false);
  });
});

describe('platformFixtureDir', () => {
  it('places the fixtures next to the Platform_Adapter that parses them', () => {
    const dir = platformFixtureDir('STEPSTONE', '/repo/packages/scrapers');

    expect(dir).toBe(path.join('/repo/packages/scrapers/src/adapters/stepstone/__fixtures__'));
  });

  it('resolves against this package by default', () => {
    expect(platformFixtureDir('JOBVECTOR')).toBe(
      path.join(scrapersPackageRoot(), 'src/adapters/jobvector/__fixtures__'),
    );
  });
});

describe('fixture file names', () => {
  it('pairs a captured document with its sidecar', () => {
    expect(fixtureHtmlPath('/f', 'result-list-page-1')).toBe('/f/result-list-page-1.html');
    expect(fixtureMetadataPath('/f', 'result-list-page-1')).toBe(
      '/f/result-list-page-1.capture.json',
    );
  });

  it('reads the case back from a captured document and ignores every other file', () => {
    expect(fixtureCaseFromFileName('sign-in-wall.html')).toBe('sign-in-wall');
    expect(fixtureCaseFromFileName('sign-in-wall.capture.json')).toBeUndefined();
    expect(fixtureCaseFromFileName('README.md')).toBeUndefined();
  });
});

describe('missingFixtureCases', () => {
  it('names every required case a folder does not have yet', () => {
    expect(missingFixtureCases(['result-list-page-1', 'captcha'])).toEqual([
      'result-list-page-2',
      'result-list-empty',
      'layout-changed',
      'sign-in-wall',
      'rate-limited',
      'relative-dates',
    ]);
  });

  it('reports nothing missing once every case is present', () => {
    expect(missingFixtureCases([...REQUIRED_FIXTURE_CASES, 'extra-case'])).toEqual([]);
  });
});
