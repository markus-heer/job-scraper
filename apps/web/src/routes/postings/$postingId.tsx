import { createFileRoute } from '@tanstack/react-router';

import { PostingDetail } from '../../components/PostingDetail';

/**
 * The detail view of one Job_Posting at `/postings/$postingId` (10.8, 10.15).
 *
 * A route with one job: read the path parameter and hand it to `PostingDetail`. The view itself —
 * the `jobPosting` query, the description text, the German hint of 10.15 and the labelled source
 * link — lives in `src/components/PostingDetail`, because a `.graphql` operation file cannot sit
 * under `src/routes/`: the TanStack Router generator reads this directory as the route tree, so an
 * operation placed here would be read as a route.
 *
 * The identifier is in the path rather than in a search parameter, so the opened Job_Posting is
 * linkable and reloadable — the same reason the Log_View of 12.9 is a route. An identifier that no
 * longer resolves is a normal state of such a link and is answered with a German hint rather than
 * with a failure; `PostingDetail` holds that distinction.
 *
 * Requirements: 10.8, 10.15.
 */
export const Route = createFileRoute('/postings/$postingId')({
  component: PostingDetailPage,
});

function PostingDetailPage() {
  const { postingId } = Route.useParams();

  return <PostingDetail postingId={postingId} />;
}
