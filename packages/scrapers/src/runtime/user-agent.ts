/**
 * The one user agent string every outgoing Platform request carries (14.5).
 *
 * Requirement 14.5 asks for four things at once: the name of the Job_Tool, the statement of private
 * use, a contact detail read from the local environment file, and an identification *as the Job_Tool*
 * rather than an imitation of a common browser. The string is therefore assembled here, once, and the
 * two places that send it take the same value: the Playwright `BrowserContext` of a Platform
 * (`ScrapeRunBrowserOptions.userAgent` in `./browser.ts`) and the robots.txt retrieval
 * (`RobotsCacheOptions.userAgent` in `../robots/robots.ts`), both of which receive the built string
 * rather than composing one of their own. So the robots.txt request and the page requests of a
 * Platform cannot drift apart — which is exactly what Property 14 asserts.
 *
 * The string is English like the rest of the repository (16.8); the German wording of the Log_View does
 * not belong in a protocol header.
 */

/** The product token of the Job_Tool, naming the tool rather than a browser (14.5). */
export const USER_AGENT_PRODUCT = 'JobTool';

/** The product version of the token. Bumped with the tool, not with a Platform. */
export const USER_AGENT_VERSION = '0.1';

/** The private-use statement of 14.5, carried verbatim in the user agent comment. */
export const USER_AGENT_PRIVATE_USE_STATEMENT = 'private use';

/** The label the contact detail of 14.5 is announced with. */
export const USER_AGENT_CONTACT_LABEL = 'contact';

/**
 * The identification tokens of a common browser (14.5).
 *
 * The three alternatives are the ones every mainstream browser carries and the ones Property 14 reads:
 * `Mozilla/5.0` opens practically every browser user agent, and `Chrome/<version>` and
 * `Safari/<version>` are the engine tokens. A string containing none of them cannot be mistaken for a
 * browser, which is the property the requirement is after.
 */
export const BROWSER_IDENTIFICATION_PATTERN = /Mozilla\/5\.0|Chrome\/\d|Safari\/\d/;

/**
 * Characters a contact detail may not contribute to the user agent.
 *
 * Two reasons, both structural rather than cosmetic:
 *
 * - control characters (`\p{Cc}`), `\r` and `\n` among them, would let a configured value break out
 *   of the header it is placed in;
 * - `(`, `)` and `;` are the delimiters of the user agent comment itself, so a value containing them
 *   could fake a second statement — for instance a different private-use claim.
 *
 * Both classes are absent from every real contact detail (an e-mail address or a URL), so removing
 * them loses nothing a user would recognise.
 */
const RESERVED_CONTACT_CHARACTERS = /[\p{Cc}();]/gu;

/** A configured contact detail that cannot be carried in the user agent of 14.5. */
export class InvalidUserAgentContactError extends Error {
  /** The configured value, unchanged, so the startup message can name what was read. */
  readonly contact: string;

  constructor(contact: string, reason: string) {
    super(`The configured user agent contact detail ${JSON.stringify(contact)} ${reason}.`);
    this.name = 'InvalidUserAgentContactError';
    this.contact = contact;
  }
}

/**
 * Strips the reserved characters from a contact detail and collapses its whitespace.
 *
 * @returns The contact detail as it would appear in the user agent, possibly empty.
 */
export function normalizeUserAgentContact(contact: string): string {
  return contact.replace(RESERVED_CONTACT_CHARACTERS, '').replace(/\s+/g, ' ').trim();
}

/** Whether a string carries the identification of a common browser, which 14.5 forbids. */
export function containsBrowserIdentification(value: string): boolean {
  return BROWSER_IDENTIFICATION_PATTERN.test(value);
}

/**
 * Whether a configured contact detail can be carried in the user agent.
 *
 * A contact detail fails for one of two reasons: it contributes nothing once the reserved characters
 * are gone, or it would turn the Job_Tool's identification into a browser's.
 */
export function isUsableUserAgentContact(contact: string): boolean {
  const normalized = normalizeUserAgentContact(contact);

  return normalized.length > 0 && !containsBrowserIdentification(normalized);
}

/**
 * Builds the user agent of 14.5 from the contact detail of the local environment file.
 *
 * @param contact The `USER_AGENT_CONTACT` value, for example an e-mail address.
 * @returns For example `JobTool/0.1 (private use; contact: job.tool@example.com)`.
 * @throws An {@link InvalidUserAgentContactError} when the contact detail is unusable. Rejecting here
 *   rather than silently falling back keeps 14.5 intact: a Platform request without a reachable
 *   contact detail is one the operator of the Platform cannot answer, so the Job_Tool does not send
 *   it. The API_Service reports this at startup, where every other configuration fault is reported
 *   too (1.12, 1.15).
 */
export function buildUserAgent(contact: string): string {
  const normalized = normalizeUserAgentContact(contact);

  if (normalized.length === 0) {
    throw new InvalidUserAgentContactError(
      contact,
      'is empty once reserved characters are removed',
    );
  }

  if (containsBrowserIdentification(normalized)) {
    throw new InvalidUserAgentContactError(
      contact,
      'carries the identification of a common browser, which Requirement 14.5 forbids',
    );
  }

  return `${USER_AGENT_PRODUCT}/${USER_AGENT_VERSION} (${USER_AGENT_PRIVATE_USE_STATEMENT}; ${USER_AGENT_CONTACT_LABEL}: ${normalized})`;
}
