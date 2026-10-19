# production reader-section cutover remains unproved

status: open
origin: 2026-09-26 chapter implementation; 2026-09-27 combined-release rehearsal
area: production reader migration / selected epub repair

the last production preflight found alembic `0241`, 239 ready epubs and 243 ready
articles. all 239 retained epub objects passed size and sha256 checks against
`media_file` in an isolated restored clone. old-code inspect classified them as
155 changed, 57 unchanged and 27 failed: 17 source text/href, seven source-only
anchor names, one old apparatus body, and two bounded backlink counts. private
receipt: `/tmp/nexus-chapter-rehearsal.nx22kQ/census/receipts.jsonl` (0600).

schema `0243` backfills toc resolution/links but does not rebuild affected
navigation. the restored clone reproduced and resolved its deferred-trigger
migration failure. candidate `704fdfc683989be822dda614838fdeb0234c06aa`
inspected and applied the four mandatory editions on that clone. its montaigne
result exposed 161 newly added exact apparatus body/locator byte differences.
`6eeea8989bf10c0e336f0193e42d6d95c197ad87` removes nine real source/body
drifts; of the remaining 152, 78 match after ordinary whitespace normalization
and 74 need a stricter token check. an independent exact-source probe found all
152 preserve ordered word tokens and labels; they differ only in canonical block
spacing. fragment/state hashes and expected content tuples remain
to be checked. separate tickets track the remaining corpus classes.

prerequisites: finish exact four-book tuples and retained-state comparisons;
replay the full repaired corpus and resolve each affected publication or prove
it unchanged and safe; inventory pending offline progress; take the release
backup before the closed server/web/android cutover.

acceptance: exact production source and retained rows correspond; every mandatory
affected publication receives a fenced repair; fragment ids/html/text,
annotations and cursors survive; v4 hosted/offline navigation and pending-progress
recovery pass on the deployed artifacts.
