import type {
  JobPostingSortField,
  JobPostingSortInput,
  SortDirection,
} from '../../graphql/schema.generated';

/**
 * The sorting the user has chosen, and how it reaches the `jobPostings` query (10.7, 11.3).
 *
 * Separate from the component that renders it because two parties need it: `SortSelect` reads and
 * writes it, and the page read of task 17.5 turns it into the `sort` variable. Both work with the
 * generated enums of `src/graphql/schema.generated.ts` — the authority for the four sort keys and
 * the two directions is the published schema, so this module declares neither value list.
 */

/** The sort key and the direction in force, exactly the pair 10.7 lets the user pick. */
export interface PostingSortSelection {
  readonly field: JobPostingSortField;
  readonly direction: SortDirection;
}

/**
 * The sorting in force before the user picks one: recording time descending (10.7).
 *
 * The same pair as `DEFAULT_POSTING_SORT` in `apps/api/src/posting/posting-page-query.ts`, and the
 * duplication is unavoidable rather than careless: the API_Service applies that default when the
 * `sort` variable is absent, while the two `select` elements need a value to be *preselected* with,
 * and a selection of "nothing" is not one of the options 10.7 offers. The pair is two enum values,
 * both checked against the generated enums, so a change of the published default is a change of one
 * literal here.
 */
export const DEFAULT_POSTING_SORT_SELECTION: PostingSortSelection = {
  field: 'FIRST_SEEN_AT',
  direction: 'DESC',
};

/**
 * The selection as the `sort` variable of the `jobPostings` query.
 *
 * Always sent, including when it equals the default, which is what makes the default grouping of
 * 11.3 survive: the API_Service reads an explicit `FIRST_SEEN_AT` / `DESC` as "the user chose no
 * deviating sorting" and still places the Job_Posting marked "neu" above the unmarked ones (see
 * `newFirstGroupingFor` in `apps/api/src/posting/new-marking.ts`). Omitting the variable while the
 * selection happens to be the default would behave identically and would need a second rule here to
 * decide when to omit it, so there is one path instead of two.
 */
export const sortInputOf = (selection: PostingSortSelection): JobPostingSortInput => ({
  field: selection.field,
  direction: selection.direction,
});
