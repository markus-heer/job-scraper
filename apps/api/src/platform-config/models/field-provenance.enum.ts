import type { FieldProvenance } from '@job-scraper/domain';
import { registerEnumType } from '@nestjs/graphql';

import { toEnumRef } from '../../graphql/domain-enums';

/**
 * The two sources a resolved Criterion_Field value can come from (5.2, 5.3, 4.12).
 *
 * `satisfies readonly FieldProvenance[]` is what ties this tuple to the Profile_Resolver: that
 * module declares `FieldProvenance` as a union rather than as a tuple, so a value published here
 * that the resolution cannot produce fails `pnpm check-types`. The exhaustiveness of the other
 * direction — a provenance the resolution produces and this list omits — is asserted in the test
 * next to this file.
 *
 * Not part of `../../graphql/domain-enums.ts`: this is not one of the nine stored vocabularies and
 * no column holds it. It is a statement about where a *resolved* value came from, and 4.12 asks the
 * Web_App to render it as exactly one of two German labels — "aus Standardprofil" or
 * "überschrieben", which are strings the Web_App owns.
 *
 * Requirements: 4.12, 5.2, 5.3.
 */
export const FIELD_PROVENANCES = [
  'DEFAULT',
  'OVERRIDE',
] as const satisfies readonly FieldProvenance[];

/** The provenance of one resolved Criterion_Field, as a GraphQL enum (4.12). */
export const FieldProvenanceEnumRef = toEnumRef(FIELD_PROVENANCES);

registerEnumType(FieldProvenanceEnumRef, {
  name: 'FieldProvenance',
  description:
    'Which source supplied the value of a resolved Criterion_Field: the Default_Search_Profile or the Platform_Override of that Platform.',
});
