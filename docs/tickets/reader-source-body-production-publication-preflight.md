# source-body migration needs a production publication preflight

status: open
origin: 2026-09-27 source-note integration review
area: reader / production migration

`0245_reader_source_bodies.py` enriches stored apparatus bodies through
`replace_reader_publication(..., issues=PreserveSourceIssues())`. that operation
requires an existing publication, but the schema has no constraint requiring an
apparatus media to have one. the migration now counts missing publications and
fails before adding its column, with up to ten affected media ids. a read-only
production query on 2026-09-27 at revision 0241 found 21 distinct apparatus
media and zero without a publication. repeat the count under the stopped-writer
release fence; this observation can drift before cutover.

prerequisite: production is at revision `0244` after the shared note-link
migration; coordinate a read-only check before applying `0245`. if the count
is nonzero, inspect each media and repair
its publication or stale apparatus under the existing publication contract.
do not bypass the migration guard or discard source issues.

acceptance: a recorded production count is zero, then `0245` completes and a
post-upgrade check confirms the source-issue lists and publication generations
for enriched media. delete this ticket after the evidence is recorded.
