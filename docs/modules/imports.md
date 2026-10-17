# imports

imports is the reader's one place to see what happened to everything they brought in (and what the visible shared items they did not bring in are doing), what still needs them, and the one command that recovers it. it is one read model and one narration log; it owns no work.

owners: `python/nexus/services/imports.py` (the read model), `python/nexus/services/import_history.py` (the only writer and reader of `media_upload_events` and `media_processing_events`), `python/nexus/schemas/imports.py` (the wire), `python/nexus/schemas/import_history.py` (stages, the failure catalog, the stored facts), `python/nexus/schemas/import_refs.py` (the ref grammar), `python/nexus/api/routes/imports.py`. web: `apps/web/src/lib/imports/` (`api.ts` reads and the media recovery admission, `ImportsProvider.tsx` the observer, `query.ts` the url, `copy.ts` every import, upload and acquisition string) and `apps/web/src/components/imports/` (list, toolbar, row, actions, inspector, badge), mounted by `app/(authenticated)/imports/ImportsPaneBody.tsx`. the owners it reads: ingest (attempts, sessions, progress, the recovery policy), the media projection (`media_facts`: readiness, offers, restrictions, the metadata view), metadata (`metadata_operations_sql`), content indexing.

## concepts

- **import.** one row per thing brought in: `upload:<session id>` for every upload session the viewer created (kept after publication), `media:<id>` for each visible media with a source attempt or metadata job that none of the viewer's sessions published. a published session whose media the viewer cannot see is dropped.
- **obligation.** three independent nullable slots. source: the unpublished upload, else the latest attempt (a dead job of an unsettled attempt, or a failed attempt without a live job, needs attention; unsettled is active). search: a ready media's current index revision (a dead job needs attention; pending, indexing or a live job is active). metadata: the metadata owner's view (the latest failed or unreviewed no-findings result needs attention; any unfinished job is active). null means nothing applies, not success.
- **classification.** needs attention > active > complete over the slots. the **primary** obligation speaks for the import: the earliest by pipeline stage (`STAGES`: Upload, Validate, Extract, Finalize, SourceProcessing, Index, Metadata), then failure or acceptance time, then key; under a stage or reason filter, the one that matched. the server names it; the web reads `obligations[primary]` and derives nothing.
- **offer / restriction.** the source and search owners' answer for this viewer, as `media_facts` carries it (the same answer the action menu shows): a command naming the exact attempt, job or revision it acts on, or why there is none. an unpublished upload answers for itself: Retry upload (not for a rejected session or a browser capture), or `UploadRejected`.
- **history event.** an append-only narration of a session's or a media's source and index work, written by its owner in the transaction that commits the fact. its payload names its `kind` and holds only what a reader is told; 0225 baselines are stored once-only facts of that cut. metadata operations are projected at read time from their jobs, never stored. history is narration only: no other owner reads it as an identity (an accepted attempt's surviving media is ingest's `media_source_supersessions`).
- **observation.** the newest successful summary's `observed_at`: the only token on which the list, the inspector and an open history reread.

## contracts

http (all authenticated repeatable reads, `Data{data}`; the web under `/api`):

| route | request | answer |
|---|---|---|
| `GET /imports/summary` | none | `ImportSummary{observed_at, needs_attention_count, active_count, unfinished_work_count}` |
| `GET /imports` | `view` (NeedsAttention \| InProgress \| History), `q`, `media_kind`, `stage`, `failure_code`, `state`, `had_failures`, `from`, `before`, `cursor`, `limit` 1..100 = 50 | `ImportPage{matched_count, items, next_cursor}`; 400 `E_INVALID_REQUEST` for a filter the view cannot correlate (In progress: `failure_code`; any non-History view: `state`, `had_failures`, `from`, `before`), `failure_code` with `had_failures=false`, a date without an offset or an unknown parameter; 400 `E_INVALID_CURSOR` |
| `GET /imports/{ref}` | none | `ImportDetail{item, source_issues}`; 400 for a malformed ref, 404 `E_IMPORT_NOT_FOUND` |
| `GET /imports/{ref}/history` | `cursor`, `limit` 1..100 = 50 | `HistoryPage{entries, next_cursor}`, newest first by `(occurred_at, id)`; 400, 404, 400 `E_INVALID_CURSOR` |

`ImportItem{ref, media_id, title, original_filename, media_kind, source_label, can_read, can_play, classification, primary, accepted_at, updated_at, matched_event, obligations{source, search, metadata}, source_issue_count}`; `primary` is null exactly when complete. source and search are `ImportObligation{classification, stage, status, waiting_reason, progress, next_retry_at, failure_code, recovery, unavailable_reason}` (status, waiting reason, progress and next retry describe active work, the code attention); metadata is `MetadataEnrichmentView`. `HistoryEntry{id: upload:|processing:|metadata:<uuid>, occurred_at, stage, failure_code, facts}` with `facts` one stored kind or `MetadataOperation`. a list cursor binds the viewer, the view and `ImportListQuery.normalized()`; a history cursor binds the viewer and the ref.

imports sends no write of its own. its commands go to their owners with their retry rules: `POST /media/{id}/retry` and `/repair` (`recoverMedia`, the offer's exact expectation; a stale one is 409 and reads "This import changed"), `POST /media/uploads` with the session's own id and the original file, and `DELETE /media/uploads/{id}` (a session that published meanwhile is done), metadata research and review through `lib/media`.

the workspace planner owns reuse and creation; pane count never refuses completion.

in process: `append_upload_event` and `append_processing_event` (caller's transaction, nothing returned), `delete_upload_history_in_current_transaction` and `delete_processing_history_in_current_transaction` (history dies with its session or media), `events_of_import_sql`, the queue hooks `on_source_job_outcome` and `on_index_job_outcome` (inside the job transition), `assume_safe_failure_code`, `queue_failure_code`, `parse_import_ref`, `format_import_ref`. web: `publishImportsInvalidation` / `subscribeImportsInvalidations` (the in-tab `Imports.Invalidated` event), `encodeImportsUrl` (Add's "view import"), `ImportsBadge`, the companion group `imports-inspector` with surface `import-detail`, `FAILURE_COPY` (the media banner) and the acquisition copy the add panel, share, Connections and note attachments word their outcomes with.

url: `/imports?view&q&media_kind&stage&failure_code&state&had_failures&from&before&selected`, by wire name in one order; decoding is tolerant and keeps what the reader wrote; dates are UTC days, `[from, before)`; `selected` is admitted only as one `upload:` or `media:` path segment. no browser storage.

## invariants

- **I1** summary, page and detail read one classification, so a count and a row cannot disagree.
- **I2** a view never shows a filter it does not apply, and the web never sends one `GET /imports` refuses (`VIEW_FILTERS` is the one table); of a reason and "no recorded failures", the latest choice wins.
- **I3** every shown source or search code is catalogued (`SafeFailureCode`, which `FAILURE_COPY` is exhaustive over); a queue code outside it reads as `E_WORKER_HANDLER_FAILED`, and recording history never aborts a queue transition.
- **I4** history is written only by its owners' transactions through `import_history`, records nothing for a settled attempt or a deleted media, and decodes only the kinds it stores.
- **I5** a History row carries its matched event only when a newer event follows it; match evidence belongs to one ref under one applied query.
- **I6** the first view is chosen once from the counts; restoring a url never opens the inspector; explicit activation (a title, the Inspector control, Add's "view import") does.
- **I7** one command per import and command is in flight on the action runtime (`media:<id>|<offer>`, `upload:<id>|RetryUpload|RemoveUpload`); the row, the inspector and the menu show the same "Starting…".
- **I8** polling runs every 5 s only while the newest summary succeeded, work is unfinished, the tab is visible and an Imports pane is open or a wake is under 15 minutes old; a failed summary stops it until a wake. history reads only while open.
- **I9** a failed reread keeps the last data beside its error (list prefix, detail, history); a reread never shows one ref or event twice.
- **I10** a disappearing list control hands focus to the same row's title, else the next surviving row's, else the query input, only while focus was lost and the pane is active.
