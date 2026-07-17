# Attention Ledger — reading sessions, dwell, single read-state owner — Hard Cutover

**Status:** Spec · Rev 1 · 2026-07-07
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims.

**Reader-state note (2026-07-16):** `reader-progress-continuity-hard-cutover.md`
(migration 0180) replaced the reader-state PUT this spec extends. The route now
takes the strict envelope `{cursor?: {locator, base_revision}, attention?}`;
attention-only requests return `204` and never touch the `reader_media_state`
cursor row — `services/attention.py` validates media visibility itself rather
than the locator write implicitly covering it. §D-1's claim that "the locator
save is already the attention-worthy event," the "What is NOT deleted" note
below describing `services/reader.py`'s bare-locator/null-clear parsing, and
step S2's `parse_reader_state_with_attention` plan describe the superseded
pre-cutover shape and are retained as historical implementation record only.

**Lectern/player-lifecycle note (2026-07-16):**
`lectern-player-lifecycle-hard-cutover.md` supersedes this spec's One-line
owner claim, §2 explicit-finished actions, §3 G-3/G-5, §§4.1/4.4 consumption
ownership/projection, §6 override route (not the listening heartbeat), §7
consumption actions, §8 D-4, §9 listening owner claim, §11 affected
owner/HTTP slices, §12 AC-9, §13 consumption-owner gates G-5/G-8, and §15
corresponding files. `services/attention.py` no longer writes or reads
`consumption_overrides`; the consumption package
(`services/consumption/_state_store.py`) owns explicit state, and
`services/consumption/_listening_store.py` now owns the listening heartbeat's
position/duration/speed write with revision/epoch fencing. This spec's
`reading_sessions` table, 30-minute session continuity, attention
aggregation, and audio-while-playing dwell rule remain canonical and
unchanged.

## One-line

Record every contiguous reading and listening episode as a first-class `reading_sessions` row; derive read-state from sessions + one explicit override verb; make `services/attention.py` the sole writer of both tables and `consumption_state(user_id, media_ids)` the sole derivation function for collection queries.

---

## 0. Prerequisites (hard, no fallback)

- **P-1.** `reader.py` PUT route exists at `python/nexus/api/routes/reader.py:100` — `PUT /media/{media_id}/reader-state` — and calls `reader_service.put_reader_media_state`. Verified.
- **P-2.** `PUT /api/media/{media_id}/listening-state` exists at `python/nexus/api/routes/listening_state.py:51`; `services/listening_state.upsert_listening_state_for_viewer` is the sole writer of `podcast_listening_states`. Verified.
- **P-3.** `services/media.enrich_media_read_state` (`python/nexus/services/media.py:487`) is the current sole derivation owner of `MediaOut.read_state` and `MediaOut.progress_fraction`; called at `media.py:317` and `media.py:739`. Verified.
- **P-4.** `useReaderResumeState` (`apps/web/src/lib/reader/useReaderResumeState.ts`) debounces at 500ms and flushes on `pagehide` + `visibilitychange` (hidden). It does NOT currently track window focus. Verified at lines 177–193.
- **P-5.** `useListeningStatePersistence` (`apps/web/src/lib/player/listeningState.ts:75`) persists every 15 s while playing, on play→pause, and on `beforeunload` (keepalive). Verified.
- **P-6.** `collection-surface-hard-cutover.md` (BUILT, 2026-06-19) Non-Goal N6 explicitly defers the `consumption_state` table to v2. This spec fulfills that deferred item; cite at §1.
- **P-7.** `resource_edges.origin` CHECK (`ck_resource_edges_origin`, `db/models.py:579–587`) currently lists `'user', 'citation', 'system', 'note_body', 'highlight_note', 'synapse', 'document_embed'`. This spec adds NO new origin. Verified.
- **P-8.** `llm_calls` owner_kind CHECK (`ck_llm_calls_owner_kind`, `db/models.py:4010–4013`) lists `'chat_run', 'oracle_reading', 'li_revision', 'media_summary', 'media_enrichment', 'synapse_scan'`. This spec adds NO new owner kind — it makes no LLM calls. Verified.
- **P-9.** `lib/actions/resourceActions.ts` (`apps/web/src/lib/actions/resourceActions.ts`) owns `ActionMenuOption[]` construction per kind. Verified at lines 38–121.
- **P-10.** `lib/collections/types.ts` `CollectionRowView.swipeActions?: SwipeAction[]` is defined and consumed by `apps/web/src/components/collections/CollectionRow.tsx:63–64`. Verified.
- **P-11.** Migration chain ends at `0168_web_article_inline_embeds.py` (down_revision `"0167"`). Sibling `dawn-write-hard-cutover.md` (SPEC) claims `0169`. This spec uses placeholder `NNNN`.

---

## 1. Problem (grounded diagnosis)

### 1.1 No reading-session entity — dwell is discarded

`docs/scriptorium.md §IV` states it precisely: "No reading-session entity exists anywhere in ~100 tables. Read-state is inferred from scroll saves; dwell is discarded on the reader's floor." The sole read-position store is `reader_media_state` (one row per user+media, stores locator JSON, `updated_at`). Audio has `podcast_listening_states` (stores position_ms + is_completed). Neither records *how long* the user spent. The `updated_at` column captures the timestamp of the most recent save — not time-in-text. Dwell, the signal that would make ambient intelligence personal (resonance ranking, Temporal Echo, Canon weighting), is written to no table.

`collection-surface-hard-cutover.md §Non-Goals N6` (BUILT) explicitly deferred: "The unified table + true 'opened' event + highlight-count index are a documented v2 follow-up." This spec is that follow-up.

### 1.2 Read-state ownership is diffuse

`services/media.enrich_media_read_state` (media.py:487) is the derivation point for `MediaOut`, but the derivation function for library entries reads `reader_media_state` and `podcast_listening_states` again via `_LAST_ENGAGED_AT_SQL` (library_entries.py:66–92) — two separate query patterns over the same underlying tables, with no single authoritative function for "what is the read-state of this media for this user." There is no "mark as finished/unread" verb; no override path exists.

---

## 2. Target behavior (user-facing)

- **Reader (document/transcript/epub/pdf):** opening a document starts or continues a reading session. Scrolling accumulates dwell only while the browser tab is visible AND the window has focus. The debounced save piggybacks on the existing reader-state PUT, now carrying an attention block.
- **Audio player:** every listening-state persist call (15 s interval + pause + unload) accumulates dwell in the open session. The listening path calls the same `attention_service.record_attention` function.
- **Session continuity:** if a save arrives within 30 minutes of the last active session row for `(user_id, media_id)`, the session is continued (last_active_at and dwell_ms updated, spans merged). After 30 minutes, a new session row is opened.
- **Read-state badge:** collection rows display `unread` / `in progress` / `finished` driven by the new `consumption_state` function. Override wins over derived.
- **Mark finished / Mark unread:** available in the per-row action menu (mediaResourceOptions) and as an optional swipe action on media rows. POST `/media/{id}/consumption-override` writes `consumption_overrides`; the row updates optimistically.
- **No session display:** sessions are never user-visible in phase 1. No charts, no minutes, no goals, no streaks.

---

## 3. Goals / Non-goals

**G-1.** Record every contiguous reading/listening episode as a `reading_sessions` row with dwell_ms and span ranges touched.
**G-2.** Single-owner derivation: `consumption_state(user_id, media_ids)` is the only function that computes read-state; it replaces both `enrich_media_read_state` and the inline derivation in library queries.
**G-3.** Explicit override verb: `consumption_overrides(user_id, media_id, status)` is the highest-priority signal; "mark finished / mark unread" writes it; override survives session updates.
**G-4.** `attention_on_day(user_id, month, day)` service function returns (media_id, total_dwell_ms) pairs for Temporal-Echo-shaped features (SQL-only, no surface). No `exclude_year` parameter — callers filter dates; the function returns all matching sessions regardless of year.
**G-5.** No chatty new endpoints: attention writes piggyback the existing reader-state and listening-state routes.
**G-6.** Dwell accrues only while the pane is visible + document has focus (FE invariant, verified by test).
**G-7.** Memory doctrine: keep raw sessions indefinitely (single-user scale). Compaction is a named leave (N-5).

**N-1.** No minutes-read UI, no reading-time display, no charts, no goals, no streaks anywhere in phase 1. (Negative gate §13.)
**N-2.** No resonance re-weighting by dwell in this spec — `attention_on_day` is the leave hook; the resonance score change is a deliberate follow-up (see D-8).
**N-3.** No synapse candidate boost from dwell in this spec.
**N-4.** No Canon weighting from dwell in this spec.
**N-5.** No session compaction / aggregation job.
**N-6.** No SSE stream for session events; no real-time read-state deltas.
**N-7.** No full reconstruction of historical dwell from existing tables — `updated_at` is a last-write timestamp, not session duration. The migration seed (§5.3) creates synthetic sessions only to preserve read-state continuity (in_progress / finished status), not to reconstruct dwell_ms history.
**N-8.** No span-grain overlap deduplication on the server; `spans` is append-append jsonb; dedup is analysis-time.
**N-9.** Sessions are NOT user-visible in phase 1 — no session list, no history surface.

---

## 4. Architecture and final state

### 4.1 Ownership table

| Concern | Sole owner (final) | Replaces |
|---|---|---|
| Write `reading_sessions` | `python/nexus/services/attention.py` `record_attention()` | nothing (new table) |
| Write `consumption_overrides` | `python/nexus/services/attention.py` `set_consumption_override()` | nothing (new table) |
| Derive read-state for collection queries | `python/nexus/services/attention.py` `consumption_state()` | `services/media.enrich_media_read_state` (deleted); inline `_doc_read_state` / `_audio_read_state` (deleted) |
| Derive `last_engaged_at` for resonance ORDER BY | `library_entries.py` `_LAST_ENGAGED_AT_SQL` (unchanged, different concern from read-state) | nothing (not replaced by this spec) |
| Reader-state PUT (document) | `python/nexus/api/routes/reader.py:put_reader_state` (extended, not replaced) | same route |
| Listening-state PUT (audio) | `python/nexus/api/routes/listening_state.py:put_listening_state` (extended) | same route |
| Consumption-override POST | `python/nexus/api/routes/consumption.py` (new, transport-only) | nothing |
| FE dwell accumulation (reader) | `apps/web/src/lib/reader/useAttentionTracker.ts` (new) | nothing |
| FE dwell accumulation (audio) | `apps/web/src/lib/player/listeningState.ts` (extended) | nothing |
| FE `readStatus` derivation from server payload | `CollectionRowView.consumption.status` from new API field | `enrich_media_read_state` post-hoc call chain |

### 4.2 Session continuity rule

The 30-minute gap rule is a server constant `ATTENTION_SESSION_GAP_SECONDS = 1800`. It is not config. The server identifies the "open session" as the most recent `reading_sessions` row for `(user_id, media_id)` where `last_active_at >= now() - ATTENTION_SESSION_GAP_SECONDS`. If one exists, update in place; else insert new. The `FOR UPDATE` pattern on the selected row serializes concurrent saves from multiple panes. The single-open-session-per-(user, media) policy handles the multiple-panes risk (D-6).

### 4.3 Dwell accumulation (FE)

The FE accumulates `dwell_ms_delta` in a `useRef` that increments with `requestAnimationFrame`-gated elapsed time, but ONLY while both `document.visibilityState === "visible"` AND `document.hasFocus()`. The delta is flushed into the existing debounce save payload (`dwell_ms_delta`) and reset to 0 after each flush. On `pagehide` and `visibilitychange`→hidden, the delta is flushed immediately (keepalive if possible) and zeroed.

**Singleton lock per media_id.** A module-level `Set<string>` (`_ACTIVE_DWELL_TRACKERS`) in `useAttentionTracker.ts` ensures only one tracker per `mediaId` accumulates within a tab. The first mount registers the `mediaId`; subsequent mounts for the same `mediaId` receive a no-op tracker (zero delta, never flushes). Cleanup on unmount removes the `mediaId` from the set. This prevents split-pane scenarios from double-counting dwell within the same window — `document.hasFocus()` is window-scoped and does not distinguish two visible panes.

For the audio path, `useListeningStatePersistence` does not track visibility; audio playback is the proxy — dwell accrues only while `isPlaying`. Each persist call includes `dwell_ms_delta` = elapsed since last persist (capped at `SYNC_INTERVAL_MS + 2000ms` guard to exclude tab-hidden pauses).

### 4.4 `consumption_state` function

```python
def consumption_state(
    db: Session,
    *,
    viewer_id: UUID,
    media_ids: list[UUID],
) -> dict[UUID, ConsumptionStateOut]:
```

Returns a mapping from media_id to `ConsumptionStateOut(status: MediaReadState, progress_fraction: float | None)`. Priority:

1. **Override wins.** If `consumption_overrides` row exists for `(viewer_id, media_id)`, return its `status` with `progress_fraction=None`.
2. **Session-derived.** Aggregate `reading_sessions` for `(viewer_id, media_id)`:
   - `finished`: any session has `max_progression >= 0.95` OR `(total_dwell_ms across all sessions) >= DOC_DWELL_FINISHED_MS = 120_000` (2 minutes, a deliberate floor — skimming a long article to 95% counts as finished regardless of dwell).
   - `in_progress`: any session has `dwell_ms >= SESSION_DWELL_IN_PROGRESS_MS = 30_000` (30 seconds). `progress_fraction` = `MAX(max_progression)` across sessions, else None.
   - `unread`: no qualifying session (including media seeded with `dwell_ms=0` and `max_progression < 0.95`).

The function runs one `consumption_overrides` batched query + one `reading_sessions` aggregate query per call (two queries total for any batch size). It does NOT touch `reader_media_state` or `podcast_listening_states`.

---

## 5. Data model / migration

Migration file: `NNNN_attention_ledger.py` (`down_revision` assigned at build time). Main currently ends at `0168`. Sibling `dawn-write-hard-cutover.md` also claims `0169` (`down_revision="0168"`). Merge sequencing: if `dawn-write` merges first, this spec becomes `0170` (`down_revision="0169"`). If both are in flight simultaneously, a merge migration `NNNN_merge_attention_dawn.py` with `down_revision = ["0169_dawn", "0169_attention"]` is required. Coordinate with dawn-write owner before numbering; do not hardcode `0169` in this migration until the branch point is resolved.

### 5.1 `reading_sessions`

```sql
CREATE TABLE reading_sessions (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id        uuid        NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    device_id       text        NOT NULL,
    started_at      timestamptz NOT NULL DEFAULT now(),
    last_active_at  timestamptz NOT NULL DEFAULT now(),
    dwell_ms        bigint      NOT NULL DEFAULT 0,
    max_progression real,
    spans           jsonb       NOT NULL DEFAULT '[]',

    CONSTRAINT ck_reading_sessions_dwell_non_negative
        CHECK (dwell_ms >= 0),
    CONSTRAINT ck_reading_sessions_max_progression
        CHECK (max_progression IS NULL OR (max_progression >= 0.0 AND max_progression <= 1.0)),
    CONSTRAINT ck_reading_sessions_spans_array
        CHECK (jsonb_typeof(spans) = 'array'),
    CONSTRAINT ck_reading_sessions_device_id_len
        CHECK (char_length(device_id) <= 128)
);

-- Hot session-continuity query: find most recent session within the gap window.
-- Indexed on last_active_at (not started_at) so the WHERE/ORDER BY on
-- last_active_at hits the index leaf directly without a filter scan.
CREATE INDEX ix_reading_sessions_user_media_active
    ON reading_sessions (user_id, media_id, last_active_at DESC);

-- attention_on_day query: find sessions by calendar date.
CREATE INDEX ix_reading_sessions_user_started
    ON reading_sessions (user_id, started_at DESC);
```

`spans` is a JSONB array of `{start: int, end: int}` character-offset pairs (text) or `{page: int}` objects (PDF). The server appends the incoming `spans_touched` delta; no deduplication at write time (N-8). `device_id` is a client-supplied opaque string (the existing workspace session device cookie if available, else a generated UUID stored in `localStorage`).

### 5.2 `consumption_overrides`

```sql
CREATE TABLE consumption_overrides (
    user_id     uuid    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_id    uuid    NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    status      text    NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, media_id),

    CONSTRAINT ck_consumption_overrides_status
        CHECK (status IN ('unread', 'finished'))
);
```

`in_progress` is intentionally excluded from the override vocabulary: it is a derived state. "Mark as started" is not a meaningful user gesture; "Mark unread" and "Mark finished" are.

### 5.3 Data seeding (hard-cutover compliance)

No legacy fallback in code. Instead, the migration runs a one-shot SQL seed immediately after DDL that backfills `reading_sessions` from existing engagement data. Without this, every item would show "unread" on day 1.

```sql
-- Seed from completed/active podcast listening states.
INSERT INTO reading_sessions (id, user_id, media_id, device_id,
    started_at, last_active_at, dwell_ms, max_progression, spans)
SELECT
    gen_random_uuid(),
    pls.user_id,
    pls.media_id,
    '__migrated__',
    pls.updated_at,
    pls.updated_at,
    0,
    CASE
        WHEN pls.is_completed THEN 1.0
        WHEN pls.duration_ms > 0
            THEN LEAST(pls.position_ms::real / pls.duration_ms, 1.0)
        ELSE NULL
    END,
    '[]'::jsonb
FROM podcast_listening_states pls
WHERE pls.is_completed OR pls.position_ms > 0;

-- Seed from reader docs with a saved scroll position.
-- Use dwell_ms = SESSION_DWELL_IN_PROGRESS_MS + 1 = 30001 so they
-- show as "in_progress" immediately (no progression scalar available).
INSERT INTO reading_sessions (id, user_id, media_id, device_id,
    started_at, last_active_at, dwell_ms, max_progression, spans)
SELECT
    gen_random_uuid(),
    rms.user_id,
    rms.media_id,
    '__migrated__',
    rms.updated_at,
    rms.updated_at,
    30001,
    NULL,
    '[]'::jsonb
FROM reader_media_state rms
WHERE rms.locator IS NOT NULL;
```

Seeded rows use `device_id='__migrated__'` to allow future identification. After seeding, `consumption_state` reads only `reading_sessions` and `consumption_overrides` — no fallback branch exists.

### 5.4 Models

New `ReadingSession` and `ConsumptionOverride` ORM classes in `db/models.py`, following house style (mapped_column, explicit FKs, named constraints). Add relationships on `User` and `Media` (cascade all, delete-orphan).

---

## 6. API

### New routes (`python/nexus/api/routes/consumption.py`)

| Method | Route | Behavior |
|---|---|---|
| POST | `/media/{media_id}/consumption-override` | Body `{status: "unread"\|"finished"}`; upsert `consumption_overrides`; 204. |
| DELETE | `/media/{media_id}/consumption-override` | Remove override (reverts to derived); 204. |

Register in `api/routes/__init__.py` before the `media` router (same pattern as `listening_state_router`).

### Modified routes

**`PUT /media/{media_id}/reader-state`** (`reader.py:put_reader_state`): extend to accept an optional `attention` block in the body. The route passes the block to `attention_service.record_attention(db, viewer_id, media_id, attention)`. The existing locator handling is unchanged. If `attention` is absent (old clients), the call is a no-op for attention.

Extension to `ReaderResumeState` (discriminated union approach): add an `attention` optional sibling field at the envelope level (not inside each kind). The backend unpacks it before forwarding the locator portion to `put_reader_media_state`. Alternatively, a thin wrapper schema `ReaderStateWithAttention(locator: ReaderResumeState | None, attention: AttentionBlock | None)` avoids touching the discriminated union. The wrapper is cleaner and avoids discriminator drift — use it.

**`PUT /media/{media_id}/listening-state`** (`listening_state.py:put_listening_state`): extend `ListeningStateUpsertRequest` with `dwell_ms_delta: int | None` and `device_id: str | None`. Route calls `attention_service.record_attention(db, viewer_id, media_id, attention)` after the existing upsert.

### AttentionBlock schema

```python
class TextSpan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["text"]
    start: int
    end: int

class PageSpan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["page"]
    page: int

SpanItem = Annotated[Union[TextSpan, PageSpan], Field(discriminator="kind")]

class AttentionBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dwell_ms_delta: int = Field(ge=0)
    device_id: str = Field(max_length=128)
    spans_touched: list[SpanItem] = Field(default_factory=list)
    progression: float | None = Field(default=None, ge=0.0, le=1.0)
```

`spans_touched` items must carry a `kind` discriminator (`"text"` or `"page"`); the server validates the shape and rejects invalid items with 422. The FE emits `{kind: "text", start, end}` (character offsets for reader) and `{kind: "page", page}` (PDF). `device_id` is capped at 128 chars server-side (UUIDs are 36; the `nx_device` cookie is similar).

### BFF proxy routes (Next.js)

- `apps/web/src/app/api/media/[id]/consumption-override/route.ts` — POST + DELETE proxy.
- `proxy-routes.test.ts` `API_ROUTE_COUNT` increments by 1 (one new file).

---

## 7. Frontend

### New files

| File | Purpose |
|---|---|
| `apps/web/src/lib/reader/useAttentionTracker.ts` | Accumulates `dwell_ms_delta` via rAF, gated on `document.visibilityState === 'visible' && document.hasFocus()`. Exports `{dwellDeltaRef, resetDelta}`. |
| `apps/web/src/app/api/media/[id]/consumption-override/route.ts` | Thin BFF proxy (POST + DELETE). |
| `apps/web/src/lib/attention.ts` | `postConsumptionOverride(mediaId, status)` + `deleteConsumptionOverride(mediaId)` client calls. |

### Modified files

| File | Change |
|---|---|
| `apps/web/src/lib/reader/useReaderResumeState.ts` | Accept `AttentionTracker` ref; fold `dwell_ms_delta + spans_touched + progression` into PUT body; reset delta after flush. |
| `apps/web/src/lib/player/listeningState.ts` | Add elapsed-since-last-persist accumulator (capped); include `dwell_ms_delta + device_id` in PUT body. |
| `apps/web/src/lib/actions/resourceActions.ts` | Add `onMarkFinished?: () => void` and `onMarkUnread?: () => void` callbacks to `mediaResourceOptions`; insert "Mark as finished" / "Mark as unread" menu items gated on callbacks and current read-state. |
| `apps/web/src/lib/collections/presenters/media.ts` | Replace the existing delete swipe (`Trash2`) with `onMarkFinished` as the primary swipe action. The delete action moves to action-menu-only (it is already present in `mediaResourceOptions`). See D-11. |
| Collection presenters receiving `read_state` | Consume `consumption` from the new `MediaOut.read_state` / `progress_fraction` (no logic change, same field names). |

### Adoption table — per-surface

| Surface | Change |
|---|---|
| Library media rows | `consumption.status` from `MediaOut.read_state` now populated by `consumption_state()` (`enrich_media_read_state` deleted in S4) |
| Podcast episode rows | Same; `in_progress` from session dwell now possible even when `is_completed=false` |
| Search results | `read_state` already threaded; no presenter change needed |
| Media pane header | No display of session data (N-9 holds) |
| Action menu (all media contexts) | Mark finished / Mark unread added via `mediaResourceOptions` |

---

## 8. Key decisions

**D-1. Piggyback existing saves, no new chatty endpoint.** Attention data rides the reader-state PUT (debounced at 500ms, flushed on hide/pagehide) and the listening-state PUT (15s interval + pause). Adding a dedicated `/attention` endpoint would double write traffic without new information. The locator save is already the attention-worthy event (you saved because you scrolled).

*Rejected:* beacon-only endpoint — loses the debounce coalescing; dedicated SSE stream — inverts the direction of truth.

**D-2. Singleton dwell tracker per media_id within a tab.** `useAttentionTracker` uses a module-level `Set<string>` (`_ACTIVE_DWELL_TRACKERS`) to ensure only one instance accumulates dwell per `mediaId` per tab. The first mount wins; subsequent mounts for the same `mediaId` get a no-op tracker. `document.hasFocus()` is window-scoped — it cannot distinguish two visible split panes — so the singleton lock is the correct gate for cross-pane deduplication. On the server, both panes write to the same session row (same user+media); the `FOR UPDATE` serializes concurrent saves. Net result: one active accumulator, one session row.

*Rejected:* additive pane dwell (both panes accumulate) — `document.hasFocus()` does not prevent double-counting within a window; per-pane session rows — splits one reading episode into multiple rows with no analytical benefit.

**D-3. 30-minute gap constant is not config.** The 30-minute threshold is a product constant derived from existing UX research (30-min session gap is standard in analytics); it has no business changing at deploy time. Making it a DB/config value adds migration and test complexity for no gain in a single-user prototype. Named in the service as `ATTENTION_SESSION_GAP_SECONDS = 1800`.

*Rejected:* configurable via settings — violates "simple, trust the model"; configurable per-media-kind — unnecessary complexity.

**D-4. `consumption_overrides` status vocabulary: 'unread' | 'finished' only.** 'in_progress' is a derived state, not a user intent. "Mark as started" is not a human gesture; the system already knows you started. Excluding it keeps the override as an explicit signal override, not a state mirror.

*Rejected:* three-value ('unread', 'in_progress', 'finished') — 'in_progress' override has no semantic content over "clear the finished override".

**D-5. Migration-seeded sessions, no code fallback.** On day 1 of deploy, the schema migration immediately seeds `reading_sessions` from `podcast_listening_states` (is_completed → max_progression=1.0; active position → proportional max_progression) and `reader_media_state` (saved locator → dwell_ms=30_001 so status shows "in_progress"). This preserves read-state continuity without a fallback branch in `consumption_state`. Seeded rows use `device_id='__migrated__'`. Hard-cutover doctrine: no fallback code, no TODO comment, no time-bomb.

*Rejected:* live fallback in `consumption_state` — a transitional read path into old tables violates hard-cutover doctrine and requires a date-gated gate with inverted semantics to enforce removal; no seeding — cold-start regression where everything reads "unread" on deploy.

**D-6. No new `resource_edges` origin.** Sessions are not edges; they have no target. Overrides are not edges; they are scalar state, not relational assertions. Neither belongs in the graph.

*Rejected:* `origin='attention'` edge for "has read" relationships — misuse of the edge graph; the graph is for *between-object* assertions, not scalar progress.

**D-7. `attention_on_day` is service-only in phase 1 — no `exclude_year` parameter.** The function signature is `attention_on_day(viewer_id, month, day) -> list[tuple[UUID, int]]` returning (media_id, total_dwell_ms) pairs. No route, no BFF proxy, no FE consumer. When Temporal Echo ships, its spec extends the signature; bespoke parameters for unbuilt features violate the "simple, trust the model" doctrine.

**D-8. Dwell rank as resonance leave.** The resonance ORDER BY (`_RESONANCE_ORDER`, library_entries.py:238–252) weights recency-decay + log1p(connections) + shared-author + similarity. A dwell term (`_RESONANCE_DWELL_WEIGHT * ln(1 + total_dwell_ms / 60000.0)`) belongs here but requires the `reading_sessions` table to exist first. Adding it to `_RESONANCE_ORDER` is a one-SQL-term addition — named here as a deliberate leave to avoid coupling slices.

**D-9. `spans` is append-append jsonb, not deduplicated.** The server appends incoming spans to the session's `spans` array. Analysis-time deduplication (for questions like "what percentage of the text was touched") is a query or service function, not a write-time concern. Write-time deduplication would require parsing the existing array on every save — O(n) per save, no benefit for the attention ledger's primary consumers (dwell ranking, Temporal Echo).

**D-10. `max_progression` is a real column, not computed.** The server keeps `MAX(incoming progression, existing max_progression)` on each update. This lets `consumption_state` derive "finished" from a single indexed query without parsing spans or aggregating fractions. The CHECK (`0.0 ≤ max_progression ≤ 1.0`) enforces the invariant.

**D-11. Delete swipe moves to action-menu-only on media rows.** `CollectionRow.tsx:63` renders only `swipeActions?.[0]`. The existing delete-document swipe (`Trash2`, tone `danger`) occupies this slot. S7 replaces it with `onMarkFinished`. The destructive delete action is already present in `mediaResourceOptions` and remains accessible there — no functionality is lost, only the swipe affordance changes. This is a deliberate behavior change, not a gap.

---

## 9. What dies (exhaustive)

### Deleted functions

| Symbol | File | Why |
|---|---|---|
| `_doc_read_state` | `python/nexus/services/media.py:472` | Replaced by `consumption_state` |
| `_audio_read_state` | `python/nexus/services/media.py:454` | Replaced by `consumption_state` |
| `enrich_media_read_state` | `python/nexus/services/media.py:487` | Replaced by `consumption_state` |

### Callers replaced

- `media.py:317` — `enrich_media_read_state(db, viewer_id=viewer_id, media_outs=media_list)` → `_apply_consumption_state(db, viewer_id, media_list)` (thin wrapper that calls `consumption_state` and applies fields in place)
- `media.py:739` — same
- `library_entries.py:635` — `read_state=media.read_state` — unchanged field name; the upstream `MediaOut` is now populated via `consumption_state` instead of `enrich_media_read_state`

### What is NOT deleted

- `reader_media_state` table and model — still the locator store for resume (position only, not dwell). `put_reader_media_state` is unchanged.
- `podcast_listening_states` table and model — still the authoritative audio position and completion store. `upsert_listening_state_for_viewer` is unchanged.
- `_LAST_ENGAGED_AT_SQL` in library_entries.py — still used for the resonance order's most-recent-activity signal; `last_engaged_at` on `LibraryEntryOut` is still populated from the same sources. (This is a separate concern from read-state.)
- `services/listening_state.py` — unchanged except route-level extension.
- `services/reader.py` — `parse_reader_resume_state` is extended to `parse_reader_state_with_attention(raw_body) -> tuple[ReaderResumeState | None, AttentionBlock | None]`; the null-clear semantic (`JSON.stringify(null)` → clear locator, attention ignored) and empty-body 400 are preserved. `put_reader_media_state` is genuinely unchanged — the attention block is consumed at the route layer and dispatched to `attention_service.record_attention`, never forwarded to the service function.

---

## 10. Sibling cutovers and sequencing

- **`collection-surface-hard-cutover.md` (BUILT):** This spec fulfills N6's intent (fulfills N6's intent via `reading_sessions` + `consumption_overrides` tables and the `consumption_state()` derivation function — no table named `consumption_state` is created). The `MediaOut.read_state` and `progress_fraction` fields remain on the schema (same field names); the derivation changes underneath. The FE consumption display path (`CollectionRowView.consumption`) is unchanged.
- **`dawn-write-hard-cutover.md` (SPEC):** Claims migration 0169. This spec's migration (`NNNN`) must be numbered accordingly at build time. No shared tables; no coordination needed at the code level.
- **`synapse-resonance-engine.md` (BUILT):** `resource_edges` origin CHECK is live. This spec adds NO new origin — no coordination needed.
- **`machine-output-in-place-hard-cutover.md` (SPEC):** Touches `LibraryBrief` rendering and `useLibraryIntelligenceStream`. No overlap with attention tables or routes.
- **`reader-sidecar-consolidation-hard-cutover.md` (SPEC):** Deletes several reader surface tabs; `EvidencePaneSurface` is the survivor. This spec does not add any new reader surface. **`useReaderResumeState.ts` is modified by both specs — concurrent modification is not permitted.** Merge sequencing: this spec (attention-ledger) must merge before `reader-sidecar-consolidation` begins FE work on `useReaderResumeState.ts`. The sidecar spec's cutover doc must note the attention tracker ref parameter as a resolved coordination point (with this spec's merge commit hash) when it picks up the file.
- **`walknotes-hard-cutover.md` (SPEC):** Adds `POST /walknotes/transcribe-audio` and uses the listening-state path. If listening-state PUT is extended in this spec, walknotes' own listening-state calls will automatically carry the new optional `dwell_ms_delta` field (ignored server-side when null). No conflict.
- **Shared file `apps/web/src/lib/player/listeningState.ts`:** Modified by this spec to add dwell accumulation. No sibling spec touches this file. Verify at build.
- **Shared file `apps/web/src/lib/actions/resourceActions.ts`:** Modified by this spec to add mark-finished/unread callbacks on `mediaResourceOptions`. **`lectern-hard-cutover.md` (SPEC, same batch) also edits this file** (adds `onAddToLectern` to `mediaResourceOptions`/`episodeResourceOptions`) and **`one-press-artifact-engine-hard-cutover.md` (SPEC) adds `distill-conversation` to `conversationResourceOptions`** — all additive to distinct option arrays / push sites; no conflict, merge in any order.
- **`lectern-hard-cutover.md` (SPEC, same batch):** shares three surfaces with this spec, all reconcilable: (1) `presenters/media.ts` media-row swipe — this spec replaces the delete swipe with mark-finished (D-11); lectern's D-3 keeps delete-swipe on library rows *by not editing that swipe* (its swipe=remove lives only on the Lectern pane's own rows), so this spec's change wins on library media rows and lectern's D-3 rationale is superseded, not code-conflicting; (2) `resourceActions.ts` (above); (3) `MediaPaneBody.tsx` — lectern adds `LecternNextPrompt`/`currentTotalProgression`, this spec adds no `MediaPaneBody` change, disjoint regions. lectern also *consumes* `MediaOut.read_state`/`progress_fraction`, which this spec now derives via `consumption_state()` — same field names, no lectern change needed.

---

## 11. Slices (each independently buildable)

**S0 — Schema + migration + data seed.**
Create `NNNN_attention_ledger.py`: `reading_sessions` table, `consumption_overrides` table, then immediately run the data seeding SQL (§5.3) within the same migration transaction. ORM models in `db/models.py`.
*Verify:* `make test-migrations` green; migration head asserts both tables exist with correct constraints; seeding INSERT counts > 0 on a DB with existing reader/podcast state; `down_revision` is correct.

**S1 — `services/attention.py` — sole writer.**
Implement `record_attention(db, viewer_id, media_id, block: AttentionBlock) -> None`: 30-min gap check via `FOR UPDATE`, insert or update session. Implement `set_consumption_override(db, viewer_id, media_id, status)` and `delete_consumption_override(db, viewer_id, media_id)`. Implement `consumption_state(db, viewer_id, media_ids) -> dict[UUID, ConsumptionStateOut]` with override-wins logic and session aggregate query — no legacy fallback branch. Implement `attention_on_day(viewer_id, month, day) -> list[tuple[UUID, int]]`.
*Verify:* `make check-back && make type-back`; focused `python/tests/test_attention.py` green (unit-style, fake clock).

**S2 — Reader PUT extension (backend).**
In `services/reader.py`, rename `parse_reader_resume_state` → `parse_reader_state_with_attention(raw_body: bytes) -> tuple[ReaderResumeState | None, AttentionBlock | None]`. Preserve the existing null-clear path: a body of `"null"` clears the locator and returns `(None, None)`; an empty body raises the existing 400. For non-null bodies, the function parses the raw JSON and extracts the top-level `locator` field (validated through `READER_RESUME_STATE_ADAPTER`) and the top-level `attention` field (validated through `AttentionBlock`). In `schemas/reader.py`, add the `ReaderStateWithAttention` envelope type for documentation clarity. Update `reader.py:put_reader_state` to call `parse_reader_state_with_attention`, then dispatch the attention block to `attention_service.record_attention` before the existing locator write (same transaction). `attention` absent → no-op. `dwell_ms_delta = 0` → records the "opened" event.
*Verify:* `make test-back-integration` — existing reader-state tests pass (including the null-clear path); new attention-write tests pass.

**S3 — Listening-state PUT extension (backend).**
Extend `schemas/media.py ListeningStateUpsertRequest` with `dwell_ms_delta: int | None` and `device_id: str | None`. Update `listening_state.py:put_listening_state` to call `attention_service.record_attention` after the existing upsert.
*Verify:* `make test-back-integration` — existing listening-state tests pass; attention rows appear in integration test.

**S4 — `consumption_state` owner swap.**
Replace calls to `enrich_media_read_state` in `services/media.py` (lines 317, 739) with `_apply_consumption_state`. Delete `_doc_read_state`, `_audio_read_state`, `enrich_media_read_state`. The `MediaOut.read_state` and `MediaOut.progress_fraction` fields remain.
*Verify:* `make test-back-integration` green; `make check-back`; `make type-back`. Negative gate: `rg 'enrich_media_read_state' python/nexus --include='*.py' -l | grep -v test` → empty.

**S5 — Consumption-override route + BFF proxy.**
Create `api/routes/consumption.py` (POST + DELETE). Register in `__init__.py`. BFF `apps/web/src/app/api/media/[id]/consumption-override/route.ts`. Increment `proxy-routes.test.ts` `API_ROUTE_COUNT` by +1 (this spec adds one new BFF file). Re-verify the live count at build time: `find apps/web/src/app/api -name 'route.ts' | wc -l`; set `API_ROUTE_COUNT` to that value. Do not hardcode the target — sibling specs (walknotes, dawn-write) may add routes before this one merges.
*Verify:* `make test-back-integration`; `cd apps/web && bun run test:unit`; route-count test passes.

**S6 — FE dwell tracker + reader hook extension.**
`useAttentionTracker.ts`: rAF loop gated on `document.visibilityState === 'visible' && document.hasFocus()`; exports `dwellDeltaRef` and `resetDelta`. Extend `useReaderResumeState.ts` to accept tracker and fold `dwell_ms_delta + spans_touched + progression` into PUT body. Extend `listeningState.ts` with elapsed accumulator (capped at SYNC_INTERVAL + 2s guard). All new fields are optional on the wire — old servers ignore them; new servers with no attention block still work (no-op).
*Verify:* `cd apps/web && bun run test:browser` — `useReaderResumeState.test.tsx` extended with dwell-gating assertions (focused+visible, focused+hidden, visible+unfocused); `listeningState` test extended.

**S7 — Mark finished / unread verb + swipe.**
`attention.ts` client: `postConsumptionOverride`, `deleteConsumptionOverride`. Extend `mediaResourceOptions` with `onMarkFinished`/`onMarkUnread` callbacks. In `media.ts` presenter: replace the existing `Trash2` delete swipe with `onMarkFinished` as `swipeActions[0]` (D-11 — delete moves to action-menu-only). Wire in relevant pane/row contexts. Optimistic update: flip `consumption.status` immediately on click, revert on error.
*Verify:* `cd apps/web && bun run test:browser` — media row action menu test (mark-finished/unread items present; delete absent from swipe); swipe fires `postConsumptionOverride`.

---

## 12. Acceptance criteria (testable)

**AC-1.** A reader-state PUT with `attention: {dwell_ms_delta: 45000, device_id: "…", spans_touched: [], progression: 0.3}` creates a `reading_sessions` row with `dwell_ms=45000`, `max_progression=0.3` for the given user+media.

**AC-2.** A second reader-state PUT for the same user+media within 30 minutes merges into the same session row: `dwell_ms` increments, `max_progression` is `MAX(existing, new)`, `last_active_at` advances, `started_at` is unchanged.

**AC-3.** A reader-state PUT more than 30 minutes after `last_active_at` of the most recent session opens a new session row; the old row is unchanged.

**AC-4.** A listening-state PUT with `dwell_ms_delta: 15000, device_id: "…"` writes a session row for an audio media item (podcast_episode kind). Subsequent PUTs within 30 minutes merge.

**AC-5.** `consumption_state(viewer_id, [media_id])` returns `{media_id: ConsumptionStateOut(status="finished")}` when `MAX(max_progression) >= 0.95` across sessions.

**AC-6.** `consumption_state(viewer_id, [media_id])` returns `status="in_progress"` when any session has `dwell_ms >= 30000` and `max_progression < 0.95`, with `progress_fraction = MAX(max_progression)` across sessions.

**AC-7.** `consumption_state(viewer_id, [media_id])` returns `status="unread"` when no sessions exist and no legacy reader-state row exists (fresh media).

**AC-8.** A `consumption_overrides` row with `status='unread'` overrides a session-derived `status='finished'`: `consumption_state` returns `status="unread"`.

**AC-9.** `POST /media/{id}/consumption-override` with `{status: "finished"}` upserts `consumption_overrides`; `DELETE /media/{id}/consumption-override` removes it; subsequent `consumption_state` call reflects the change.

**AC-10.** Dwell accumulates in `useAttentionTracker` only while `document.visibilityState === 'visible'` AND `document.hasFocus()`. Simulating tab-hidden or window-blur stops accumulation; returning to visible+focused resumes. The accumulated delta is the arithmetic sum of only visible+focused intervals.

**AC-11.** On `pagehide`, accumulated dwell is flushed into the PUT body with `keepalive: true`; delta resets to 0.

**AC-12.** `attention_on_day(viewer_id, month=7, day=6)` returns a list of `(media_id, total_dwell_ms)` pairs for all media the user read on any July 6 across all years, sorted by total_dwell_ms desc. The function takes no `exclude_year` parameter; callers filter the returned list if year scoping is needed (when Temporal Echo ships, its own spec adds the parameter).

**AC-13.** Mark-finished swipe action appears on media rows with `status="unread"` or `status="in_progress"`. Mark-unread action appears on `status="finished"` rows. Actions are absent for non-media rows (podcast, library, contributor).

**AC-14.** No `enrich_media_read_state` symbol exists in `python/nexus/services/` excluding test files (negative gate, §13).

---

## 13. Negative gates (grep-able)

```bash
# G-1. enrich_media_read_state deleted from production code (including
#       the docstring comment in schemas/media.py:217 — update it too)
rg 'enrich_media_read_state' python/nexus --include='*.py' -l \
  | grep -v '/tests/'
# → empty

# G-2. _doc_read_state and _audio_read_state deleted
rg '_doc_read_state|_audio_read_state' python/nexus --include='*.py' -l \
  | grep -v '/tests/'
# → empty

# G-3. No minutes-read / reading-time / reading-goals UI strings in FE
rg -i 'minutes\s+read|reading\s+time|reading\s+goal|reading\s+streak|time\s+spent\s+reading' \
  apps/web/src --include='*.ts' --include='*.tsx'
# → empty

# G-4. reading_sessions write only in attention.py (NNNN matches the actual migration filename)
rg "reading_sessions" python/nexus --include='*.py' -l \
  | grep -v '/tests/' | grep -v 'models.py' | grep -v 'attention.py' \
  | grep -v '_attention_ledger.py'
# → empty

# G-5. consumption_overrides write only in attention.py
rg "consumption_overrides" python/nexus --include='*.py' -l \
  | grep -v '/tests/' | grep -v 'models.py' | grep -v 'attention.py' \
  | grep -v 'consumption.py' | grep -v '_attention_ledger.py'
# → empty

# G-6. No new resource_edges origin added (origin set unchanged)
rg "resource_edges" python/nexus/db/models.py \
  | grep "ck_resource_edges_origin"
# → must contain exactly: 'user', 'citation', 'system', 'note_body', 'highlight_note', 'synapse', 'document_embed'
# (no 'attention' or 'session')

# G-7. No reading-time display in CSS
rg -i 'reading.time|reading.goal|streak' apps/web/src --include='*.css' --include='*.module.css'
# → empty

# G-8. No legacy fallback in attention.py (hard-cutover compliance — no fallback branch
#       reading reader_media_state or podcast_listening_states; seeding is migration-only)
rg 'reader_media_state|podcast_listening_states' python/nexus/services/attention.py
# → empty
```

Vitest source-grep assertion (in `test_cutover_negative_gates.py`):

```python
def test_no_enrich_media_read_state_in_production():
    import subprocess
    result = subprocess.run(
        ["rg", "enrich_media_read_state", "python/nexus", "--include=*.py", "-l"],
        capture_output=True, text=True,
    )
    files = [f for f in result.stdout.strip().split("\n") if f and "tests/" not in f]
    assert files == [], f"enrich_media_read_state in production: {files}"
```

---

## 14. Test plan

### Unit (.test.ts — Node, no DOM)

- `python/tests/test_attention.py` (integration-style, real DB):
  - `record_attention` session-create, session-continue (within 30 min), session-gap (>30 min), FOR-UPDATE serialization (two concurrent calls to same user+media).
  - `consumption_state`: override-wins; session-finished (max_progression ≥ 0.95); session-in_progress (dwell ≥ 30s); unread (no sessions, no legacy row — no fallback branch).
  - `set_consumption_override` upsert; `delete_consumption_override`; re-derived after delete.
  - `attention_on_day` — correct media, correct date filter (no exclude_year).
  - Gate test in `test_cutover_negative_gates.py` (G-1, G-8 above).
- `useAttentionTracker.test.ts` (.test.ts — Node, jsdom, rAF mocking):
  - Singleton lock: second mount for same `mediaId` gets no-op tracker; first mount accumulates.
  - Accumulates only while visible+focused.
  - Stops on `visibilitychange`→hidden; resumes on `visibilitychange`→visible (if focused).
  - Stops on `blur`; resumes on `focus` (if visible).
  - `resetDelta` zeroes the ref; cleanup removes `mediaId` from singleton set.

### Browser (.test.tsx — Chromium)
- `useReaderResumeState.test.tsx` (existing file, extend):
  - PUT body includes `attention.dwell_ms_delta` when tracker has accumulated.
  - PUT body has `attention.dwell_ms_delta: 0` when no dwell (opened-event semantics).
  - Delta reset after flush.
- Media row action menu: mark-finished appears when status=unread; mark-unread when status=finished. Swipe fires `postConsumptionOverride`.

### Guards

- `proxy-routes.test.ts` API_ROUTE_COUNT incremented by +1 (verify live count at build time).
- `test_migrations.py`: head assertions — `reading_sessions` and `consumption_overrides` tables exist; `ck_reading_sessions_dwell_non_negative` and `ck_consumption_overrides_status` constraints present.

### BE integration

- Extended reader-state route tests: PUT with attention block writes session; without block is no-op.
- Extended listening-state route tests: PUT with dwell_ms_delta writes session.
- Consumption-override route: POST upserts; DELETE removes; 404 on DELETE of non-existent (or 204 idempotent — choose idempotent for simplicity).

### E2E

Deferred (house pattern). The session + override flow is testable at the integration level; Playwright e2e for the swipe/mark-finished action is left as a named leave.

---

## 15. Files (created / modified / deleted)

### Created

- `migrations/alembic/versions/NNNN_attention_ledger.py`
- `python/nexus/services/attention.py`
- `python/nexus/api/routes/consumption.py`
- `python/nexus/schemas/attention.py` (AttentionBlock, ConsumptionStateOut, ConsumptionOverrideRequest)
- `python/tests/test_attention.py`
- `apps/web/src/lib/reader/useAttentionTracker.ts`
- `apps/web/src/lib/attention.ts`
- `apps/web/src/app/api/media/[id]/consumption-override/route.ts`

### Modified

- `python/nexus/db/models.py` — add `ReadingSession`, `ConsumptionOverride` ORM classes; add relationships on `User`, `Media`
- `python/nexus/schemas/reader.py` — add `ReaderStateWithAttention` envelope type
- `python/nexus/services/reader.py` — rename `parse_reader_resume_state` → `parse_reader_state_with_attention`; preserve null-clear and empty-body semantics; parse envelope to extract locator + attention block
- `python/nexus/api/routes/reader.py` — call `parse_reader_state_with_attention`; dispatch attention block to `attention_service.record_attention`
- `python/nexus/api/routes/listening_state.py` — call `attention_service.record_attention` after upsert
- `python/nexus/api/routes/__init__.py` — register `consumption_router`
- `python/nexus/schemas/media.py` — add `dwell_ms_delta: int | None` and `device_id: str | None` to `ListeningStateUpsertRequest`; update `MediaOut.read_state` docstring (remove `enrich_media_read_state` reference)
- `python/nexus/services/media.py` — replace `enrich_media_read_state` calls with `_apply_consumption_state`; delete `_doc_read_state`, `_audio_read_state`, `enrich_media_read_state`
- `python/tests/test_migrations.py` — head assertions for new tables + constraints
- `python/tests/test_cutover_negative_gates.py` — G-1 gate
- `apps/web/src/lib/reader/useReaderResumeState.ts` — fold attention tracker into PUT body
- `apps/web/src/lib/player/listeningState.ts` — add dwell accumulator and delta in PUT body
- `apps/web/src/lib/actions/resourceActions.ts` — add mark-finished/unread options
- `apps/web/src/lib/collections/presenters/media.ts` — wire swipe + action callbacks
- `apps/web/src/app/api/proxy-routes.test.ts` — increment `API_ROUTE_COUNT` by +1 (verify live count at build)
- `apps/web/src/lib/reader/useReaderResumeState.test.tsx` — dwell assertions

### Deleted

- `enrich_media_read_state` function body (within `python/nexus/services/media.py`)
- `_doc_read_state` function body (within `python/nexus/services/media.py`)
- `_audio_read_state` function body (within `python/nexus/services/media.py`)

---

## 16. Risks

**R-1. Write-amplification on every debounce save (MEDIUM).** The existing reader-state PUT fires every 500ms of scroll inactivity (debounced) plus on pagehide. Adding session logic to the same call adds one SELECT (`FOR UPDATE`) + one UPDATE per save. At reading pace (~1 save per scroll stop, perhaps 10–20/minute), this is manageable on single-user Postgres. *Mitigation:* skip the session write when `dwell_ms_delta == 0` AND the session row already exists (no-op path). Only the opened-event (first save, delta=0) and delta>0 saves touch the session table.

**R-2. Multiple panes of same media — dwell double-counting (LOW).** `document.hasFocus()` is window-scoped and cannot distinguish two visible split panes. *Mitigation:* the module-level singleton lock in `useAttentionTracker` (`_ACTIVE_DWELL_TRACKERS` Set) ensures only one tracker per `mediaId` accumulates within a tab. D-2 documents this explicitly. Cross-window deduplication is not addressed — two browser windows on the same media would each accumulate, which is acceptable at single-user scale.

**R-3. FE clock drift in dwell accumulation (LOW).** rAF timestamps can stutter. *Mitigation:* cap each rAF delta at 500ms (`max(0, min(delta_ms, 500))`); this prevents a single stalled frame from inflating dwell by seconds.

**R-4. 30-minute session boundary on server clock (LOW).** Server uses `now()` for the gap check; FE doesn't know the exact boundary. A client that pauses exactly at the boundary may get a new session. *Mitigation:* harmless — two rows for one reading episode is an acceptable outcome; `attention_on_day` aggregates both.

**R-5. Seeded-session quality (LOW).** Reader docs seeded with `dwell_ms=30_001` and `max_progression=NULL` show "in_progress" correctly. Podcast items with `position_ms > 0` but no `duration_ms` get `max_progression=NULL` and `dwell_ms=0`, so they show "unread" until the next listening event. This is a minor regression for partially-played podcasts without cached duration; they recover at the next play. *Mitigation:* acceptable at single-user scale; no action required. Enforced by G-8 (§13).

**R-6. `device_id` source on the FE (LOW).** `device_id` is sent from the client. The `WorkspaceSession` device cookie (`nx_device`) is the canonical source. If the cookie is not yet set (first load), a generated UUID stored in `localStorage` is the fallback. Both are opaque strings; the server does not validate them. *Mitigation:* document the contract in `useAttentionTracker.ts`; add a `useDeviceId()` hook that reads the cookie via `document.cookie` parsing, falling back to localStorage.
