# a media dossier requested before the media's content index exists fails NoSourceMaterial

status: open · origin: 2026-10-04 dossier reauthor harness (cleanup/dossier-reauthor, integrator run 1) · area: dossiers / media intelligence

a media turns `ready_for_reading` before its content index exists; the
`media_content_reindex_job` builds the index and only then enqueues the media's
intelligence (`media_unit_build`). a dossier build that runs in that gap sees
`load_candidates` empty, so `media_intelligence._ensure_one` answers
`NoReadyUnit` (not `ProjectionPending`), `inputs.ensure` reads that as Ready,
and the build fails `NoSourceMaterial` ("There's nothing citable here yet").

evidence (harness run 1, a fresh extension capture): ingest finished 20:29:43.9,
the build ran 20:29:44.33–44.36 and failed `NoSourceMaterial`, the reindex job
finished 20:29:48.6 and `media_unit_build` was enqueued at 20:29:48.2.

D8 (a build while the intelligence is *building*) is fixed: the build reschedules
until the projection is ready. this gap is narrower and also hits aggregate
members, which are then omitted rather than waited for.

fix: let media intelligence tell "no candidates yet, index pending" from "no
candidates ever" (e.g. pending while a `media_content_reindex_job` for the media
is queued or running) and report `ProjectionPending` for the former.

acceptance: generating a media dossier within seconds of a capture turning
readable waits and ends Current; a media with no indexable text still fails
`NoSourceMaterial` at once.
