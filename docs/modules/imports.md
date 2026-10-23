# imports

imports is the reader's one place to see what happened to everything they brought in (and what the visible shared items they did not bring in are doing), what still needs them, and the one command that recovers it. it is one read model and one narration log; it owns no work.

owners: `python/nexus/services/imports.py` (the read model), `python/nexus/services/import_history.py` (the only writer and reader of `media_upload_events` and `media_processing_events`), `python/nexus/schemas/imports.py` (the wire), `python/nexus/schemas/import_history.py` (stages, the failure catalog, the stored facts), `python/nexus/schemas/import_refs.py` (the ref grammar), `python/nexus/api/routes/imports.py`. web: `apps/web/src/lib/imports/` (`api.ts` reads and the media recovery admission, `ImportsProvider.tsx` the observer, `query.ts` the url, `copy.ts` every import, upload and acquisition string) and `apps/web/src/components/imports/` (list, toolbar, row, actions, inspector, badge), mounted by `app/(authenticated)/imports/ImportsPaneBody.tsx`. the owners it reads: ingest (attempts, sessions, progress, the recovery policy), the media projection (`media_facts`: readiness, offers, restrictions, the metadata view), metadata (`metadata_operations_sql`), content indexing.

## concepts

- **import.** one row per thing brought in: `upload:<session id>` for every upload session the viewer created (kept after publication), `media:<id>` for each visible media with a source attempt or metadata job that none of the viewer's sessions published. a published session whose media the viewer cannot see is dropped.
- **obligation.** three independent nullable slots. source: the unpublished upload, else the latest attempt (a dead job of an unsettled attempt, or a failed attempt without a live job, needs attention; unsettled is active). search: a ready media's current index revision (a dead job needs attention; pending, indexing or a live job is active). metadata: the metadata owner's view (the latest failed or unreviewed no-findings result needs attention; any unfinished job is active). null means nothing applies, not success.
- **classification.** needs attention > active > complete over the slots. the **primary** obligation speaks for the import: the earliest by pipeline stage (`STAGES`: Upload, Validate, Extract, Finalize, SourceProcessing, Index, Metadata), then failure or acceptance time, then key; under a stage or reason filter, the one that matched. the server names it; the web reads `obligations[primary]` and derives nothing.
- **offer / restriction.** the source and search owners' answer for this viewer, as `media_facts` carries it (the same answer the action menu shows): a command naming the exact attempt, job or revision it acts on, or why there is none. an unpublished upload answers for itself: Retry upload (not for a rejected session or a browser capture), or `UploadRejected`.
- **history event.** an append-only narration of a session's or a media's source and index work, written by its owner in the transaction that commits the fact. its payload names its `kind` and holds only what a reader is told; 0225 baselines are stored once-only facts of that cut. metadata operations are projected at read time from their jobs, never stored. history is narration only: no other owner reads it as an identity (an accepted attempt's surviving media is ingest's `media_source_supersessions`).
- **observation.** the newest successful summary's `observed_at`, a clock observation. list/history call `revalidate()` on every clock advance, including the first successful summary; periodic reads wait behind traversal and cannot supersede an admitted read. the inspector remains a single observation-bound read.
- **collection revision.** manual refresh, in-tab `Imports.Invalidated` and `Entries` changes advance the provider's separate strict revision and wake its summary. focus, online, pageshow, pane-open, visibility and polling only observe the summary.

## contracts

http (all authenticated repeatable reads, `Data{data}`; the web under `/api`):

| route | request | answer |
|---|---|---|
| `GET /imports/summary` | none | `ImportSummary{observed_at, needs_attention_count, active_count, unfinished_work_count}` |
| `GET /imports` | `view` (NeedsAttention \| InProgress \| History), `q`, `media_kind`, `stage`, `failure_code`, `state`, `had_failures`, `from`, `before`, `cursor`, `limit` 1..100 = 50 | `ImportPage{matched_count, items, next_cursor}`; 400 `E_INVALID_REQUEST` for a filter the view cannot correlate (In progress: `failure_code`; any non-History view: `state`, `had_failures`, `from`, `before`), `failure_code` with `had_failures=false`, a date without an offset or an unknown parameter; 400 `E_INVALID_CURSOR` |
| `GET /imports/{ref}` | none | `ImportDetail{item, source_issues, related_imports}`; 400 for a malformed ref, 404 `E_IMPORT_NOT_FOUND` |
| `GET /imports/{ref}/history` | `cursor`, `limit` 1..100 = 50 | `HistoryPage{entries, next_cursor}`, newest first by `(occurred_at, id)`; 400, 404, 400 `E_INVALID_CURSOR` |

`ImportItem{ref, media_id, title, original_filename, media_kind, source_label, can_read, can_play, classification, primary, accepted_at, updated_at, matched_event, obligations{source, search, metadata}, source_issue_count}`; `primary` is null exactly when complete. source and search are `ImportObligation{classification, stage, status, waiting_reason, progress, next_retry_at, failure_code, recovery, unavailable_reason}` (status, waiting reason, progress and next retry describe active work, the code attention); metadata is `MetadataEnrichmentView`. `HistoryEntry{id: upload:|processing:|metadata:<uuid>, occurred_at, stage, failure_code, facts}` with `facts` one stored kind or `MetadataOperation`. a list cursor binds the viewer, the view and `ImportListQuery.normalized()`; a history cursor binds the viewer and the ref.

`related_imports` is a required array of `{relation: "article" | "thread", item: ImportItem}`. native x carrier inspections supply distinct visible one-hop relationships even when thread publication failed. each item uses its own current attempt and source/search state; no parent status aggregates or controls its child. deleted or invisible resources are omitted, and reading never retries or reacquires anything.

imports sends no write of its own. its commands go to their owners with their retry rules: `POST /media/{id}/retry` and `/repair` (`recoverMedia`, the offer's exact expectation; a stale one is 409 and reads "This import changed"), `POST /media/uploads` with the session's own id and the original file, and `DELETE /media/uploads/{id}` (a session that published meanwhile is done), metadata research and review through `lib/media`.

row shortcuts and overflow share the same open, offered recovery and upload
commands. at row content widths up to 520px only more remains beside identity;
status and operation feedback may wrap below. the menu explicitly retains open
when ready, independently of title selection, which opens the import inspector.
overflow open is a command with plain/shift intent: close precedes asynchronous
validation. wide/title anchors retain native browser gestures.
unpublished upload menus are immediate; media menus retain canonical preparation.
retry upload synchronously opens the existing file input, then file selection
uses the session's existing attempt owner. cancellation creates no command.
metadata retains its canonical menu projectors and direct recovery owner, including
the existing eager source-remedy read and visible feedback. responsive hosts use
owner-defined control markers; they do not interpret metadata workflow internals.

the workspace planner owns reuse and creation; pane count never refuses completion.

in process: `append_upload_event` and `append_processing_event` (caller's transaction, nothing returned), `delete_upload_history_in_current_transaction` and `delete_processing_history_in_current_transaction` (history dies with its session or media), `events_of_import_sql`, the queue hooks `on_source_job_outcome` and `on_index_job_outcome` (inside the job transition), `assume_safe_failure_code`, `queue_failure_code`, `parse_import_ref`, `format_import_ref`. web: `publishImportsInvalidation` / `subscribeImportsInvalidations` (the in-tab `Imports.Invalidated` event), `encodeImportsUrl` (Add's "view import"), `ImportsBadge`, the companion group `imports-inspector` with surface `import-detail`, `FAILURE_COPY` (the media banner) and the acquisition copy the add panel, share, Connections and note attachments word their outcomes with.

url: `/imports?view&q&media_kind&stage&failure_code&state&had_failures&from&before&selected`, by wire name in one order; decoding is tolerant and keeps what the reader wrote; dates are UTC days, `[from, before)`; `selected` is admitted only as one `upload:` or `media:` path segment. no browser storage.

## invariants

- **I1** summary, page and detail apply the same classification rules; separate reads can observe different moments.
- **I2** a view never shows a filter it does not apply, and the web never sends one `GET /imports` refuses (`VIEW_FILTERS` is the one table); of a reason and "no recorded failures", the latest choice wins.
- **I3** every shown source or search code is catalogued (`SafeFailureCode`, which `FAILURE_COPY` is exhaustive over); a queue code outside it reads as `E_WORKER_HANDLER_FAILED`, and recording history never aborts a queue transition.
- **I4** history is written only by its owners' transactions through `import_history`, records nothing for a settled attempt or a deleted media, and decodes only the kinds it stores.
- **I5** a History row carries its matched event only when a newer event follows it; match evidence belongs to one ref under one applied query.
- **I6** the first view is chosen once from the counts; restoring a url never opens the inspector; explicit activation (a title, the Inspector control, Add's "view import") does.
- **I7** one command per import and command is in flight on its owner. refresh/research use the account's media-admission entry; other verbs use the action runtime (`media:<id>|<offer>`, `upload:<id>|RetryUpload|RemoveUpload`). the row, inspector and menu read that same busy state. upload refusals stay beside their originating control.
- **I8** list/history use the shared collection owner at 50 rows/page, publish each page and continue to source exhaustion while their pane is active and the document visible. history mounts only while open; a later match never reopens a collapsed history. reopening a restored history requests one coalesced reread when a summary observation exists, since the clock may have advanced while it was shut; a fresh first page does not schedule that extra read. polling runs every 5 s only while the newest summary succeeded, no summary read is running, work is unfinished, the tab is visible and an Imports pane is open or a wake is under 15 minutes old; a failed summary stops it until a wake. history reads only while open.
- **I9** a failed reread keeps the last data beside its error (list, detail, history). collection ids use first-occurrence-wins; refresh replaces the loaded prefix atomically and rereads complete collections to exhaustion. list `matched_count` is metadata from the latest committed page, including an empty page: it is an independent server observation, never a completion signal. rows retained from another query do not publish that query's matched evidence.
- **I10** a disappearing list control hands focus to the same row's title, else the next surviving row's, else the query input, only while focus was lost and the pane is active.

## feedback and uncertain admission

shared `FeedbackStatus`, `FeedbackNotice` and `FeedbackState` present operation facts, retained-data failures and absent content. retry retains the error and control while busy. recorded history stays domain content.

`lib/media/admissions.tsx` owns live source-refresh and metadata-research
submissions. its account-keyed shell provider outlives panes and registers
unacknowledged requests with the common loss guard. one entry per kind/media
keeps the submitted bytes and original expectation in memory; retries send those
exact bytes with the existing 30-second response deadline. fresh source refresh
requires an observed settled-attempt capability. metadata replay may answer the
current qualifying job, rather than prove receipt of the original click.

entries are sending or unconfirmed. acknowledgement or a definitive first-attempt
refusal retires the exact entry; a later refusal after uncertainty leaves it
unconfirmed and refreshes canonical reads. feedback offers `retry same request`
and `dismiss`. dismissal confirms the loss of uncertainty before forgetting; it
does not cancel accepted server work. only explicit dismissal permits a new
action with a newly read expectation. a captured entry object fences late replies
from clearing or modifying a replacement. account teardown removes its entries.
the entry retains its actual last api error. a wire mismatch after uncertainty
keeps the request and its loss risk, while the shared stale-build notice and
local controls offer only reload. the retry capability also refuses that stale
entry, including calls from previously retained controls.
there is no storage, startup restore, replay or browser-restart recovery. other
commands keep their existing owners and retry rules.

every attempted source or metadata admission wakes imports, including an unknown response. metadata admission and personal review also restart the media's metadata stream. departed accounts cannot publish those effects into their successors.

## acquisition recovery

[ingest](ingest.md) owns guarded admission, upload publication, receipt lifetime
and current-reference supersession; [libraries](library.md) owns retention and
placement revisions. import views never infer current saving from a past receipt.

[add content](add-content.md) owns live upload recovery. a guard refusal permits
review against the same staged generation before expiry; an unknown confirmation
retains its exact command. losing that owner requires file reselection/recapture.
imports exposes its existing retry-upload action rather than durable confirmation
recovery or a second placement command owner.
