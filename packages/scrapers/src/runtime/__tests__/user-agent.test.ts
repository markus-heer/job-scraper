import { describe, expect, it } from 'vitest';

import {
  BROWSER_IDENTIFICATION_PATTERN,
  buildUserAgent,
  containsBrowserIdentification,
  InvalidUserAgentContactError,
  isUsableUserAgentContact,
  normalizeUserAgentContact,
  USER_AGENT_PRIVATE_USE_STATEMENT,
  USER_AGENT_PRODUCT,
} from '../user-agent.js';

const CONTACT = 'job.tool@example.com';

describe('buildUserAgent', () => {
  it('names the Job_Tool, states private use and carries the configured contact detail', () => {
    const userAgent = buildUserAgent(CONTACT);

    expect(userAgent).toContain(USER_AGENT_PRODUCT);
    expect(userAgent).toContain(USER_AGENT_PRIVATE_USE_STATEMENT);
    expect(userAgent).toContain(CONTACT);
    expect(userAgent).toBe('JobTool/0.1 (private use; contact: job.tool@example.com)');
  });

  it('identifies the Job_Tool rather than a common browser', () => {
    expect(BROWSER_IDENTIFICATION_PATTERN.test(buildUserAgent(CONTACT))).toBe(false);
  });

  it('is the same string for the same contact detail', () => {
    expect(buildUserAgent(CONTACT)).toBe(buildUserAgent(CONTACT));
  });

  it('drops the characters that would break out of the header or fake a second statement', () => {
    const userAgent = buildUserAgent('  job.tool\r\n@example.com (other claim); ');

    expect(userAgent).toBe('JobTool/0.1 (private use; contact: job.tool@example.com other claim)');
    expect(userAgent).not.toContain('\n');
    expect(userAgent.split('(')).toHaveLength(2);
  });

  it('rejects a contact detail that contributes nothing', () => {
    expect(() => buildUserAgent('   ')).toThrow(InvalidUserAgentContactError);
    expect(() => buildUserAgent('()')).toThrow(InvalidUserAgentContactError);
  });

  it('rejects a contact detail that would make the user agent look like a browser', () => {
    expect(() => buildUserAgent('Mozilla/5.0 fan <me@example.com>')).toThrow(
      InvalidUserAgentContactError,
    );
    expect(() => buildUserAgent('me@example.com Chrome/120')).toThrow(InvalidUserAgentContactError);
  });

  it('names the rejected value in the error', () => {
    const error = (() => {
      try {
        buildUserAgent('');

        return undefined;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(InvalidUserAgentContactError);
    expect((error as InvalidUserAgentContactError).contact).toBe('');
  });
});

describe('normalizeUserAgentContact', () => {
  it('collapses whitespace and leaves a plain contact detail untouched', () => {
    expect(normalizeUserAgentContact(CONTACT)).toBe(CONTACT);
    expect(normalizeUserAgentContact('  job tool \t  <me@example.com> ')).toBe(
      'job tool <me@example.com>',
    );
  });
});

describe('containsBrowserIdentification', () => {
  it('recognises the identification tokens of a common browser', () => {
    expect(containsBrowserIdentification('Mozilla/5.0 (Macintosh)')).toBe(true);
    expect(containsBrowserIdentification('Chrome/131.0.0.0')).toBe(true);
    expect(containsBrowserIdentification('Safari/605.1.15')).toBe(true);
    expect(containsBrowserIdentification(buildUserAgent(CONTACT))).toBe(false);
  });
});

describe('isUsableUserAgentContact', () => {
  it('agrees with buildUserAgent on every contact detail it is asked about', () => {
    for (const contact of [
      '',
      '   ',
      '()',
      'Mozilla/5.0',
      CONTACT,
      'https://example.com/contact',
    ]) {
      const usable = isUsableUserAgentContact(contact);
      let built = true;

      try {
        buildUserAgent(contact);
      } catch {
        built = false;
      }

      expect(usable).toBe(built);
    }
  });
});
