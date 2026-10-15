# suggestions input integration inventory

status: source hooks integrated against `origin/main` `7bc7c8a13d7f0c866bef49ad1fc218b603393594`, 2026-10-15. the merged candidate requires its own qualification. prior receipts identify the earlier implementation explicitly; they do not qualify the reauthored source owners below.

## contract

`services/suggestion_changes.py` owns `input_revision(db)`, `record_input_change(db)`,
`notify_suggestions(db)`, `on_suggestion_job_history(db, job, execution_id)`, and explicit
feed/publication cleanup by library. channel `nexus_suggestions`, key `changed`.
recording flushes pending orm work, increments the seeded global revision exactly once,
asserts one row, then notifies. the committing owner performs no later domain work.
queue history imports remain light. revision reads never create storage.

## detection and commit owners

paths below are relative to `python/nexus/services` unless prefixed with `tasks/`.
shared helpers flush; the named transaction owner records the change last.

| fact | detection and committing owner |
|---|---|
| reader engagement, resume/unread state | consumption/state.py `put_reader_cursor.run`: compare ordered anchors and read state around accepted cursor/resume writes; record after response facts, before commit |
| listening engagement/state | consumption/state.py `record_listening.run`, `install_preview_position.run`: compare anchors and state around accepted listening/resume writes; record after current fence/result reads |
| explicit completion/reset | consumption/state.py `finish`, `undo_finish`, `mark_unread`, `reset_progress`: final command transaction; `natural_end` records only accepted terminal samples |
| lectern placement/removal | consumption/lectern.py `place` and actual `remove`; shared append/remove/restore leave recording to their outer caller |
| podcast bulk finish | consumption/state.py `set_episode_states_in_txn` returns changed count; podcasts/episodes.py `mark_played` records last only when changed |
| raw activity spans | consumption/activity.py: no hook; the ranker does not read spans |
| media/podcast library placement | library_entries.py `place_item`, `unplace_item`; shared `ensure_entry`, `delete_entry` remain flush-only. ordering-only `move_entry` does not affect ranking |
| destination role, visibility, membership | library_members.py role/removal/transfer/accept paths: after response facts and visibility cleanup. invitation-only changes excluded |
| library deletion | libraries.py `delete_library`: delete publication/feed before library, perform normal media/dossier cleanup, then record before transaction exit |
| share grants | resource_sharing.py `create_share`; resource_grants.py `delete_grant`: after subject/teardown operations. already-present/absent early returns excluded |
| highlight create/update/delete | highlights.py and pdf_highlights.py public commands: after final highlight/note/graph/response operations, before commit |
| notes and pages | notes.py public create/delete/capture/attach/detach commands: after response facts; existing page-id creation stays clean. shared title/daily-page helpers do not record |
| note bodies, titles, surfaces and blocks | outline.py `execute`: after all commands and response hydration, before commit. tools completion covers assistant shared-helper writes |
| user links and link-note motifs | resource_graph/links.py create/delete/put-note/detach: after all edge/note/response work; actual detach required for detach invalidation |
| discovery evidence | connection_discovery.py `_publish`, `dismiss_connection_discovery_edge`: after edge replacement and queue/ledger effects, before commit |
| active media embeddings and owner-resolving chunks/evidence | content_indexing.py prepare/publication callbacks: after state/block/embedding work; existing phase owner then commits. preparation removes active evidence and therefore counts |
| note chunk/evidence cleanup | note_indexing.py: final successful index publication/deletion boundary; no provider call inside transaction |
| authors and publication dates | contributors.py `_publish_chunk`, `_put_media_authors`; tasks/enrich_metadata.py `_publish.finish`: after changed credits/publication facts and queue settlement; free changed facts suppress no-ops |
| source media admission, retry and refresh | media_source_ingest.py public admission/retry/refresh: after media, placement, attempt, event and response facts; already-landed identity/successor returns stay clean |
| source publication, fragments, embeds and dedupe | source_runner.py publication callbacks, web_article.py reader publication, youtube.py playable publication: after all source writes and settlement; existing publication phase then commits. no generic phase callback machinery |
| source failure publication | source_runner.py `_fail`: after failure publication and embed-target synchronization. terminal queue failure records in import_history.py `on_source_job_outcome` after the preceding source `on_dead` hook and its domain work |
| acquired/uploaded media placement | media_upload_sessions.py publication: after library placement, session receipt, event and response facts. already-published identity return stays clean |
| email acquisition | email_ingest_service.py `accept_email_message`: first transaction publishing media/default-library membership/attempt. later upload/dispatch-only commits excluded |
| podcast subscribe/unsubscribe | podcasts/subscriptions.py: after placement/backfill/sync/visibility work and response facts; unchanged canonical subscription excluded, discovered-show refresh conservatively included |
| episode arrival/metadata/placement | podcasts/ingest.py returns changed fact; podcasts/{sync,backfill,episode_acquisition}.py record after auto-queue/step/placement work. status-only periodic sync stays clean |
| media tombstone, teardown and dedupe | media_deletion.py public remove: after embed/visibility cleanup; `run_teardown_job`: after physical deletion or voiding a tombstone. source publication owns duplicate merges |
| system corpus seeding | oracle/corpus.py work transaction: after corpus/library/credit changes. oracle-only reading anchors are not ranker input |
| system corpus visibility | libraries.py `join_system_library` returns insertion fact; oracle/readings.py records only new membership, after reading/job creation |
| transcript admission/publication | podcasts/transcription.py request/batch/import/worker owners: after admitted or published transcript effects. status-only running observation excluded |
| reader repair | reader_navigation_repair.py: after final validation, before commit. source queue repair alone is not a changed ranking input |
| assistant writes and undo | tools/run.py `_complete`: after successful write result/ledger/event publication; tools/assistant_writes.py undo: after the reverted receipt. nested write helpers do not record |

retired source adapters, governance/sharing modules, consumption replay owner, resource-item
mutation/surface modules, teardown task and stale-ingest reconciliation task remain deleted.
no hook restores their behavior or adds a replacement replay ledger. no product account-deletion
path exists (`users.py` owns profile only); no speculative account cleanup was added.

## deliberate tradeoff

the revision is conservative cache-input invalidation, not an exact event ledger. current
upstream identity and absolute-command semantics remain authoritative: an explicit command
may increment when its requested state already holds, including a resent command that upstream
reapplies. no memo storage is added to suppress these writes. existing changed/inserted facts
and settled identity returns suppress no-ops where free. periodic source syncs compare
bibliography, publication time, duration and placement. same-anchor engagement has the stricter
contract below. system corpus seeding conservatively invalidates each work transaction.

the singleton is independent of feed registration. source writers record even when no feed
exists; inactive changes admit no suggestion work. its update is last because consumption
locks a viewer before reader publication while source publication can hold media/publication
rows. adding this counter to the user row would create the opposite lock order. the independent
counter introduces no such return edge; publication workers only read it.

## anchor suppression

compare exact ordered lectern refs and affected admin-library anchor refs before and after
reader/listening writes, plus the affected media's consumption state. the library owner selects
named destinations containing the media or its parent show, plus the default library when the
media has a physical entry through a non-system membership. unrelated destinations cannot
change anchors. comparing only registered feeds can miss a concurrent first registration.
select refs only; never acquire graph or embeddings. same-anchor heartbeat with unchanged
consumption state does not increment.

on prior candidate `fde33a16367b4d04bb4fcf92d7dc47962897675d`, the all-library comparison cost
40 queries and 0.84–0.89 seconds per snapshot on 34 admin libraries. narrowing to affected
destinations reduced this to 8 queries and 0.185–0.196 seconds for two libraries. isolated
fingerprint timings are not request latency: authenticated warm api cursor saves measured
203–245 milliseconds for anchor changes and 214–260 milliseconds for unchanged heartbeats.
the latter kept the revision unchanged. these historical timings justify the selector but
are not a latency qualification of the newly merged consumption owner.

## graph exclusions

`owner_rows_sql` resolves highlights/fragments/apparatus/evidence/chunks/passages to media or
notes; media, podcast, page and note anchors can affect ranking. message, oracle-reading and
artifact-revision citation sources retain those schemes and are neither anchors nor eligible
media/podcast candidates. their ordinary citation publications do not need hooks. user links,
note bodies, highlight-note attachments, embeds and discovery remain covered.

## historical proof boundary

`inputs-and-corpus.json` records the earlier candidate's 23 writer cases, first-registration
and source-snapshot schedules, and reader-publication/cursor lock schedule. those checks used
real service/queue boundaries and isolated fixtures without external providers. source and
revision became visible at the same commit; same-anchor heartbeats stayed clean; inactive
writes admitted no feed/job. feed cleanup preceded library deletion. the reader publisher
committed while a generation-1 cursor waited, and the cursor's ordinary serializable retry
rejected the obsolete generation before a generation-2 save succeeded.

the upstream reauthoring changed committing owners and removed replay storage. merged-source
verification must exercise the new owners and identity/absolute-command contracts; historical
exact-memo-replay results must not be attributed to this integration.
