/**
 * Per-request state of a GraphQL request, keyed on the request's own context object.
 *
 * Two things in the read layer have to be computed once per request and shared by every field
 * resolver of that request, and both would be wrong if they were computed per row:
 *
 * - **The reference run of the "neu" marking (11.2).** The grouping of a page and the marking of its
 *   rows are derived from the same identifier, so resolving it twice would let a page's grouping
 *   disagree with its rows' labels — and resolving it per row would be 25 queries for one answer
 *   that cannot change inside one request.
 * - **The two batched edges.** `JobPosting.firstSeenRun` and `ScrapeRun.platformResults` are loaded
 *   through DataLoader, and a DataLoader only batches what it is asked within its own lifetime. One
 *   that outlived the request would also cache stored rows across requests, which is a stale answer
 *   rather than an optimization.
 *
 * The mechanism is a `WeakMap` keyed on the object Apollo creates per request and passes to every
 * resolver of that request as its GraphQL context. Three properties make it the right key: it is the
 * same object for every field of one request, it is a different object for the next request, and it
 * becomes unreachable when the request is answered — so the entry is collected without anything
 * having to release it.
 *
 * Nest's request-scoped providers would express the same thing, at the price of making every
 * resolver that touches one of them request-scoped as well. This stays a singleton and keeps the
 * per-request part explicit: a reader sees which values live for one request and which do not.
 */

/** The GraphQL context object of one request; used as an identity, never read. */
export type RequestKey = object;

/**
 * A value that exists once per GraphQL request.
 *
 * @typeParam TValue The per-request state; created on first use within a request.
 */
export class RequestCache<TValue> {
  private readonly values = new WeakMap<RequestKey, TValue>();

  /** @param create Builds the per-request state. Called at most once per request. */
  constructor(private readonly create: () => TValue) {}

  /**
   * The state of this request, created on the first call and reused afterwards.
   *
   * @param key The GraphQL context object of the request.
   */
  for(key: RequestKey): TValue {
    const existing = this.values.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const created = this.create();

    this.values.set(key, created);

    return created;
  }
}
