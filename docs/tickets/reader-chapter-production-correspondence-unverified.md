# production reader-section cutover remains unproved

status: open
origin: 2026-09-26 chapter implementation; 2026-09-27 processing release
preflight and owner approval for a combined cutover
area: production reader migration / selected epub repair

the read-only proxy-jump route now works. production is at alembic `0241`.
each of the [four council source hashes](../reader-chapter-detection-council.md#what-the-four-editions-show)
matches exactly one ready epub `media_file` row with source metadata, publication
generation 2, fragments and matching `epub_fragment_sources` counts: 79, 23,
25 and 1,334. each has a saved reader cursor; the first has 14 highlights and
the fourth has one. persisted toc/section counts are 596/149, 24/567, 50/86
and 119/241. the first toc count includes page-list and landmark entries.
production has 239 ready epubs and 243 ready articles. object-byte hashes,
fragment ordering, and client-held pending offline progress were not verified.

schema `0243` backfills toc resolution/links but does not rebuild the affected
navigation. deploying its new reader alone would serve old section metadata,
contrary to the [cutover plan](../reader-chapter-detection-plan.md#safe-repair-and-hard-cutover).
the owner approved including the chapter cutover in the processing release, subject
to its production gates. a live object-byte probe stopped
after [one api restart](live-api-source-hash-probe-restarted-container.md).

prerequisites: prove exact retained object/fragment correspondence using a bounded
off-host or isolated restored rehearsal; inspect the four repairs with
`reader_navigation_repair`, inventory
other affected publications and offline pending positions, and take the release
backup before a closed server/web/android cutover.

acceptance: exact production source and row correspondence, restored rehearsal,
fenced repair of every mandatory affected publication, retained fragments,
annotations and cursors, v4 hosted/offline navigation, and no lost pending
progress are observed on the deployed artifact.
