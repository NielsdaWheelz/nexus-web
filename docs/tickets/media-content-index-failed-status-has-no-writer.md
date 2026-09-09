# A media content index is never marked `failed` when its reindex job dies

**Status:** open
**Origin:** Imports workspace cutover, Track C2 review round 3, 2026-09-08
**Area:** `python/nexus/jobs/registry.py` (`media_content_reindex_job`);
`python/nexus/jobs/dead_letter_projections.py`;
`python/nexus/services/imports.py` (media classification)

## What is wrong

The Imports classifier reads `content_index_states.status = 'failed'` as a
media-side fact and gives it a dedicated `InvariantDefect` branch
(`python/nexus/services/imports.py:241-246`, raised at
`python/nexus/services/imports.py:497-501`). The product cannot reach that
status for a media owner:

- `media_content_reindex_job` declares `history_projection="ContentIndex"` and
  no `dead_letter_projection` (`python/nexus/jobs/registry.py:145-153`), so a
  dead reindex job writes queue history and nothing else.
- The only writer of `status = 'failed'` is `_project_note_content_index`
  (`python/nexus/jobs/dead_letter_projections.py:87-156`, the update at `:117`
  and the insert at `:146`), reached only by `note_reindex_job`
  (`python/nexus/jobs/registry.py:222-229`), and it writes
  `owner_kind = 'note_block'`.
- The reachable media-owner statuses written in
  `python/nexus/services/content_indexing.py` are `pending`
  (`request_media_content_reindex`: the state insert at `:1258` and the
  revision bump at `:1282`, both `owner_kind = 'media'`; and
  `deactivate_content_index:1723`, reached from
  `python/nexus/services/transcripts/current.py:156`), `indexing`
  (`prepare_media_content_reindex:1022`, `publish_content_index:351`), `ready`
  (`publish_content_index:634`), `no_text` (the shared publish path,
  `publish_content_index:426`, reached by media publication) and
  `ocr_required` (`publish_media_content_reindex:1113`, written under an
  explicit `WHERE owner_kind = 'media'`). `failed` is not among them.
  `mark_content_index_pending:1705` is not a media writer: its one caller is
  `python/nexus/services/note_indexing.py:71`, which passes
  `IndexOwner("note_block", ...)`.

So the branch guards a state no owner transition produces.
`test_failed_index_without_its_exact_dead_job_is_still_a_defect`
(`python/tests/service/test_imports.py:685`) proves the branch by constructing
that state directly through the ORM
(`db_session.add(ContentIndexState(owner_kind="media", owner_id=media_id,
revision=1, status="failed"))`, `python/tests/service/test_imports.py:702`),
which is why the gap did not surface as a failing proof.

The reader-visible consequence is the other half: when a media reindex job
dead-letters, the index state stays at whatever it last reached and the only
durable record that indexing stopped is the dead queue row. The classifier
therefore depends on the exact-dead-job join alone
(`python/nexus/services/imports.py:241-249`) — if that join ever loses a row
(a pruned queue row, a superseded revision), a stalled search index reads as
`Complete` with no attention and no recovery offer.

## Prerequisites

Decide which of the two halves is the product intent, because they are
mutually exclusive:

1. the media index has no `failed` status (queue deadness is the whole record),
   or
2. a dead media reindex job projects `failed` onto `content_index_states` the
   way a note reindex does.

`media_content_reindex_job` sets `never_prune_dead=True`
(`python/nexus/jobs/registry.py:153`), so today's dead row is durable; confirm
that stays true before choosing (1).

## Proposed fix

If (1): delete the `index_status = 'failed'` defect branch
(`python/nexus/services/imports.py:241-246`) and only the `'failed'` member of
the active-status list (`python/nexus/services/imports.py:249`), and delete
`test_failed_index_without_its_exact_dead_job_is_still_a_defect`. Leave
`no_text` and `ocr_required` untouched: both are reachable media states that the
classifier deliberately reads as Complete, proved by
`test_settled_index_outcome_is_complete_and_asks_for_nothing`
(`python/tests/service/test_imports.py:771`, parametrized over `no_text` and
`ocr_required`).

If (2): add a `MediaContentIndex` dead-letter projection beside
`_project_note_content_index`, declare it on `media_content_reindex_job`, and
keep the classifier branch — it then guards a real transition, and the exact
dead-job join stops being the sole evidence that indexing stopped.

Either way `repair_dead_media_reindex` keeps its current shape: it requeues the
dead job and never rewrites the published materialization.

## Acceptance

Every `content_index_states.status` value the Imports classifier reads for a
media owner has a named product transition that writes it, and the proof of
each classifier branch seeds its state through an owner API rather than direct
`ContentIndexState` database construction.
