import { Module } from '@nestjs/common';

import { ScrapeRunModule } from '../scrape-run/scrape-run.module';
import { PostingModule } from './posting.module';
import { PostingReadContextFactory } from './posting-read.context';
import { PostingReadResolver } from './posting-read.resolver';
import { PostingReadService } from './posting-read.service';

/**
 * The read layer of the posting overview: `jobPostings`, `jobPosting` and the three resolved fields
 * of a Job_Posting (10.1 to 10.9, 11.2).
 *
 * A module of its own rather than three more providers in `PostingModule`, and the reason is a
 * module cycle. The read layer needs `ScrapeRunReadService` for the reference run of the "neu"
 * marking, so it has to import `ScrapeRunModule`; that module imports `RelevanceModule` and
 * `ScraperModule`, and both of them import `PostingModule` for the single write path into the
 * Posting_Store. `PostingModule` importing `ScrapeRunModule` would therefore close the cycle
 * `PostingModule → ScrapeRunModule → RelevanceModule → PostingModule`, which Nest can only resolve
 * with `forwardRef` on both sides.
 *
 * Importing both modules from a third one keeps every existing edge pointing the same way: the write
 * path knows nothing about a Scrape_Run beyond the identifier it is handed, and the read layer sits
 * above both. It is also the split the concurrent tasks of this phase need — the mutations of a
 * Job_Posting stay in `PostingModule` and its reads are here, so the two are never edited in one
 * file.
 *
 * Nothing is exported: a resolver is a leaf of the object graph, and the two providers behind it
 * exist for this one request path.
 */
@Module({
  imports: [PostingModule, ScrapeRunModule],
  providers: [PostingReadService, PostingReadContextFactory, PostingReadResolver],
})
export class PostingReadModule {}
