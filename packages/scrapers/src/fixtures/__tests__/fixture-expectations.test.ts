/**
 * The expectation file of a frozen fixture: its shape, its validation and reading it from disk.
 *
 * The validation is strict because the file is hand-editable and long-lived: an expectation with a
 * silently missing field would turn into a parser test that asserts less than it reads, which is
 * exactly the regression these files exist to catch.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type FixtureExpectation,
  formatFixtureExpectation,
  InvalidFixtureExpectationError,
  parseFixtureExpectation,
  readFixtureExpectation,
} from '../fixture-expectations.js';
import { InvalidFixtureCaseError } from '../fixture-files.js';
import { FIXTURE_EXPECTED_SUFFIX, fixtureExpectedPath } from '../fixture-paths.js';

const EXPECTATION: FixtureExpectation = {
  case: 'result-list-page-1',
  provenance: 'HAND_AUTHORED',
  description: 'one readable Job_Posting and a further page offered',
  pageNumber: 1,
  response: { status: 200, headers: { 'content-type': 'text/html' } },
  outcome: 'POSTINGS',
  platformStatus: 'COMPLETED',
  hasNextPage: true,
  readablePostingCount: 1,
  postings: [
    {
      postingId: '12345678',
      title: 'Projektmanagerin Pharma (m/w/d)',
      employer: 'Beispiel GmbH',
      workLocation: 'München',
      publishedAtText: 'vor 3 Tagen',
      sourceUrl: 'https://www.stepstone.de/stellenangebote--x--12345678-inline.html',
      descriptionText: null,
    },
  ],
};

/** The serialised expectation with one field replaced, for the validation cases. */
function withField(field: string, value: unknown): string {
  return JSON.stringify({ ...EXPECTATION, [field]: value });
}

let fixtureDir: string;

beforeEach(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), 'job-scraper-expectation-'));
});

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('the expectation file', () => {
  it('round-trips through its serialised form', () => {
    expect(parseFixtureExpectation(formatFixtureExpectation(EXPECTATION))).toEqual(EXPECTATION);
  });

  it('is written as pretty-printed JSON with a trailing newline, so a diff reads line by line', () => {
    const text = formatFixtureExpectation(EXPECTATION);

    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "case": "result-list-page-1",');
  });

  it('is addressed next to the document it describes', () => {
    expect(fixtureExpectedPath('/fixtures', 'captcha')).toBe(
      `/fixtures/captcha${FIXTURE_EXPECTED_SUFFIX}`,
    );
  });
});

describe('reading an expectation from disk', () => {
  it('reads the file belonging to a fixture case', async () => {
    await writeFile(
      fixtureExpectedPath(fixtureDir, 'result-list-page-1'),
      formatFixtureExpectation(EXPECTATION),
      'utf8',
    );

    const expectation = await readFixtureExpectation({
      platform: 'STEPSTONE',
      fixtureCase: 'result-list-page-1',
      fixtureDir,
    });

    expect(expectation).toEqual(EXPECTATION);
  });

  it('rejects a case name that addresses no file', async () => {
    await expect(
      readFixtureExpectation({
        platform: 'STEPSTONE',
        fixtureCase: '../../etc/passwd',
        fixtureDir,
      }),
    ).rejects.toBeInstanceOf(InvalidFixtureCaseError);
  });

  it('reports a missing expectation rather than treating it as "nothing to assert"', async () => {
    await expect(
      readFixtureExpectation({ platform: 'STEPSTONE', fixtureCase: 'captcha', fixtureDir }),
    ).rejects.toThrow(/ENOENT/u);
  });
});

describe('unusable content', () => {
  it.each([
    ['no JSON at all', '<html></html>'],
    ['a JSON array', '[]'],
    ['a case name that is no kebab-case', withField('case', 'Result List')],
    ['an unknown provenance', withField('provenance', 'GUESSED')],
    ['a page number of zero', withField('pageNumber', 0)],
    ['a response without headers', withField('response', { status: 200 })],
    ['a response status that is no integer', withField('response', { status: '200', headers: {} })],
    ['a Platform_Status the domain does not know', withField('platformStatus', 'ALMOST_DONE')],
    ['a readable count below zero', withField('readablePostingCount', -1)],
    ['postings that are no array', withField('postings', {})],
    ['a posting missing a field', withField('postings', [{ title: 'Titel' }])],
    [
      'a posting field that is neither string nor null',
      withField('postings', [{ ...EXPECTATION.postings[0], employer: 7 }]),
    ],
  ])('is rejected: %s', (_reason, text) => {
    expect(() => parseFixtureExpectation(text)).toThrow(InvalidFixtureExpectationError);
  });

  it('names what is wrong, so a hand-edited file is repairable from the message', () => {
    expect(() => parseFixtureExpectation(withField('platformStatus', 'ALMOST_DONE'))).toThrow(
      /platformStatus/u,
    );
  });
});
