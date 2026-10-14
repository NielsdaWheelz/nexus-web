# existing apparatus source correspondence blocks repair

status: owner-deferred postrelease; draft source fix qualified offline only
origin: 2026-10-14 release r3 inspection and owner disposition
area: reader apparatus

read-only inspection of `2293419e-8bb2-4fa9-851e-d1010b24067f` at `58c7ecae6`
refuses with `Reader repair existing apparatus source correspondence changed`
at `python/nexus/services/reader_navigation_repair.py:358`. this remains a
failure, separate from the four parse-time refusals. the complete
[r3 census](reader-source-notes-production-repair-pending.md) was not applied;
current note metadata is unrepaired. remaining corpus repairs were explicitly
deferred from the usable release.

exact-source diagnosis found 887 old bodies containing only 1–3 decimal label
characters and null body html. the genuine plan keeps all 1,774 keys, 887 edge
pairs, source refs, kinds, fragments and starts, then supplies source note prose.
the second body/locator guard refuses this historical null shape. the verified
archive is 2,078,997 bytes, sha256
`a72a413cb2fd6564303a7126261bbb611c36d46bc5a27ae32681d3d5bbf742fc`.

[draft pr #584](https://github.com/NielsdaWheelz/nexus-web/pull/584), head
`e3df92b6f7c09d59a5623e889ec5aa18c347ac64`, remains unmerged. it changes the
two existing numeric-body predicates. local static and hosted checks passed;
the genuine archive/snapshot replay qualified all 887 bodies, preserved 1,774
locators and 887 edge identities, and rejected 13 controls. labels, sort keys,
extraction methods and reference/edge source metadata also change in the actual
proposal; this is not a body-only update. production concurrency and source
fences were not exercised by the offline run. no final immutable-image or
restored-database apply/reinspection qualification exists.

evidence: `release/attempts/58c7ecae6/r3-full-inspection-v2/`;
`release/epub-null-label-bodies-20261014/`; independent source review sha256
`28f10cedebb6b41e1e64e58356a509392750f19bea767546f33b5937ac5ed3d5`.

next: retain the draft and exact inputs for separately reviewed maintenance.
resolve [the maintenance budget](reader-repair-epub-parse-budget.md), then
rehearse on a verified restored copy with explicit scope, generation, source
and saved-identity fences. contradictory nonnull old html must still reject.

acceptance: a source-proved proposal with unchanged saved coordinates and
protected identities; valid inspect/apply/unchanged reinspection. refuse any
historical apparatus item/edge deletion. preserve an unproved correspondence
as an explicit refusal rather than fabricate coordinates.
