# suggestions input integration inventory

status: implemented and verified on candidate `fde33a16367b4d04bb4fcf92d7dc47962897675d`, 2026-10-15. temporary live campaign receipts are indexed by the accompanying verification record.

## contract

`services/suggestion_changes.py` owns `input_revision(db)`, `record_input_change(db)`,
`notify_suggestions(db)`, `on_suggestion_job_history(db, job, execution_id)`, and explicit
feed/publication cleanup by library. channel `nexus_suggestions`, key `changed`.
recording flushes pending orm work, increments the seeded global revision exactly once,
asserts one row, then notifies. caller performs no later domain work before commit.
queue history imports remain light. revision reads never create storage.

## detection and commit owners

| fact | detection owner | committing owner and final placement |
|---|---|---|
| reader engagement, resume/unread state | consumption/service.py `put_reader_cursor_in_txn` | `put_reader_cursor.run`, after result construction and all writes |
| listening engagement/state | consumption/service.py `_write_listening`, `_resume` | `record_listening.run` and `install_preview_position.run`, after current fence/result reads |
| lectern placement/removal and explicit completion/reset | consumption/service.py command apply; consumption/lectern.py | consumption/__init__.py `replayed_command.run`, after replay memo; exact replay rolls back without increment |
| podcast bulk finish | consumption/service.py `set_podcast_episode_states_in_txn` returns changed count | podcasts/episodes.py `mark_played`, last inside transaction |
| raw activity spans | consumption/activity.py | no hook: ranker does not read spans |
| media/podcast library placement | library_entries.py shared `ensure_entry`, `delete_entry`, placement helpers | public filing/unfiling transaction owners; tools/run.py completion and tools/assistant_writes.py undo; source/upload/episode/email owners below |
| destination role, visibility, membership | library_sharing.py role/removal/transfer/accept paths | end of each existing transaction after response facts; invitations alone excluded |
| library deletion | library_governance.py `delete_library` | delete publication/feed before library, then normal media/dossier cleanup, then revision before transaction exits |
| share grants | resource_sharing.py `create_share`; resource_grants.py `delete_grant` | final outer transaction after subject/teardown operations; absent/idempotent outcome excluded |
| highlight create/update/delete | highlights.py and pdf_highlights.py public commands | after final highlight/note/graph/response operations before each commit; shared helpers remain flush-only |
| notes, page anchors, note bodies and surfaces | notes.py; resource_items/{mutations,surfaces}.py | public committing functions after replay memo and hydration; tools completion covers assistant shared-helper writes |
| user links and link-note motifs | resource_graph/links.py `_replayed` and `delete_link` | after receipt/response and all edge/note work; shared edges/cleanup functions remain flush-only |
| discovery evidence | connection_discovery.py `_publish`, `dismiss_connection_discovery_edge` | after edge replacement and queue/ledger effects before commit |
| active media embeddings and owner-resolving chunks/evidence | content_indexing.py publication phase | `_phase`/media index publication final commit boundary; pending transitions also count where active evidence is removed |
| note chunk/evidence cleanup | note_indexing.py | final successful index publication/deletion boundary; no provider call inside transaction |
| authors and publication dates | contributors.py `_publish_chunk`, `_put_media_authors`; tasks/enrich_metadata.py `_publish.finish` | after actual changed credit/publication facts and queue settlement; unchanged enrichment excludes false dirtiness where easy |
| source media, fragments, publication, embeds, dedupe | media_source_ingest.py admission/completion; web_article.py; media_source_adapters.py; youtube.py | each actual publishing callback increments last; the existing source phase then only commits. no generic callback or source phase machinery added. extraction-progress/finalizing-only phases excluded |
| acquired/uploaded media placement | media_upload_sessions.py completion; media_source_ingest.py admission | after library placement and durable attempt/receipt writes before owning commit |
| email acquisition | email_ingest_service.py `accept_email_message` | first commit publishing media + default-library membership; later upload/dispatch-only commits excluded |
| podcast subscribe/unsubscribe | podcasts/subscriptions.py | after placement/backfill/sync/visibility work and response facts; unchanged canonical subscription excluded, discovered-show refresh conservatively included |
| episode arrival/metadata/placement | podcasts/ingest.py returns inserted/updated/placement change | podcasts/{sync,backfill,episode_acquisition}.py outer commit after auto-queue/step state; subscription-only sync status is not ranking input |
| media tombstone/physical deletion/dedupe | media_deletion.py; tasks/media_teardown.py | public remove transaction; teardown `_commit_or_void` after checkpoint write; source publication covers duplicate merge |
| system corpus seeding | oracle/corpus.py `seed` transaction | after corpus/library/credit changes; no special background scheduling |
| system corpus visibility | library_governance.py `join_system_library` returns insertion fact | oracle/readings.py records only new membership, after reading/job creation |
| transcript admission/publication | podcasts/transcription.py request/batch/import/worker owners | after admitted or published transcript effects; status-only running observation excluded |
| reader/index operator repairs | ops/processing_recovery.py, reader_navigation_repair.py | after final replay/validation, before commit |
| index reconciliation | tasks/reconcile_stale_ingest_media.py `_ensure_index` | newly enqueued work records after index state/queue change; joined live/dead work stays clean |

no product user-deletion path was found (`users.py` owns profile only). no speculative account
cleanup helper or account-deletion behavior was added.

## deliberate tradeoff

the revision is conservative cache-input invalidation, not an exact event ledger. fresh explicit
commands may increment when the requested state already holds; exact memo replays do not. this
avoids widening durable receipts solely to optimize no-op detection. existing changed/inserted
facts suppress no-ops where free. periodic source syncs compare bibliography, publication time,
duration and placement; same-anchor engagement has the stricter contract below. system corpus
seeding is a rare operator command and conservatively invalidates each work transaction.

## anchor suppression

compare exact ordered lectern refs and affected admin-library anchor refs before and
after reader/listening writes, plus the affected media's read state. the library owner selects
named destinations containing the media or its parent show, plus All when the media has a
physical entry through a non-system membership. unrelated destinations cannot change anchors.
comparing only registered feeds is insufficient: a concurrent first registration can otherwise miss a library-specific
anchor change. select refs only; never acquire graph or embeddings. same-anchor heartbeat
with unchanged read state does not increment. the initial all-library comparison cost 40 queries and 0.84–0.89 seconds per snapshot on 34 admin libraries; the affected-destination selector reduced this to 8 queries and 0.185–0.196 seconds for two libraries. those isolated fingerprint timings do not measure a complete write. actual authenticated warm api cursor writes on the production-shaped clone measured 203–245 milliseconds for ordered-anchor changes and 214–260 milliseconds for unchanged heartbeats; the latter left the revision unchanged. this preserves the shared exact anchor policy without another dependency cache or schema. the small local proof measured one unchanged-anchor cursor write at 45 milliseconds.

## graph exclusions

`owner_rows_sql` resolves highlights/fragments/apparatus/evidence/chunks/passages to media or
notes; media, podcast, page and note anchors can affect ranking. message, oracle-reading and
artifact-revision citation sources retain those schemes and are neither anchors nor eligible
media/podcast candidates. their ordinary citation publications do not need hooks. user links,
note bodies, highlight-note attachments, embeds and discovery remain covered.

## observed proof

23 real writer cases covered reader engagement, unchanged heartbeats, explicit completion and
replay, filing, daily capture and replay, user links and removal, contributor ingestion and
no-op, grants and revocation, source admission and replay, fenced reader/index publication,
library deletion, and media teardown. every observed revision change was the final domain
statement, followed only by notification and commit; notifications were absent for unchanged
heartbeats and exact replays. inactive writes created no suggestion feed or job. the library
scope fixture covered media, parent podcast, the default physical-media union, and an unrelated
destination independently of feed registration.

a separate adverse schedule held a real daily-note write at the final global counter update,
registered the first feed, and paused the worker's real embedding query after its snapshot.
after the source committed, the worker published revision 1 while current state exposed
revision 2. source data and counter were invisible before their common commit. publication
cleared its job pointer and admitted no inactive successor.

an actual fenced reader-source replacement also overlapped a cursor save. the publisher
held the media/publication rows and waited at the global counter; the cursor held its viewer
row and waited on that publication. database blocking identities confirmed both edges.
after release, the publisher committed generation 2 and its final revision increment;
the cursor's normal serializable retry refused generation 1 with `E_READER_CONTENT_CHANGED`
without writing. a fresh generation-2 cursor succeeded. unchanged 30-second statement,
10-second lock and one-minute idle limits applied; no lock wait or transaction remained.
prepared local article content replaced network acquisition only. actual source admission,
refresh, queue claims, publication fences and terminal settlement ran; source jobs succeeded
and only the fixture's provider-index jobs were retired through fenced failure.

library deletion removed its publication and feed before its library. physical media deletion
advanced the counter only at the deletion checkpoint. campaign-owned provider side effects
were retired through ordinary queue claims and fenced settlement; no live fixture jobs remained
when the browser cold-start window began.

these checks used small isolated fixtures and real service/queue boundaries, with database
locks controlling the concurrency schedule. they did not call external providers. the separate
remote qualification owns corpus-sized ordinary reads and browser timing.
