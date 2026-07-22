# Default Library Virtualization & Transient State Pruning — Hard Cutover

**Status:** IMPLEMENTED · Rev 2 · 2026-07-16 (implemented 2026-07-17)
**Type:** Hard cutover — no legacy paths, fallbacks, dual reads/writes, feature flags, or backward compatibility.

**Resonance supersession (2026-07-21):**
[`resonance-reading-slate-hard-cutover.md`](resonance-reading-slate-hard-cutover.md)
removes `viewer_tz`, Surfaced Today, and the root entry engagement field; moves
non-default Resonance ordering to `services/resonance`; and hard-cuts the cursor
kind from `library_entries:resonance:v1` to `library_entries:resonance:v2`.
The default live personal-All and consumption-owner recency facts remain
canonical.

## 0. Sequencing — mandatory

This cutover lands **after** merged Lectern (`604dbed6`) and Alembic `0182_lectern_player_lifecycle`.

- New migration: `0183`, `down_revision = "0182"`. If another migration reaches `main` first, renumber/rebase; never branch before `0182`.
- Lectern remains normative for player lifecycle. This later cutover supersedes only its `reading_sessions`/dwell ownership, heartbeat dwell composition, four-family teardown, and related file/gate clauses.
- Do not edit migrations `0172`, `0180`, `0181`, or `0182`. Historical migration tests must target their revision, not assume their tables survive at `head`.

## 1. Decision

Drop these eight tables:

1. `library_entry_page_snapshot_items`
2. `library_entry_page_snapshots`
3. `reading_sessions`
4. `message_retrieval_candidate_ledgers`
5. `message_rerank_ledgers`
6. `default_library_backfill_jobs`
7. `default_library_closure_edges`
8. `default_library_intrinsics`

Add one narrow current-state table, `reader_engagement_states`, to preserve user-visible document recency without retaining attention history. Net result: **seven fewer tables**, no raw session/candidate/rerank history, no closure jobs, and no stored page snapshots.

The real default `libraries` row and its direct physical `library_entries` remain. Its read surface becomes a live, deduplicated **personal All** query across non-system memberships. Sharing, subscriptions, citations, Undo, web, Android, and the extension remain supported.

## 2. Capability contract

| Surface | Final behavior |
|---|---|
| Media authorization | Any physical media entry reachable through a current membership, including system libraries, minus `user_media_deletions` and armed teardown media. |
| Default / My Library | Direct default media plus media reachable through current **non-system** memberships, deduplicated and viewer-hidden rows removed. System-only Oracle works do not leak into My Library. |
| Non-default library | Existing physical media/podcast entries, sharing, roles, and manual order. |
| Invite/revocation | Membership commit immediately adds/removes shared media from My Library; no backfill or repair. |
| Capture/filing | Direct default intent always creates/keeps a physical default entry, even when the media is already virtually present. |
| Default ordering | Server-defined `(media.created_at DESC, media.id DESC)`; no reorder UX or guarantee. |
| Pagination | Stateless keyset cursors; no frozen snapshot and no `OFFSET`. |
| Resonance | Rejected for Default; retained for physical non-default libraries with a pinned `resonance_as_of` keyset cursor. |
| Reading | Explicit override wins; otherwise current reader engagement/progression. No sessions, devices, spans, or dwell history. |
| Listening | Lectern CAS heartbeat and listening state remain; raw dwell/device fields disappear with `reading_sessions`. |
| Chat retrieval | `message_retrievals` is the sole durable per-result record. Candidate selection/rerank execution is transient. |
| Chat replay | Chat-run/SSE/idempotency replay stays. It is not rerank telemetry. |

## 3. Goals, rules, and boundary

### Goals

- One owner and one path for media readability, library-set reads, entry writes, consumption projection, and retrieval truth.
- Preserve supported user journeys while deleting derived, duplicate, expired-purpose, and debug-only state.
- Make Default-scoped list/count/search/resource/Library Intelligence consumers use one set contract.
- Keep the implementation proportional to a one-user prototype without creating a three-month dead end.

### Rules

- `docs/rules/{simplicity,cleanliness,boundaries,database,concurrency,testing}.md` govern.
- SQL owns set filtering, dedupe, ordering, and keyset predicates. Services own policy and mutations.
- One public actor command per filing capability; strict wire shapes; no ignored removed fields.
- The media-teardown barrier runs before every physical media-reference insert and before the library lock.
- Tests assert public behavior. Static gates prove deleted concepts are absent; they must not silently pass because an allowlisted file was deleted.

### Non-goals

- No deletion/redesign of users, memberships, invitations, conversation sharing, subscriptions, billing, `user_media_deletions`, citations, `resource_edges`, `message_tool_calls`, `message_retrievals`, chat replay, or Lectern state.
- No materialized Default view, cache, repair/reconciliation job, replacement history ledger, generic cursor framework, or speculative index.
- No native Android API redesign; Android remains the web shell plus share intent. The extension remains capture-only.
- No redesign of non-default ordering, resonance scoring, podcast placement, or trust inspector outside removal of dead candidate/rerank sections.

### Accepted 80/20 losses

- Existing snapshot cursors fail `E_INVALID_CURSOR` after deploy.
- Default rejects `sort=resonance`; its UI does not offer it.
- Live pages reflect concurrent deletes/reorders/score-signal changes. Keyset prevents insert-above duplicate/omit for an unchanged order but is not a historical snapshot.
- Raw reading episodes, dwell totals, devices, spans, `attention_on_day`, and the 30-second/2-minute dwell classifications are irreversibly deleted. A document previously finished only by two-minute dwell becomes in-progress; any retained engagement row now means in-progress. Explicit state and whole-document progression remain.
- Historical candidate/rerank passes and mismatch notices are irreversibly deleted.
- A legacy direct-default action represented only by a closure row is not recoverable as direct intent; the migration rule below is authoritative.

## 4. Final architecture

### 4.1 Readable media is not My Library

`auth/permissions.py:visible_media_ids_cte_sql()` is the sole authorization/global-readable relation:

```text
DISTINCT library_entries.media_id
JOIN memberships ON membership.library_id = entry.library_id
WHERE membership.user_id = viewer
  AND media_id IS NOT NULL
  AND NOT EXISTS user_media_deletions(viewer, media_id)
  AND NOT EXISTS media_teardown_intents(media_id)
```

It includes system libraries and excludes armed teardown media from every public surface. `can_read_media()` is its scalar twin. Intrinsic and closure branches die.

`services/library_entries.py:library_media_ids_cte_sql()` is the sole library media-set relation; every branch also applies viewer deletion and teardown visibility:

- viewer-owned Default: the relation above constrained to `libraries.system_key IS NULL`;
- non-default member library: that library's physical media entries intersected with global readability;
- otherwise: masked not-found.

Default list/count, Default-scoped search, resource summary, Library Intelligence, and Atlas consume this personal relation. Global authorization and unscoped search retain the broader readable relation; exact conversation-share search remains exact and is not widened across memberships. Podcast-scoped cells remain physical.

### 4.2 Default rows and keyset pagination

Default candidates are accessible non-system physical media entries. SQL deduplicates by `media_id`, preferring a direct default entry, then deterministic earliest `(entry.created_at, entry.id)`. The API returns that real representative entry; the web list keys Default rows by `media.id`.

Fetch `limit + 1` after visibility/dedupe. Strict, discriminated opaque cursors are base64url JSON bound to viewer, library, and sort:

- Default: `{k:"library_entries:default:v1", viewer_id, library_id, sort:"position", after_media_created_at, after_media_id}`.
- Non-default position: `{k:"library_entries:position:v1", viewer_id, library_id, sort:"position", after_position, after_entry_created_at, after_entry_id}` for `(position ASC, created_at DESC, id DESC)`.
- Non-default resonance: `{k:"library_entries:resonance:v1", viewer_id, library_id, sort:"resonance", resonance_as_of, after_score, after_entry_id}` for `(score DESC, id DESC)`.

Next-page predicates are lexicographic over the named order. `resonance_as_of` is generated once and carried unchanged; current connection/engagement mutations remain intentionally live. Default `sort=resonance` returns existing `E_DEFAULT_LIBRARY_FORBIDDEN`.

### 4.3 Entry mutation and teardown ownership

`library_entries` owns all `library_entries` DML and physical reference counting.

The one actor-authorized filing command used by REST and `agent_tools/writes.py`:

1. validates the target and authorizes readable-or-restorable media; restorable means membership-reachable while ignoring only that viewer's tombstone;
2. for media, locks the media row and rejects teardown intent;
3. locks/revalidates the library membership, requires admin, and rejects system destinations;
4. rejects podcast → Default and requires an active subscription;
5. inserts/checks the physical entry;
6. clears `user_media_deletions` even when the physical entry already exists;
7. inserts direct Default intent even when virtual membership already exposes the media;
8. returns an inserted-only boolean outcome (`false` means already present) for
   Undo correctness.

A narrow trusted system command serves Oracle seeding. Both call one private insertion primitive. For media, that primitive always calls existing `raise_if_media_teardown_pending()` before the library lock; the barrier stays in `library_entries.py`. Closure deletion must not delete or bypass it.

Media teardown counts physical `library_entries` only. Creator-first makes teardown observe a reference; teardown-first makes creation fail `E_MEDIA_DELETING`. No closure count/purge/detach helper survives.

Viewer deletion is truthful: system-only media is non-deletable; controlled non-system entries are removed; a remaining non-system shared path produces `Hidden` plus `user_media_deletions`; only system references remaining produces `Removed` without a hide marker. Corpus data is never deleted through a viewer action.

### 4.4 Consumption in the post-Lectern world

There is already a `services/consumption/` package and `schemas/consumption.py`. Do not rename into either path.

- Delete `services/attention.py` and `schemas/attention.py`.
- Fold projection/recency into existing `consumption/_projection.py`; expose it only through `consumption/service.py`.
- Add internal storage owner `consumption/_reader_engagement_store.py` for `reader_engagement_states`.

`reader_engagement_states` is one current row per `(user_id, media_id)`:

```text
id UUID PK (application-generated UUIDv7)
user_id UUID non-cascading FK NOT NULL
media_id UUID non-cascading FK NOT NULL
created_at timestamptz NOT NULL DEFAULT now()
last_engaged_at timestamptz NOT NULL
max_total_progression real NULL
UNIQUE (user_id, media_id)
```

It stores no session, device, span, dwell, or event list. Writes use database `now()` and application-validate progression in `[0,1]`. A valid reader save touches `last_engaged_at`; non-PDF `locations.total_progression` advances `max_total_progression`. A same-locator save touches engagement without changing cursor `revision` or cursor `updated_at`. The web lifecycle capture sends the current locator on the existing visibility/unmount flush even without movement; no timer/polling is added.

The separate row is deliberate: engagement is activity-derived current state with a different lifecycle from the intentional cursor and explicit override. Folding it into either would recreate nullable mixed-shape state. Media teardown removes it through the consumption owner.

Reader PUT becomes the exact existing `CursorWrite {locator, base_revision}` contract. Cursor conflict records no engagement. Cursor success/idempotent success is followed by the retry-safe current-state engagement command; failure is surfaced and the same cursor may be retried safely. Attention-only `204`, best-effort dwell, ambiguous-delta restore, and the rAF tracker die.

Projection precedence:

1. explicit `consumption_overrides` (`unread | finished`);
2. podcast listening state (`is_completed`, position/duration);
3. reader engagement: `max_total_progression >= 0.95` → finished; any row → in progress;
4. absent → unread.

Document `last_engaged_at` comes from `reader_engagement_states`; audio recency comes from the heartbeat-only `podcast_listening_states.last_engaged_at`. Migration 0186 copies operational `updated_at` only when post-fencing state proves the latest mutation was a heartbeat (`write_revision > 0`, incomplete, and either positive position or no reset). Pre-fencing, completed, and post-reset zero-position rows stay absent because they prove at most that listening once occurred, not when it occurred. Manual Finished/Unread mutations may advance operational `updated_at` but preserve engagement recency. `MediaOut` and Resonance consume those owner-level recency facts; the removed library `surfaced_today` and Lectern Recent products consumed them before the Resonance cutover. This preserves reader-progress AC17 without retaining history or fabricating engagement from state-only commands.

Post-cut `ListeningHeartbeatIn` remains strict camel-case, all-required, CAS-fenced, and has **no completion field**. It contains exactly:

```text
positionMs, durationMs: Presence, playbackSpeed,
expectedWriteRevision, expectedResetEpoch,
heartbeatGeneration, heartbeatSequence
```

Remove only `dwellMsDelta` and `deviceId`, plus the `record_attention_in_txn` call. Preserve the fresh serializable transaction, viewer lock, visibility check, write/reset fences, generation/sequence echo, one-in-flight/coalescing/recovery client behavior, and stale-write-no-mutation guarantee. Keep `nx_device`; workspace sessions still own it.

### 4.5 Retrieval, rerank, replay, and retention

`message_retrievals` remains the durable result truth: ordinal, score, selected/included state, status, refs, locator, snapshots, and citation pointer. Prompt assembly updates that row only. App/web search write no candidate copy; rerank/selection summaries are in-memory.

Remove candidate/rerank arrays from **both** `TrustToolCallOut` and `ChatRunStreamToolCallOut`, their Python/TypeScript child types, reconcile/fold defaults, merge logic, UI sections, and mismatch notices. Chat-run events, stream rehydration, tool rows, citations, writes/Undo, errors, and colophon remain.

| State | Current retention / rebuildability | Final state |
|---|---|---|
| Page snapshots/items | 15-minute TTL; exactly rebuildable from live library state | Drop; keyset cursor |
| Closure edges/backfill jobs | Jobs/terminal rows have no TTL; closure is rebuildable | Drop; membership query |
| Intrinsics | Durable direct-intent provenance; not reliably rebuildable | Preserve qualifying physical rows, then drop provenance |
| Reading sessions | Retained until lifecycle deletion; history not rebuildable | Backfill current engagement/progression, then destroy history |
| Candidate/rerank ledgers | Conversation lifetime, no TTL; exact pass not rebuildable | Drop; selected result truth stays in `message_retrievals` |
| `message_retrievals` | Conversation/message lifetime; canonical trust/source data | Keep unchanged; delete with owning chat lifecycle |
| Reader engagement | New current fact, not history | Keep until media/user lifecycle cleanup |

## 5. API and cross-system composition

- `GET /libraries/{id}/entries` keeps envelope, `limit`, `sort`, `viewer_tz`, and `LibraryPageInfo`; only cursor semantics hard-cut.
- `PATCH /libraries/{id}/entries/reorder` rejects Default. Web: `canReorder = canEditEntries && !library.is_default`.
- Invite acceptance returns `{invite, membership, idempotent}`; remove `backfill_job_status` and internal requeue API.
- Reader PUT accepts direct `CursorWrite`; removed envelope/attention fields are validation errors.
- Listening GET/PUT paths and `ListeningHeartbeatResult` remain with the exact heartbeat cut above.
- Existing `POST /consumption/commands` and Lectern explicit-state commands remain; do not recreate deleted pre-Lectern override/queue routes.
- Both trust-trail and chat-run reconcile response families omit candidate/rerank fields.
- Invite/revoke/library-entry commits require no follow-up projection work.
- Oracle remains readable/scoped through its system library but system-only works do not enter Default list/count/search/Library Intelligence/Atlas. System-only media reports `can_delete=false`; a direct delete is `E_FORBIDDEN`, not a successful no-op. Removing a personal path from media also referenced by Oracle removes it from personal surfaces without deleting corpus data.
- Search keeps `search/scope.py` as the 13-entity matrix owner; media-derived library cells delegate to the library-set owner, contributor scope composes virtual media plus physical podcasts, and message/conversation/web-result cells retain exact `conversation_shares` semantics.
- Resource library counts become viewer-aware: Default counts distinct virtual media; non-default counts physical media + podcasts.
- Web, Android shell/share, and extension capture cut over in the same release. No deleted request field is ignored.

## 6. Migration and deployment

### Preflight

- Abort unless Default contains zero podcast entries.
- Abort if an intrinsic lacks its matching physical Default entry.
- Record counts for all eight dropped tables; classify Default physical media rows as intrinsic-backed, closure-only, both, or unclassified.
- Assert Oracle/system-only media are excluded by the new Default relation and remain globally readable.

Preflight failures return exact row IDs and perform no mutation. Before the cut, remediate an invalid Default podcast through existing public operations: retain it via an active subscription and/or a chosen non-default library, then remove the invalid Default entry. Restore a missing intrinsic physical row through the current provenance owner. Rerun preflight; `0183` never guesses a destination or silently discards either case.

### `0183` transform

1. Create `reader_engagement_states` for the union of `reader_media_state` and `reading_sessions` pairs restricted to reader-supported media kinds (`web_article | epub | pdf`). Set `last_engaged_at = GREATEST(reader_media_state.updated_at, MAX(reading_sessions.last_active_at))` with null-safe handling, so cursor-only and attention-only document rows both survive. Overlay current cursor progression; backfill session progression only where it is document-wide. PDF page-local progression becomes `NULL`, not false completion.
2. Delete queued `background_jobs` of kind `backfill_default_library_closure_job`.
3. Delete physical Default entries proven closure-only. Retain intrinsic-backed, both-backed, and unclassified rows; the current agent path can create unclassified direct intent.
4. Drop snapshot items/snapshots, candidate/rerank ledgers, reading sessions, backfill jobs, closure edges, and intrinsics in dependency order.
5. Do not synthesize consumption overrides or fake locators. Downgrade is blocked.

### Release

One maintenance cut: stop API/workers → migrate `0182 → 0183` → deploy API/worker/web from one SHA → restart → smoke web, Android, extension, sharing, reader/player, and chat. Mixed versions are forbidden.

## 7. File plan and known blast radius

### Delete

- `python/nexus/services/default_library_closure.py`
- `python/nexus/tasks/backfill_default_library_closure.py`
- `python/nexus/api/routes/internal_libraries.py`
- `python/nexus/services/attention.py`
- `python/nexus/schemas/attention.py`
- `python/tests/test_default_library_backfill.py`
- `python/tests/test_attention.py`
- `apps/web/src/lib/reader/useAttentionTracker.ts` and test
- `apps/web/src/lib/attention.ts` when its now-dead player/reader consumers are removed
- candidate/rerank DTO/types/UI/tests that become empty

### Modify / centralize

- Schema/migration: `python/nexus/db/models.py`, `migrations/alembic/versions/0183_*.py`, `python/tests/test_migrations.py`.
- Library: `auth/permissions.py`, `services/{library_entries,library_governance,library_invitations,media_deletion,oracle_corpus}.py`, `services/agent_tools/writes.py`, ingest/system callers, schemas/routes, job registry, web list/reorder/sort code.
- Virtual-set adopters: `services/search/scope.py`, `services/resource_graph/resolve.py`, `services/artifacts/reducers/library_dossier.py`, `services/atlas_projection.py`, and default count/hydration callers.
- Lectern/reader: existing `services/consumption/{service,_projection,_listening_store}.py`, new private engagement store, `schemas/{consumption,reader}.py`, `api/routes/{reader,listening_state}.py`, `services/media.py`, `apps/web/src/lib/reader/**`, `apps/web/src/lib/player/listeningHeartbeat.ts`, and `apps/web/src/lib/player/globalPlayer.tsx`.
- Chat: `schemas/conversation.py`, `services/{message_trust_trails,chat_run_response,chat_run_prompt_tracking,chat_run_citations,chat_context_refs}.py`, `services/agent_tools/{app_search,web_search}.py`, `apps/web/src/lib/conversations/{messageUpdateReducer,types}.ts`, and `apps/web/src/components/chat/{AssistantTrustInspector,AssistantMessage}.tsx`.
- Tests/tooling: `python/tests/factories.py`, `python/tests/utils/db.py`, `python/scripts/seed_real_media_e2e.py`, `python/tests/real_media/{conftest,assertions}.py`, `Makefile`, library/reader/listening/chat/search/resource tests, negative gates.
- Docs: `docs/architecture.md`, `docs/modules/{library,sharing,chat,player}.md`; add precise later-supersession notes to attention, reader-progress, Lectern, trust-trail, and provenance cutover docs.

Known closure-fixture blast radius on current `main`: 27 Python test files / 196 provenance-table literals; `factories.py` is imported by 64+ tests. Delete its `DefaultLibraryIntrinsic` write and redundant `add_library_entry_only`. The real-media seed and shared fixture currently join intrinsics and must use the final direct/visibility contract. `search/scope.py` has 13 live entity rows; coverage must enumerate the code-owned matrix, including `reader_apparatus_item`. Replace G-8's deleted-path allowlist with a positive owner-boundary assertion: no live attention/session writer or import exists, and consumption owns engagement.

Do not name or recreate Lectern-deleted `consumption_queue.py`, `services/listening_state.py`, `routes/{queue,consumption}.py`, or `schemas/queue.py`.

## 8. Acceptance criteria

- **AC1 — Schema:** all eight tables are absent; `reader_engagement_states` is the only new table; no replacement view/cache/job/history ledger exists.
- **AC2 — Personal All:** direct + shared non-system media appears once; tombstones hide per viewer; Oracle's 19 system-only works stay out of every Default-derived surface, including Atlas, while remaining readable in Oracle/global surfaces. Explicit non-system filing makes an Oracle work appear exactly once.
- **AC3 — Sharing:** invite acceptance/revocation changes Default list/count/search/Library Intelligence immediately; sharing, roles, subscriptions, and conversation sharing retain existing behavior.
- **AC4 — Filing invariants:** REST and agent use one actor command; Default podcast and system mutations reject; idempotent re-file clears tombstones; direct Default intent creates a physical row; Undo never removes a pre-existing row.
- **AC5 — Barrier/deletion:** every media insert hits the teardown barrier before library lock; an armed intent is absent from scalar/set visibility; physical entries are the sole reference count; creator-vs-teardown races linearize; no closure SQL remains; system-only delete is unavailable/rejected and mixed personal/system removal is truthful.
- **AC6 — Pagination:** Default and non-default position pages use keyset `LIMIT + 1`; an insert above the cursor neither duplicates nor omits pre-existing lower rows and appears after refresh; old/cross-scope cursors fail; paging performs no write.
- **AC7 — Resonance:** Default rejects and hides resonance; non-default cursor carries the original `resonance_as_of` plus score/id key and is stable when score inputs do not mutate.
- **AC8 — Reorder:** Default shows no drag handles/emits no PATCH and endpoint rejects; non-default admin mixed-entry reorder and bad-set/member rejection stay green.
- **AC9 — Reader:** migration preserves cursor-only and attention-only document rows, latest engagement, and max whole-document progression; same-locator lifecycle save advances engagement without cursor revision/metadata change; explicit and derived state follow §4.4; removed attention fields fail validation.
- **AC10 — Listening:** all remaining heartbeat fields are required; CAS/reset/generation/sequence/recovery behavior is unchanged; stale heartbeat writes nothing; no dwell/device/session write remains.
- **AC11 — Chat:** app/web retrieval, prompt inclusion, citations, historical source opening, tool activity, stream reconcile, write/Undo, errors, and colophon work with candidate/rerank absent from both DTO families.
- **AC12 — Consumers:** Default list/count, all media-derived search cells, resource summary, Library Intelligence, and Atlas resolve one personal virtual set; global/system and exact conversation scopes do not change accidentally.
- **AC13 — Clients:** web, Android WebView/share intent, and extension capture pass with the strict final contract.
- **AC14 — Tooling:** preflight reports exact invalid rows and passes after documented remediation; `make seed-real-media-e2e` and `make test-real-media` provision and pass without provenance tables; historical migration tests pin their intended revision.
- **AC15 — Performance:** capture `EXPLAIN (ANALYZE, BUFFERS)` for Default first/next page, Default-scoped search, and non-default resonance next page. Add an index only if evidence requires it.
- **AC16 — Extirpation:** the positive gate scans `python/nexus`, `apps/web`, production-adjacent scripts/Makefile, non-historical tests, `docs/architecture.md`, and `docs/modules`; it excludes immutable migrations, `test_migrations.py`, its own declarations, and superseded `docs/cutovers/**`. Deleted table/model/type/field/job/route names, `add_library_entry_only`, attention path allowlists, candidate/rerank DTO fields, and raw Default containment SQL are absent from the scanned roots.

## 9. Implementation order / done

1. Lock final wire/query contracts and red tests.
2. Land virtual sets, keyset pagination, actor filing command, and teardown ownership.
3. Cut closure jobs/provenance and migrate all consumers/fixtures/seeds.
4. Fold post-Lectern consumption, backfill current engagement, and delete attention history.
5. Cut duplicate retrieval ledgers and both response families/UI paths.
6. Land `0183`, extirpate stale code/docs/tests, and run AC1–AC16.

Done means one owner per capability, net seven fewer tables, no legacy branch, no mixed-version deployment, and only the explicit 80/20 losses above.
