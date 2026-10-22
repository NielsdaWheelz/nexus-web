# podcast default-library filter returns no shows

problem: the podcast library filter offers the default all library, but its
server scope predicate excludes default libraries. selecting that option shows
an empty collection even when all contains followed episodes.

evidence: `apps/web/src/app/(authenticated)/podcasts/PodcastsPaneBody.tsx`
maps every member library into choices; `python/nexus/services/library_entries.py`
`podcast_ids_in_libraries_for_viewer` excludes `is_default` libraries. source-derived;
no live reproduction. this predates the collection-loading cutover.

resolved when: the owner defines all-library scope for followed shows, then the
picker and endpoint agree; verify a followed show with an episode in all.
