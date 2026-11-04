# creator sort orders episodes by an author their rows no longer show

problem: a library sorted `Creator A–Z` or `Creator Z–A` keys every row on `mc.primary_name`, the
lowest-ordinal credit's display name. for an episode that is the show's author, which ingest copies
onto each episode (`"author_names": episode.authors or show_authors`). since playback-bar lane 3, an
episode row's byline slot shows its show's title instead, so episodes sort by a name the row no
longer displays.

evidence: `python/nexus/services/library_listing.py:51-52` (`creator_asc`/`creator_desc` over
`creator_name`), `:114,117` (`creator_name = "mc.primary_name"` from `primary_creator_rows_sql`),
`python/nexus/services/contributor_credits.py:109-122`, `python/nexus/services/podcasts/ingest.py`
(`author_names`). the sort is offered at `apps/web/src/lib/libraries/views.tsx:30-31`.
`apps/web/src/lib/media/mediaByline.ts` (`mediaByline`) puts `summary.show.title` in that
slot for every episode.

impact: in a mixed library sorted by creator, episode rows read out of alphabetical order by their
visible byline: `The Long Room` (author Ada Marsh) sorts among the a's. books and articles are
unaffected. a show with no credited author sorts as missing, last, though its row names the show.

resolved when: the owner decides whether an episode's creator sort key is its show title. if so, a
mixed library sorted `Creator A–Z` reads alphabetical by visible byline, across books and episodes,
in a lab case; if not, the sort's label or this record says why it keys on a hidden name.
