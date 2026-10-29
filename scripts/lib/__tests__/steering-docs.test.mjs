/**
 * The Steering_Docs of `.kiro/steering` as a lint target (16.1, 16.9).
 *
 * Two things are asserted, and the second is the reason this file exists. 16.1 asks for at least four
 * Markdown files, which is a count. 16.9 asks that a front matter block, *where* one is present, sets
 * `inclusion` to exactly one of `always`, `fileMatch`, `manual` or `auto`, and that a file without a
 * front matter block counts as always included. A wrong value is not a formatting slip: a document
 * with an `inclusion` the host does not know is a document that never loads, and nothing at runtime
 * reports that, because the Job_Tool itself never reads these files — the editor does.
 *
 * `.kiro/` is listed in `.prettierignore`, so no formatter normalizes these blocks and the parser
 * below has to cope with what a human typed. It is hand-rolled rather than a YAML dependency, because
 * the shape 16.9 describes is two or three `key: value` lines between two `---` fences. It is strict
 * in one direction on purpose: a block it cannot read is reported as malformed and never silently
 * treated as absent, since "absent" is the one state 16.9 declares acceptable and a typo must not
 * reach it.
 *
 * The real documents of this repository are driven through the same function as a handful of fixture
 * strings. The fixtures carry the cases the repository does not currently contain — above all the
 * file without a front matter block, which 16.9 names explicitly and which all five present files
 * would otherwise leave unproven.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const STEERING_DIRECTORY = fileURLToPath(new URL('../../../.kiro/steering', import.meta.url));

/** The four values 16.9 permits in the `inclusion` field, and no fifth. */
const PERMITTED_INCLUSION_VALUES = ['always', 'fileMatch', 'manual', 'auto'];

/** The count 16.1 asks for. */
const MINIMUM_STEERING_DOC_COUNT = 4;

/** The fence that opens and closes a front matter block. */
const FRONT_MATTER_FENCE = '---';

/** One `key: value` line of a front matter block. */
const FRONT_MATTER_FIELD = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/;

/**
 * The front matter block of a document, or the reason it could not be read.
 *
 * @typedef {{ state: 'absent' }
 *   | { state: 'present', fields: Record<string, string> }
 *   | { state: 'malformed', reason: string }} FrontMatter
 */

/**
 * Strips one layer of surrounding quotes from a front matter value.
 *
 * `fileMatchPattern` is written in single quotes in this repository, because its value contains
 * braces and commas.
 *
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  const trimmed = value.trim();

  for (const quote of ["'", '"']) {
    if (trimmed.length >= 2 && trimmed.startsWith(quote) && trimmed.endsWith(quote)) {
      return trimmed.slice(1, -1);
    }
  }

  return trimmed;
}

/**
 * Reads the front matter block of a Steering_Doc.
 *
 * A document that does not open with the fence has no block, which 16.9 allows. A document that opens
 * one is held to it: an unclosed block, a duplicated key or a line that is not a `key: value` pair is
 * reported as malformed, never as absent.
 *
 * @param {string} text The complete file content.
 * @returns {FrontMatter}
 */
function parseFrontMatter(text) {
  const lines = text.split(/\r?\n/);

  if (lines[0]?.trimEnd() !== FRONT_MATTER_FENCE) {
    return { state: 'absent' };
  }

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trimEnd() === FRONT_MATTER_FENCE,
  );

  if (closingIndex === -1) {
    return { state: 'malformed', reason: 'the front matter block is never closed' };
  }

  /** @type {Record<string, string>} */
  const fields = {};

  for (const line of lines.slice(1, closingIndex)) {
    if (line.trim() === '') {
      continue;
    }

    const field = FRONT_MATTER_FIELD.exec(line);

    if (field === null) {
      return {
        state: 'malformed',
        reason: `the line ${JSON.stringify(line)} is not a key: value pair`,
      };
    }

    const [, key, value] = field;

    if (key in fields) {
      return { state: 'malformed', reason: `the key ${key} is set twice` };
    }

    fields[key] = unquote(value);
  }

  return { state: 'present', fields };
}

/**
 * Every way a Steering_Doc can violate 16.9, as a sentence naming the file and the offending value.
 *
 * An empty array is a document the rule permits, which includes a document without a front matter
 * block: 16.9 counts it as always included.
 *
 * @param {string} name The file name, so a failure names the file.
 * @param {string} text The complete file content.
 * @returns {string[]}
 */
function inclusionViolations(name, text) {
  const frontMatter = parseFrontMatter(text);

  if (frontMatter.state === 'absent') {
    return [];
  }

  if (frontMatter.state === 'malformed') {
    return [`${name}: ${frontMatter.reason}`];
  }

  const { inclusion, fileMatchPattern } = frontMatter.fields;

  if (inclusion === undefined) {
    return [`${name}: the front matter block sets no inclusion field`];
  }

  if (!PERMITTED_INCLUSION_VALUES.includes(inclusion)) {
    return [
      `${name}: inclusion is ${JSON.stringify(inclusion)}, which is none of ${PERMITTED_INCLUSION_VALUES.join(', ')}`,
    ];
  }

  // Not spelled out by 16.9, but a fileMatch document without a pattern matches no file and therefore
  // never loads — the same silent outcome as an unknown inclusion value.
  if (inclusion === 'fileMatch' && (fileMatchPattern === undefined || fileMatchPattern === '')) {
    return [`${name}: inclusion is fileMatch but no fileMatchPattern is set`];
  }

  return [];
}

/** Every Markdown file of `.kiro/steering`, with its content. */
async function readSteeringDocs() {
  const entries = await readdir(STEERING_DIRECTORY, { withFileTypes: true });

  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map(async (entry) => ({
        name: entry.name,
        text: await readFile(join(STEERING_DIRECTORY, entry.name), 'utf8'),
      })),
  );
}

describe('the Steering_Docs of .kiro/steering', () => {
  it('are at least four Markdown files (16.1)', async () => {
    const docs = await readSteeringDocs();

    expect(docs.map((doc) => doc.name).length).toBeGreaterThanOrEqual(MINIMUM_STEERING_DOC_COUNT);
  });

  it('set a permitted inclusion value in every front matter block they carry (16.9)', async () => {
    const violations = (await readSteeringDocs()).flatMap((doc) =>
      inclusionViolations(doc.name, doc.text),
    );

    expect(violations).toStrictEqual([]);
  });

  it('carry a fileMatchPattern wherever the inclusion is fileMatch', async () => {
    const docs = await readSteeringDocs();
    const patterns = docs
      .map((doc) => parseFrontMatter(doc.text))
      .filter((frontMatter) => frontMatter.state === 'present')
      .filter((frontMatter) => frontMatter.fields.inclusion === 'fileMatch')
      .map((frontMatter) => frontMatter.fields.fileMatchPattern);

    // The two topic docs are scoped to the area they describe; a guard against the filter matching
    // nothing and the assertion below passing on an empty list.
    expect(patterns.length).toBeGreaterThanOrEqual(2);

    for (const pattern of patterns) {
      expect(pattern).toMatch(/\S/);
    }
  });
});

describe('the inclusion rule of 16.9', () => {
  it('accepts a file without a front matter block, which counts as always included', () => {
    expect(parseFrontMatter('# A doc\n\nNo front matter here.\n').state).toBe('absent');
    expect(inclusionViolations('no-front-matter.md', '# A doc\n\nText.\n')).toStrictEqual([]);
    expect(inclusionViolations('empty.md', '')).toStrictEqual([]);
  });

  it('accepts each of the four permitted values', () => {
    for (const value of PERMITTED_INCLUSION_VALUES) {
      const pattern = value === 'fileMatch' ? "\nfileMatchPattern: 'apps/**'" : '';

      expect(
        inclusionViolations(`${value}.md`, `---\ninclusion: ${value}${pattern}\n---\n# A doc\n`),
      ).toStrictEqual([]);
    }
  });

  it('names the file and the value when the inclusion is not one of the four', () => {
    const [violation] = inclusionViolations(
      'wrong-value.md',
      '---\ninclusion: sometimes\n---\n# A doc\n',
    );

    expect(violation).toContain('wrong-value.md');
    expect(violation).toContain('"sometimes"');
    expect(violation).toContain('always');
  });

  it('names a front matter block that sets no inclusion field at all', () => {
    const [violation] = inclusionViolations('no-field.md', '---\ntitle: A doc\n---\n# A doc\n');

    expect(violation).toContain('no-field.md');
    expect(violation).toContain('no inclusion field');
  });

  it('names a fileMatch document that would match nothing', () => {
    const [violation] = inclusionViolations(
      'no-pattern.md',
      '---\ninclusion: fileMatch\n---\n# A doc\n',
    );

    expect(violation).toContain('no-pattern.md');
    expect(violation).toContain('fileMatchPattern');
  });

  it('reports a block it cannot read instead of treating it as absent', () => {
    // Each of these would pass as "no front matter" under a lenient parser, and that is exactly the
    // mistake to avoid: absence is permitted, so a typo must not be read as absence.
    const unclosed = inclusionViolations('unclosed.md', '---\ninclusion: always\n# A doc\n');
    const notAPair = inclusionViolations('not-a-pair.md', '---\ninclusion always\n---\n# A doc\n');
    const twice = inclusionViolations(
      'twice.md',
      '---\ninclusion: always\ninclusion: manual\n---\n# A doc\n',
    );

    expect(unclosed[0]).toContain('never closed');
    expect(notAPair[0]).toContain('not a key: value pair');
    expect(twice[0]).toContain('set twice');
  });

  it('reads a quoted value as its content, the way the two fileMatch docs write it', () => {
    const frontMatter = parseFrontMatter(
      "---\ninclusion: fileMatch\nfileMatchPattern: '{packages/scrapers/**,apps/api/**}'\n---\n",
    );

    expect(frontMatter).toStrictEqual({
      state: 'present',
      fields: {
        inclusion: 'fileMatch',
        fileMatchPattern: '{packages/scrapers/**,apps/api/**}',
      },
    });
  });
});
