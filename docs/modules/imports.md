# imports

imports is the reader's one place to see what happened to everything they brought in (and what the visible shared items they did not bring in are doing), what still needs them, and the one command that recovers it. it is one read model and one narration log; it owns no work.

owners: `python/nexus/services/imports.py` (the read model), `python/nexus/services/import_history.py` (the only writer and reader of `media_upload_events` and `media_processing_events`), `python/nexus/schemas/imports.py` (the wire), `python/nexus/schemas/import_history.py` (stages, the failure catalog, the stored facts), `python/nexus/schemas/import_refs.py` (the ref grammar), `python/nexus/api/routes/imports.py`. web: `apps/web/src/lib/imports/` (`api.ts` reads and the media recovery admission, `ImportsProvider.tsx` the observer, `query.ts` the url, `copy.ts` composes import, upload and acquisition copy, `words.ts` owns pure sentences shared with the extension, `intake.tsx` the lines coming in, `lineView.ts` a line's words) and `apps/web/src/components/imports/` (list, toolbar, row, actions, inspector, badge), mounted by `app/(authenticated)/imports/ImportsPaneBody.tsx`. the owners it reads: ingest (attempts, sessions, progress, the recovery policy), the media projection (`media_facts`: readiness, offers, restrictions, the metadata view), metadata (`metadata_operations_sql`), content indexing.

## concepts

- **import.** one row per thing brought in: web-recovery sessions retain their target `media:` row and never create `upload:` rows; otherwise `upload:<session id>` for every upload session the viewer created (kept after publication), `media:<id>` for each visible media with a source attempt or metadata job that none of the viewer's sessions published. a published session whose media the viewer cannot see is dropped.
- **obligation.** three independent nullable slots. source: the unpublished upload, else the latest attempt (a dead job of an unsettled attempt, or a failed attempt without a live job, needs attention; unsettled is active). search: a ready media's current index revision; completed ready/no-text/ocr-required outcomes win over queue settlement, otherwise a dead job needs attention and pending/indexing/live work is active. metadata: the metadata owner's view (the latest failed or unreviewed no-findings result needs attention; any unfinished job is active). null means nothing applies, not success.
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
| `GET /imports` | `view` (NeedsAttention \| InProgress \| History \| Recent), `q`, `media_kind`, `stage`, `failure_code`, `state`, `had_failures`, `from`, `before`, `cursor`, `limit` 1..100 = 50 | `ImportPage{matched_count, items, next_cursor}`; 400 `E_INVALID_REQUEST` for a filter the view cannot correlate (In progress: `failure_code`; Recent: `stage`, `failure_code`; any non-History view: `state`, `had_failures`, `from`, `before`), `failure_code` with `had_failures=false`, a date without an offset or an unknown parameter; 400 `E_INVALID_CURSOR` |
| `GET /imports/{ref}` | none | `ImportDetail{item, source_issues, related_imports, pending_captures, original_source}`; 400 for a malformed ref, 404 `E_IMPORT_NOT_FOUND` |
| `GET /imports/{ref}/history` | `cursor`, `limit` 1..100 = 50 | `HistoryPage{entries, next_cursor}`, newest first by `(occurred_at, id)`; 400, 404, 400 `E_INVALID_CURSOR` |

Recent is the viewer's own imports, every classification, newest accepted first: an
`upload:` row, or a `media:` row with a source attempt the viewer created, live or
superseded onto it, that is not a podcast transcript request. shared media,
metadata-only rows and a join of another reader's run in flight are not their
imports. it matches no obligation, so complete imports stay, and its `matched_count`
is the page's own, sparing a second pass over the read model. it orders by the
item's `accepted_at`, which for a `media:` row is its latest source attempt by any
reader: a superseded own import sorts at its winner's latest attempt, and another
reader's retry or refresh of a shared import lifts it.

`ImportItem{ref, media_id, title, original_filename, media_kind, source_label, can_read, can_play, text_search_ready, classification, primary, accepted_at, updated_at, matched_event, obligations{source, search, metadata}, source_issue_count}`; `primary` is null exactly when complete. source and search are `ImportObligation{classification, stage, status, waiting_reason, progress, next_retry_at, failure_code, recovery, unavailable_reason}` (status, waiting reason, progress and next retry describe active work, the code attention); metadata is `MetadataEnrichmentView`. `HistoryEntry{id: upload:|processing:|metadata:<uuid>, occurred_at, stage, failure_code, facts}` with `facts` one stored kind or `MetadataOperation`. a list cursor binds the viewer, the view and `ImportListQuery.normalized()`; a history cursor binds the viewer and the ref.

text readiness is derived from the current lexical publication, independent of
embedding completion. one search obligation narrates both capabilities. completed
ready/no-text/ocr-required publication wins over unfinished/dead queue settlement;
active/stopped semantic work cannot withdraw published text. completed absence of
text remains explicit in copy rather than claiming searchable content.

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

in process: `append_upload_event` and `append_processing_event` (caller's transaction, nothing returned), `delete_upload_history_in_current_transaction` and `delete_processing_history_in_current_transaction` (history dies with its session or media), `events_of_import_sql`, the queue hooks `on_source_job_outcome` and `on_index_job_outcome` (inside the job transition), `assume_safe_failure_code`, `queue_failure_code`, `parse_import_ref`, `format_import_ref`. web: `publishImportsInvalidation` / `subscribeImportsInvalidations` (the in-tab `Imports.Invalidated` event), `encodeImportsUrl` (a line's `see why`, the import page's shelf), `ImportsBadge`, the companion group `imports-inspector` with surface `import-detail`, `FAILURE_COPY` (the media banner) and the acquisition copy the intake, share, Connections and note attachments word their outcomes with.

url: `/imports?view&q&media_kind&stage&failure_code&state&had_failures&from&before&selected`, by wire name in one order; decoding is tolerant and keeps what the reader wrote; dates are UTC days, `[from, before)`; `selected` is admitted only as one `upload:` or `media:` path segment. no browser storage.

web-recovery sessions are relevant while unpublished, viewer-owned, eligible, and bound to the latest source attempt. the newest session narrates the source obligation: awaiting bytes is active at upload; verification failure and capability expiry need attention at validate and upload respectively. every awaiting sibling counts as unfinished work. `pending_captures` lists all relevant siblings newest first with their state, acceptance, expiry and failure code. advancing the source attempt removes them from this projection. history combines the media events, its original upload session if any, and all viewer-owned web-recovery session events. `original_source` supplies the original ordinary-web url and a query-free label; current attribution follows the published capture.

## invariants

- **I1** summary, page and detail apply the same classification rules; separate reads can observe different moments.
- **I2** a view never shows a filter it does not apply, and the web never sends one `GET /imports` refuses (`VIEW_FILTERS` is the one table); of a reason and "no recorded failures", the latest choice wins.
- **I3** every shown source or search code is catalogued (`SafeFailureCode`, which `FAILURE_COPY` is exhaustive over); a queue code outside it reads as `E_WORKER_HANDLER_FAILED`, and recording history never aborts a queue transition.
- **I4** history is written only by its owners' transactions through `import_history`, records nothing for a settled attempt or a deleted media, and decodes only the kinds it stores.
- **I5** a History row carries its matched event only when a newer event follows it; match evidence belongs to one ref under one applied query.
- **I6** the first view is chosen once from the counts; restoring a url never opens the inspector; explicit activation (a title, the Inspector control, Add's "view import") does.
- **I7** one command per import and command is in flight on its owner. refresh/research use the account's media-admission entry; other verbs use the action runtime (`media:<id>|<offer>`, `upload:<id>|RetryUpload|RemoveUpload`). the row, inspector and menu read that same busy state. upload refusals stay beside their originating control.
- **I8** list/history use the shared collection owner at 50 rows/page, publish each page and continue to source exhaustion while their pane is active and the document visible. history mounts only while open; a later match never reopens a collapsed history. reopening a restored history requests one coalesced reread when a summary observation exists, since the clock may have advanced while it was shut; a fresh first page does not schedule that extra read. polling runs every 5 s only while the newest summary succeeded, no summary read is running, work is unfinished, the tab is visible and an Imports pane is open or a wake is under 15 minutes old; a failed summary stops it until a wake. history reads only while open.
- **I9** a failed same-query reread keeps the last data beside its error (list, detail, history); a changed list/history query clears old rows and metadata. collection ids use first-occurrence-wins; refresh replaces the loaded prefix atomically and rereads complete collections to exhaustion. list `matched_count` is metadata from the latest committed page, including an empty page: it is an independent server observation, never a completion signal. the toolbar has no visible loaded/matched counters. qualified matched evidence stays inside the input’s described element and is never live-announced per page. actual import progress and recovery remain visible.
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

## intake

`lib/imports/intake.tsx` holds one document's lines: each one thing coming in, one identity
from enter until it is readable, behind every door. `lib/imports/lineView.ts` words a line
for every surface and for the intake's slips. nothing survives a reload.

- **provider.** `ImportIntakeProvider`, above the workspace boundary and keyed on the
  nullable account, owns the store, the send queue, creation and one document-local
  `import-intake` work owner. a real account change retires that whole lifetime; share
  passes null for its document without provisioning notes or inventing an identity.
  it publishes a defect and throws nothing.
- **host.** `ImportIntakeHost`, inside `ImportsProvider`, throws that defect in render, owns
  the one `useDestinationCreation` for `into`, reads truth, opens armed lines and raises
  slips. share has no host, so no truth: its accepted lines read `sent`.
- **admit** never throws: every outcome is a line, or its caller's `Field` (the caller
  parses with `extractLinks` and holds `ADMIT_LIMIT`). a link already listed adds none.
  type, emptiness, the size limits and create's name rule refuse a file before any request.
  an admission into the visit's `into` waits while a library create is sending, keeping that
  `into`. a created library joins the `into` of the visit its latest send began in, while
  that visit lasts, and that visit's waiting admissions either way: a create that outlives
  its visit never sets the next one's, and one retried in a later visit files for that one.
- **send.** enter's one `GET /libraries/destinations` freezes each line's guard: the removal
  revision and its libraries. a failed read is `no start`, or `offline`, and so is a send
  the shell's admission holds at its start, when no earlier send went unanswered. a held
  replay stays unknown: that attempt never left, but an earlier one may have landed.
  a held first confirm reads `couldn’t check the file.` with the transport's reason: the
  bytes are up and nexus was asked nothing. links go one at a time and file puts two at a
  time; a link's accept and an upload's confirm, both serializable under the viewer lock,
  take one slot between them. every send answers within 30 s, the put within its upload window.
  acceptance drops a file's `File`: nothing sends it again.
- **answers.** a line is unknown only where an answer was lost after the server could act:
  a link's accept, or a confirm. a lost answer before confirm published nothing: `upload
  stopped`. 401 and 426 answer before any route: handoff on a first send, still unknown
  after an earlier unanswered send. a storage failure at a first confirm published nothing:
  `couldn’t check the file`; after an unanswered confirm it is
  unknown. a refused create forgets the attempt's guard; a fence or library refusal at
  confirm opens it to review. an undeclared refusal reads `couldn’t import this.` and warns
  its request id.
- **replay.** `retry` sends the same id, guard and session again. `changed` takes one reread
  for the batch's changed lines and its waiting lines that replay no unknown, and `library
  gone` one for its own line, whatever the line's verb. a reread gives a link a fresh id.
  `offline`, `no start` and a held check send the batch's held lines again: a line holding a
  guard keeps it and its id, since an id only goes out with one guard; a line whose freeze
  failed rereads. `retryWithout` drops every library the refusal's reread found missing.
  `reselect` starts a fresh session; the expired one stays in imports.
- **truth.** for accepted, unsettled lines, on acceptance and each clock advance, one pass
  at a time, with membership frozen at its start: `GET /media/source-attempts/{id}` per link, two at a time, following
  supersession; `POST /media/summaries/resolve` over the media ids, 100 a request; and for
  a failed or dead run one `GET /imports/{ref}`, which decides readable, the reason or
  removed. each read answers within 30 s. a line whose own read fails sits the pass out,
  holding no other back; a failed summaries read fails the pass. either waits for the next
  advance. new arrivals wait for the next pass; summaries use the included lines' current
  identities after their source reads. the host retains the observer while any accepted line is unsettled.
- **slips.** a batch wholly settled while the controller does not show lines
  raises one slip through `useOutcome().say`; with an unknown line it holds one, whose
  `retry` replays that batch's unknown lines. a batch that settles while a surface shows
  lines never slips, then or later: that surface speaks its settle. opening owns the
  presentation before admission, including immediate refusals before the page mounts;
  deferred admissions use the same current decision when they settle.
- **settlement date.** the intake records when it first observes a wholly settled batch,
  not the server's completion time. the page's displayed and spoken colophon use that
  instant in the reader's zone. edits, back and partial dismissal retain it; retrying an
  unsettled batch drops it until settlement recurs. a batch with no remaining lines and
  account teardown discard it. published snapshots keep their timestamps immutable.
- **`×`** removes a waiting or settled line. forgetting an unknown line, or a waiting replay
  of one, asks `window.confirm` first, since either may have landed.
- **visit.** the intake owns the field, its attempt feedback, destinations and whether a
  nonempty admission was made. admission marks the visit even while library creation holds
  it; draining that admission later changes no later visit's facts. explicit field
  replacement and new file admission clear attempt feedback; the link sieve owns its
  remaining-prose feedback.
- **disarmExcept** retains only an explicitly selected line's open intent and clears every
  deferred open intent. input, a drop and leaving the import page pass no selected line.
  this retires navigation, never an admission or its frozen filing destinations.
- **endVisit**, on the palette's close edge, resets the visit and disarms opening; readable,
  superseded and removed lines leave. everything else stays until `×`.
- **surfaces.** the controller publishes whether the [import page](app-navigation.md#the-import-page)
  is open before any admission or close publishes into the intake; nexus's root reads
  only `unsettled`. nexus's back table reads the intake's visit admission fact; it owns no
  second send flag. arrow back keeps the visit, including its field feedback.
- **speech.** `useImportPresentation` observes consecutive synchronous intake publications,
  not rendered row order. binding starts from existing history; cleanup unsubscribes before
  releasing presentation ownership. while the import page is open, its one polite owner publishes starts and
  outcomes. unpublished sentences combine in order with repeats preserved; acknowledgement
  follows the exact occurrence's committed live text. leaving the page retires pending
  speech. returning or replacing the responsive presentation never replays old settlements.

### document doors

`components/imports/ImportDoors`, mounted beside Nexus's desktop/mobile branch, connects
window bubble events to its existing admission and batch-start announcement. the topmost interaction owner alone decides
whether a drop can enter the import page; its semantic marker must be inside that exact
owner. an exposed import page keeps its origin, draft and destinations. an outside drop
opens it through the ordinary intent, retaining the actual opener.

claimed events, editables and other overlays keep their input. internal drags never import.
every remaining unowned file drop prevents browser navigation, including a refused drop;
native file inputs keep their default. the pointer-only veil hides on ownership loss,
root leave, cancellation or blur. a whole explicit-url paste outside input and overlay
owners opens a root draft, never sends. the existing parser owns what counts as a link.

doors reject more than 100 files into the visit's field feedback without admitting any.

### accepted-source pane

the first attempt read shows a `Ruling`; an accepted unsettled source shows its waiting
fact and `all imports`. only a settled identity replaces the route with its reader;
an exact dead source job settles identity without declaring content usable or successful.
explicit repair, retry or refresh can reopen identity work.
that passive replacement preserves the active pane and its open controls. the
poll returns its read promise, so a slow source read completes before another starts.
the read's busy state gates polling across pane visibility changes as well.
missing or invalid attempts show their refusal and `all imports`; other read failures
compose the import fact with the shared transport reason and actionable remedy.
the body publishes a pointer title role. the shell uses the current visit's retained
hint, with its existing 512-character bound; an unhinted visit keeps its ordinary title.
readable intake lines retain their source pointer on this handoff too. the body withdraws
its role when the ordinary reader takes ownership.
the rail reads unsettled work from the intake; a library door supplies that library's
destination through the same navigation intent.

- **I11** one acquisition step (a link's accept or an upload's confirm) is in flight per intake.
- **I12** a line once unknown keeps its frozen id, guard and confirmation until an
  authoritative refusal permits `changed` or `library gone` review, or a reselect
  re-freezes it. refreezing retires that confirmation and its uncertainty; every retry before then, a held
  send's included, replays them, never a fresh read. an unsent or pre-route-refused retry
  preserves that uncertainty and its dismiss confirmation.
- **I13** `running` counts waiting, sending, uploading and verifying lines; `unsettled` adds
  accepted lines not yet readable, failed or removed. the work owner stops browser work while
  `running` is positive and is unconfirmed while a line sends, verifies or is unknown.
- **I14** with no lines the intake sends nothing and holds no timer or observer.

## standalone share

`app/share/ShareCapture.tsx` reads `/_nexus/shared/manifest` before offering admission.
only the actual share activity answers 200 with its indexed file metadata; hosted
documents and the main activity answer 404. the manifest owns automatic admission,
native `capture_*` metadata and `nexus-share` exits. a bridge or route supplies none
of that authority. main's standalone document initializes its existing native hello
and subscription; the manifest never changes remote admission.

manual cards require a press for links and plain text. links and named files admit
through the same intake into implicit all, without a host, destination picker or
slips. a native stream's 404 is an unreadable null-file line; it never acquires.
files exclude plain capture and the empty-share state; accompanying prose is ignored
while links remain. each stream has a bounded read, cancelled with its document;
failed reads use the existing failed-read repair owner.
absent native name, size or mime type stays null in the manifest. the File boundary
uses its standard empty name/type, and actual readable bytes supply File.size.
unreadable entries retain unknown size; no zero or filename is invented. the existing
admission order groups links, readable files and unreadable entries, preserving order
within each group rather than across a mixed manifest.

only a nonempty admitted set whose every retained line is accepted closes the native
card. refusal and uncertainty remain; ordinary browser/main acceptance keeps the
card until done. without a truth host, accepted neighbors read `sent` and no current
share line can offer `see why` or `open original`. real ambiguous and auth refusals
retain their import and sign-in routes. exits use ordinary workspace paths unless
the manifest established the actual share activity.

plain text keeps its authored command, first-send date/id and exact retry handle;
actual sharing retains its native capture identity. its standalone authored provider
receives an explicit workspace return action for recovery. ordinary done/cancel go
home; authored recovery opens downloads, whose workspace owns sign-in and setup.

## acquisition recovery

[ingest](ingest.md) owns guarded admission, upload publication, receipt lifetime
and current-reference supersession; [libraries](library.md) owns retention and
placement revisions. import views never infer current saving from a past receipt.

the intake owns live upload recovery (`replay` above). an authoritative guard refusal permits
review against the same staged generation before expiry; an unknown confirmation
retains its exact command. losing that owner requires file reselection/recapture.
imports exposes its existing retry-upload action rather than durable confirmation
recovery or a second placement command owner.
