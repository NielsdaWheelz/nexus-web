# Imports workspace hard cutover

Status: proposed; implementation and runtime verification NOT_RUN. Desktop first.

## Contract and scope

Replace the Activity task with one `/imports` workspace pane: **Needs attention**, **In progress**, **History**; stage-grouped rows; selected-item inspector; precise recovery. The badge counts `NeedsAttention` imports, including failures without an eligible retry; never executions or ordinary background work. History includes successes and earlier failures.

Follow [docs/rules](../rules/index.md) and [Nexus testing standards](../local-rules/testing-standards.md), especially §§3–10, 13–14. The Nexus-specific dominant-middle proof policy controls over generic E2E-heavy guidance. This spec intentionally replaces Activity's history/filter/pagination exclusions and [navigation](../modules/app-navigation.md)'s Account badge/task-only contract.

In scope: upload sessions, source ingestion, document content indexing, their retained evidence, existing resource actions, web navigation. Metadata/transcript-semantic processors retain their owners and policies; this pane must not claim their completion. No native changes.

Non-goals: kanban, drag-to-status, bulk actions, arbitrary parser checkpoint replay, universal restart, new workflow engine/queue, SSE, AI-generated explanations, saved-view builder, notifications/read receipts, deleted-content archive, unrelated cleanup. Existing source refresh remains a resource action; do not invent a new refresh workflow.

## Target behavior and content

- Desktop: Imports utility action beside other utilities, independent of Account; list plus persistent right inspector using existing pane primitives. Nexus resolves the same destination. Mobile: existing account entrance → same pane, list → detail → Back.
- First unqualified entry selects attention if nonempty, otherwise active if nonempty, otherwise History. Explicit URL state wins. Live updates never switch the chosen view or close the selected inspector.
- Attention: group by stage, oldest unresolved failure first within groups; hide empty groups. Active: newest accepted work first; show queue/capacity/backoff distinctly. History: one row per import, most recent matching evidence first; attempts expand in the inspector.
- Filters: search title/filename/source, media type, stage, reason; History additionally current `state=Active|NeedsAttention|Complete`, `had_failures`, dates. History includes all three current states. Attention has no default age cutoff. History defaults to a visible 30-day filter; this is not retention.
- Historical stage/reason/date must match **one event**, using a correlated predicate. `had_failures=true` requires that matching event be a failure, even if later recovered; `false` means no recorded failures, not proof of a failure-free past. A reason filter implies failure-event matching and contradicts `had_failures=false`. Show matching evidence beside current outcome. “Failed during” filters failure time; ordinary History dates mean “Recorded during.” Bounds are UTC `[from,before)`.
- Open remains available when supported despite search failure. Successful recovery removes attention and retains history; selected detail shows the transition. Viewing/refreshing never acknowledges, dismisses or clears an obligation.
- Never infer failure from age, infer OOM, invent ETA/percentage, merge Finalize into Extract, or present a stage observation as a checkpoint. Non-document work without fine-grained evidence says **Source processing**.

The assigned content designer owns the following rubric for every feature. Implement deterministic templates in the shared status-copy owner; use typed facts, existing plural/time helpers, and the existing finite error catalog. No parallel reason dictionary. Unknown same-system variants/codes defect; expected absent evidence has an explicit schema state.

| Feature / designer role | Required content | Good means |
| --- | --- | --- |
| Navigation / information design | `Imports`; `3 need attention · 2 in progress`; accessible exact attention count | Badge has one meaning; zero hides it; unloaded is not zero; cap visual count at `99+`. |
| Rows / status design | `Extraction failed`; `Waiting for capacity`; `Waiting to retry`; counted pages/chapters when recorded | Title, stage, reason, age align; one short status and reason; no repeated pipeline diagram. |
| Filters/history / retrieval design | `Had failures`; `Matched: Extraction failed · Sep 6`; separate current outcome | Explain why a currently successful row matched; select its matching historical attempt. |
| Inspector / explanation design | Consequence → recovery scope → attempts → safe diagnostics | “Search indexing failed. You can still read this document” requires readable capability. |
| Recovery / action design | `Retry upload` / `Choose the original file`; `Retry source processing`; `Retry stopped processing`; `Rebuild search index` | Scope states reused input and repeated work; pending is `Starting…`, never `Fixed`; interruption requires recorded evidence. |
| Empty/partial / onboarding design | `No imports need attention`; `No imports match these filters` + `Clear filters`; `Detailed execution history was not recorded` | Describe this view and actual evidence coverage. |
| Freshness/conflict / feedback design | Last observation time; `Couldn’t refresh imports. Showing the last update`; `This import changed. Review its current status` | Preserve last-good facts and focus; fresh server checks govern mutation. |

Use existing design tokens, shared controls and a real badge element. Verify legible counts, long titles, contrast, zoom, keyboard focus and restrained polite status announcements. Do not require hover or color alone to understand state.

## Ownership, schemas and composition

```text
upload/source/index/queue owners → committed domain facts + history
                              → one Imports query/classification owner
                              → strict API → Imports provider/query hooks
                              → utility badge + pane + inspector
recovery offers → existing resource-action runtime → domain command → invalidation
```

Retain the existing Postgres queue, source publication/lease fences, upload verification/digest checks, capacity policy and resource lifecycle. Activity's source-before-index classification remains authoritative. Query code composes owner read interfaces; it never creates a second execution state machine. Counts and membership use the same classification. Mutation eligibility and capability projection use the same owner policy.

Wire notation below is normative; use Pydantic `extra="forbid"`, exhaustive unions and existing `Presence<T>` throughout owned data. Raw DB nulls convert at ingress. Reuse existing media kinds, `SourceProgress`, safe codes and resource refs.

```text
ImportRef = "upload:<session_handle>" | "media:<media_id>"
Stage = Upload | Validate | Extract | Finalize | Index | SourceProcessing
ImportState =
  Active { status: Queued|Processing, stage,
           waiting_reason: Presence<Queue|Capacity|RetryBackoff>,
           progress: Presence<SourceProgress>, next_retry_at: Presence<Instant> }
  | NeedsAttention { stage, failure_code: Presence<SafeFailureCode> }
  | Complete
ImportItem = { ref, title, media_kind, source_label: Presence<Text>,
  media_ref: Presence<MediaRef>, state, accepted_at, updated_at,
  matched_event: Presence<HistoryEntry>, capabilities }
Capabilities = { can_open, can_remove, recovery: Presence<RecoveryOffer>,
                 unavailable_reason: Presence<ModeledRecoveryRestriction> }
RecoveryOffer = RetryUpload { expected_generation, input: ChooseOriginalFile }
  | RetrySource { expected_attempt_id, input: StoredSource|RefetchSource }
  | RepairSource { expected_attempt_id, expected_job_id,
                   input: StoredSource|RefetchSource }
  | RepairSearch { expected_revision, expected_job_id, input: PublishedContent }
ImportPage = { observed_at, matched_count, groups: [{stage,count}],
               items: ImportItem[], next_cursor: Presence<Cursor> }
ImportSummary = { observed_at, needs_attention_count, active_count }
ImportDetail = { item, readiness: {can_read,can_search,can_play},
                 history_coverage: Full|Partial{recorded_since} }
HistoryPage = { entries: HistoryEntry[], next_cursor: Presence<Cursor> }
```

`Complete` means this projection's source/index obligations settled, including existing no-text/OCR outcomes; readiness remains independent. Deduplication retains existing merge/deletion semantics: a deleted losing selection says `This import is no longer available`; do not invent a retained redirect. Preserve supersession events only while their owner survives. Reuse explicit source-policy restrictions for deterministic input rejection; missing diagnostic evidence is not an unrecognized-code fallback.

Upload-origin imports keep their upload reference after publication through the existing unique `published_media_id` link. Exclude those media from the standalone Media branch. Detail merges upload history with linked media history; publication does not duplicate a row/count or lose selection. Other imports use canonical media identity. Preserve existing visibility/owner authorization on every query and action.

Add two lifecycle-owned append-only tables, **`media_upload_events`** and **`media_processing_events`**. Each has `id UUIDv7 PK`, respectively `session_id FK` or `media_id FK`, `occurred_at timestamptz`, `event_type`, nullable `stage`/`failure_code` query columns, and a **closed typed** `payload JSONB`. Payload contains only branch-specific facts; do not duplicate indexed envelope fields or add generic metadata.

Events: `Accepted`, `ExecutionStarted`, `StageChanged`, `RetryScheduled`, `Failed`, `RecoveryAccepted`, `Published`, `Succeeded`, `Superseded`, `HistoryBaseline`. Source payloads name source attempt and execution; index payloads name revision, job and execution; upload payloads name generation. Failure payloads distinguish execution versus domain failure and automatic retry versus terminal outcome; queue success never implies source success. Store safe codes and counted progress at failure, never raw errors, signed URLs, source content or secrets. `HistoryEntry` exposes these typed facts and safe references, not raw payload dictionaries.

- Allocate a non-resetting execution UUID in the queue claim transaction; persist it on `background_jobs`, carry it in `JobExecutionContext` and event payloads. Preserve existing lease fencing. `(job_id, queue_attempts)` is not unique across repair.
- Record facts at existing owner transitions, atomically with the fact they document; committed failure without its required history is invalid. Shared history writers are transaction-scoped helpers with no commit, scheduling or domain-policy authority. Queue envelope outcomes use the existing domain-projection seam. Record stage changes once; omit heartbeat/progress-tick history.
- Add owner/time/id indexes for these actual queries. Use schema-owned keys/FKs/uniqueness only; application code validates event variants/correlations. No business `CHECK`, trigger or cascade.
- Migration retains all resources/attempts and records a baseline containing only extant facts. Baseline time is recording time, never an invented failure time; it cannot satisfy a dated historical-failure query without actual failure-time evidence. Baseline coverage is `Partial`; new imports record from acceptance. No old/new decoder paths.
- Preserve compact facts for owner lifetime, independent of queue pruning. Existing dead source/index retention stays intact. Explicit teardown deletes history before its owning rows; no archive of deleted content. Existing historical attempts remain readable even when precise execution details were never recorded.

## API and recovery admission

Replace the Activity read endpoint; standard authenticated BFF forwarding and response envelope remain.

| Endpoint | Contract |
| --- | --- |
| `GET /imports/summary` | Global counts independent of list filters. |
| `GET /imports` | `view=NeedsAttention|InProgress|History`; optional `q,media_kind,stage,failure_code,from,before,state,had_failures,cursor`; `limit` default 50, range 1–100. Reject unsupported combinations; returns `ImportPage`. |
| `GET /imports/{ref}` | URL-encoded canonical ref; current detail survives leaving the list filter. |
| `GET /imports/{ref}/history` | Cursor-paged attempts/events, newest first; same visibility as detail. |
| `POST /media/uploads/{handle}/retry` | Existing immutable file-intent fields plus required `client_mutation_id,expected_generation`. |
| `POST /media/{id}/retry` | Source variant: `from_stage=source,client_mutation_id,expected_attempt_id`. Existing metadata variant remains separately owned and unchanged. |
| `POST /media/{id}/repair` | Required `client_mutation_id`; closed Source `{expected_attempt_id,expected_job_id}` or Search `{expected_revision,expected_job_id}` variant. |

Reuse `signed_keyset_cursor.py`; bind cursors to viewer, normalized filters and total ordering. Attention order is stage rank, failure time, ref; active order accepted time descending, ref; History order matching-event time descending, ref. Tie-break every order. Counts/groups cover the full query before limiting; each response uses the existing repeatable-read boundary. Pagination is live: invalidation restarts continuation while preserving selected detail; changed-filter cursors are rejected. Do not promise cross-request snapshot isolation.

All recovery offers are mutually exclusive for the current obligation. Commands recheck visibility, ownership, exact inspected identity and owner policy. Terminal source failure uses new-attempt retry only when policy permits; same-job Source repair requires a nonterminal source attempt and its exact dead job. Move that decision into the source owner; delete unconditional dead-job-is-repairable classification. Search repair never repeats source extraction. Existing metadata Uncertain/billed-effect restrictions remain inviolable.

Reuse `resource_mutation_replay.py` within the owner's serializable admission: authorization → serialize replay identity/lookup → on first admission lock/check target → domain change + required history + durable enqueue/repair + replay receipt → commit. Exact replay returns the original admission; same key/different request conflicts; fresh stale identity returns `409 E_RESOURCE_CONFLICT` without mutation. No external call inside a DB transaction. Reuse source's `enqueue_accepted_source_attempt_in_transaction`; a crashed HTTP caller must not strand accepted recovery.

Source/Search return `202` with an immutable typed admission identifying the accepted attempt/job. Upload keeps its upload-required contract: memoize admitted generation/expiry, not signed URLs; mint only that generation's capability outside the transaction without extending its original expiry. Expired/superseded generation returns the corresponding modeled outcome; another renewal requires a fresh explicit command. Remove the old source-retry header/body form at this endpoint; other source-creation idempotency contracts are out of scope.

Reuse `usePaneUrlState`, `useResource`, `useCursorPagination`, existing single-flight invalidation and resource-action dispatch. One provider owns summary and wake signals; query hooks own filtered pages/detail. Keep five-second observation while pane/document is visible and known work active; bounded 15-minute observation when pane is closed, pause hidden-document polling, stop on settled work. Failed refresh keeps last-good data and uses existing manual/lifecycle recovery. Document this `justify-polling`; do not add a second poller. Key mutation pending state by target/command, not one page-global slot.

## Work split and files

Paths below are ownership sets, not permission for adjacent cleanup. Agree DTO/helper signatures first. Shared files have one editor; other tracks request that owner's change. New narrow files are marked `new`.

| Track | Exclusive files/responsibility |
| --- | --- |
| A — history storage / migrations | `python/nexus/db/models.py`; one Alembic migration; `services/import_history.py` (new), `schemas/import_history.py` (new); migration proof. Own event schemas, append/read helpers, baseline and cleanup interface. |
| B — execution / recovery | `jobs/{queue,worker}.py`, execution-context carriers; `services/{media_upload_sessions,media_source_ingest,source_publication,source_attempt_failures,ingest_recovery,media_retry,media,capabilities,content_indexing,media_deletion}.py`; relevant task/dead-letter adapters. Own history emission, execution identity, recovery policies/admission and explicit teardown. No API/UI editing. |
| C — query / transport | Move `services/media_activity.py` to `services/imports.py`; move Activity schemas/route to Imports owners; source/upload request schemas in `schemas/media.py` and adapters in `api/routes/media_ingest.py`; API router registration; Imports/recovery BFF routes. Own strict DTOs, shared classification, filters/counts/cursors/auth, query proof. |
| D — browser data / actions | Move `lib/media/{activityClient,MediaActivityProvider,activityPolling}*` into `lib/imports/`; `ingestionClient.ts`, relevant `lib/actions/resourceAction*` callers, authenticated provider composition. Own decoding, URL contract, refresh, replay IDs, exact offers and pending state. |
| E — product / content | `components/imports/*` (new); consolidate `lib/status/mediaActivity.ts` and shared `lib/media/mediaErrorMessage.ts` into one error/copy authority per concern; retire old Activity page/CSS. Own table, inspector, content rubric and Chromium proof with D's real provider. |
| F — integration / cutover | New `(authenticated)/imports/{page,ImportsPaneBody}.tsx`; pane route/module/render registries; navigation destinations/AppNav/Account; Nexus intent/controller/render integration; `testdata/{proofs.json,faults/manifest.json}` and affected faults; existing ingest journey; owner docs. Own one canonical entry, routing, proof selection and removal inventory. |

Dependencies: A/C contracts → B/D in parallel → E → F integration. A–F describe edit ownership; the proof boundaries below describe independent risks. Content designer review covers every E feature before fixtures become the oracle.

## Acceptance and 80/20 proof plan

One canonical proof owner per boundary; use named cases inside it, not duplicated suites. Reuse/adapt existing upload/activity/ingest proof before adding files. Register exactly one canonical priority node per physical owner path and at most one representative fault per proof. Ordinary edge cases stay at their owning boundary.

| Boundary / canonical owner | Target behavior and red oracle |
| --- | --- |
| Migration/history — `python/tests/migrations/test_imports_history_migration.py` (new) | Empty/supported baseline → head preserves resources; real partial history stays partial; recording/teardown/pruning ownership is correct. Red: omitted baseline/required history preservation. |
| Upload — existing `python/tests/service/test_media_upload_sessions.py` | Real PostgreSQL/MinIO: duplicate admission advances once; stale generation cannot affect newer upload; publication keeps one import identity; failed upload history survives retry. Red: generation/replay fence removed. |
| Source — `python/tests/service/test_import_source_recovery.py` (new) | Real PostgreSQL + real worker: terminal retry does useful work; valid interrupted repair reruns the documented source boundary; stale/double commands cannot create wrong work; execution failures survive repair and success. Red: current terminal-repair defect or equivalent owner fault. |
| Index — `python/tests/service/test_import_index_recovery.py` (new) | Real PostgreSQL + real worker: exact index recovery restores search while source/content identity is preserved; stale revision/job rejected. Red: revision fence bypass. |
| Query/API — adapt existing `python/tests/service/test_media_activity.py` to Imports owner | More than 20 imports reachable; global/filtered counts agree; no cross-viewer disclosure/double count; recovered failure found; old Extract + recent Index does not match recent Extract. Red: before-limit filtering or same-event correlation bypass. |
| Browser — `components/imports/ImportsWorkspace.browser.test.tsx` (new, replaces Activity owner) | Real Chromium/provider with schema-valid HTTP stubs: badge semantics, filter/Back/selection, matching-history context, independent pending actions, stale reads, visible work beyond 15 minutes, keyboard/zoom/long titles. Red: selected representative target behavior against base/fault. |
| Wiring — existing `durable-ingest-reader-open.journey.spec.ts` | Extend its existing import lifecycle to enter Imports, inspect and observe a real recovery outcome through browser/BFF/API/worker. Retain its unrelated critical signals; no second journey or repeated edge-case matrix. |

Use independent fixtures/content rubric as oracle. Baseline with `./scripts/test changed <owner>`; write target behavior and capture red; implement green; prove sensitive fixes/replacements with `./scripts/test prove --proof <node> --against base:<ref>` or the registered fault; refactor and rerun affected `changed`. Finish implementation with required `confidence`/`pr` selection, one heavy lane at a time. No paid providers, device dependency, owned-code mocks, sleeps, retry-to-green, snapshots of implementation output or new performance platform. One deliberate desktop visual/assistive review complements component proof. Record exact SHA, command and `pass|fail|not_run`; this document claims none of them passed.

## Final state and trade-offs

Delete `/media/activity` and its BFF, former Nexus Activity task/intent/page, Account total-open badge, old decoders/types/styles, replaced repair admission, duplicate copy/polling/action paths and retired tests/faults. Update every caller and relevant owner doc atomically. Preserve priority-risk proof until its sensitive replacement passes. No flags, aliases, dual responses, fallback readers, backwards-compatible payloads or permanent source-grep tombstones. Unrelated consumption Activity stays intact.

Deploy the incompatible web/API/worker/schema set in an explicit maintenance window with forward migration, readiness and isolated smoke. Update rollback artifact compatibility explicitly; no migration downgrade or destructive rollback promise. This plan authorizes no deployment or production mutation.

Accepted trade-offs: a pane/utility entry costs navigation work; grouped rows defer spatial board overview; full source retry can repeat parsing; two narrow event tables add transactional recording but preserve different owner lifetimes; old precise history and deleted deduplication losers are unavailable; visible active polling adds bounded-per-interval reads; live pagination refreshes on change; metadata/semantic coverage and bulk recovery are deferred. These limits preserve the requested small feature set and its correctness boundaries.
