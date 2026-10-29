import { Module } from '@nestjs/common';

import { PostingRepository } from './posting.repository';
import { PostingResolver } from './posting.resolver';
import { PostingService } from './posting.service';

/**
 * The Posting_Store access layer for Job_Posting (9.2, 9.3, 9.8, 11.8) and the posting mutations
 * (10.10, 15.15).
 *
 * The repository is exported because the Scraper_Service persists through it and both enrichment
 * stages read and write through it, and all of them have to go through the same component: the field
 * groups of 9.3 — overwritten, established once, owned by the user — are only enforceable as long as
 * there is exactly one place that writes a Job_Posting. `PostingService` is exported for the same
 * reason one level up: it is where a decision about a *requested* write lives, and the resolver is
 * the only caller for now.
 *
 * `PrismaModule` is not imported: it is global, and the dependency is taken through the
 * `PrismaService` class token.
 *
 * The read layer of the posting overview is `PostingReadModule` in this same directory rather than a
 * provider list here, because it reads from `ScrapeRunModule` as well and importing that module from
 * this one would close a cycle through `RelevanceModule`; the comment there spells it out. This
 * module stays the write path and the mutations on it.
 */
@Module({
  providers: [PostingRepository, PostingService, PostingResolver],
  exports: [PostingRepository, PostingService],
})
export class PostingModule {}
