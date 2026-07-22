# The Lectern — One Consumption Queue Across Kinds — Hard Cutover

**Status:** Spec · Rev 2 · 2026-07-07
**Type:** Hard cutover — no legacy code, no fallbacks, no compat shims.

**Superseded (2026-07-16):** `lectern-player-lifecycle-hard-cutover.md` is the
sole runtime contract. This document's §§2–4 and 6–16 are superseded; §5 is
retained as historical DDL provenance only.

**Navigation supersession (2026-07-20):** N-6's unchanged-home/restore claim is
superseded. Lectern is now the canonical authenticated home and the first item
in the shared desktop/mobile app navigation. An explicit `/lectern` request
restores or appends a Lectern pane and activates it while preserving the other
saved panes. See [`docs/modules/app-navigation.md`](../modules/app-navigation.md).

**Reading-surface supersession (2026-07-21):**
[`resonance-reading-slate-hard-cutover.md`](resonance-reading-slate-hard-cutover.md)
hard-cuts the independent Recent product and replaces it with the on-demand
Resonance-owned **At hand** Slate. Lectern queue ordering and command ownership
remain unchanged.

## One-line

Rename `playback_queue_items` → `consumption_queue_items` and widen it to hold any
media kind; build the Lectern pane (`/lectern`) as the visible home of the queue;
wire every consumption surface (actions, swipe in Lectern, launcher verb, reader
end-of-document prompt, player advance) to the unified service; make mobile put the
Lectern first.

---
## 0. Prerequisites (hard, no fallback)

**P-1.** `playback_queue_items` (verified `python/nexus/db/models.py:2529–2571`):
table has no media-kind restriction on its FK — `media_id` points to `media.id ON
DELETE CASCADE`, no CHECK on `media.kind`. The rename + source widening is purely
additive; no data migrates, no backfill.

**P-2.** Constraint names to rename (exact, from `models.py:2558–2568`):
`uq_playback_queue_items_user_media`, `ck_playback_queue_items_position_non_negative`,
`ck_playback_queue_items_source`, `ix_playback_queue_items_user_position`.

**P-3.** ORM back-populate references to repoint: `User.playback_queue_items`
(`models.py:208`) and `Media.playback_queue_items` (`models.py:1222`).

**P-4.** All raw-SQL callers referencing `playback_queue_items` by name:
`python/nexus/services/playback_queue.py` (the service, 8 raw-SQL blocks),
`python/nexus/services/media_deletion.py:518` (`DELETE FROM playback_queue_items WHERE
media_id = :media_id`), `python/nexus/services/media_deletion.py:668` (second
caller; both must repoint).

**P-5.** Podcast auto-queue caller: `python/nexus/services/podcasts/ingest.py:430`
calls `playback_queue_service.append_subscription_media_if_enabled` — repoint to
`consumption_queue_service`.

**P-6.** The Universal Launcher cutover is built and verified
(`docs/cutovers/universal-launcher-hard-cutover.md` — BUILT+REVIEWED 2026-06-18);
`dispatchTarget` owns every Launcher action (`lib/launcher/dispatch.ts:48`). This
spec adds one new target kind (`queue-add`) to that switch.

**P-7.** Every `PaneRouteId` has one exhaustive route definition with a typed
header contract. Adding `"lectern"` therefore puts its navigation destination
only in the section header contract in the same `PANE_ROUTE_MODELS` entry; no
duplicate destination field or parallel standing-head map exists.

**P-8.** `amanuensis-hard-cutover.md` (SPEC, same batch): its `queue_add` tool
writes `consumption_queue_items` with `source='assistant'`. This spec's migration
and service must land first; amanuensis S6 is gated on it (stated explicitly in
amanuensis §10 and §11 S6).

---
## 1. Problem (grounded diagnosis)

### 1.1 The queue is audio-only by shape, not by data

`playback_queue_items.source IN ('manual', 'auto_subscription', 'auto_playlist')`
(`models.py:2565`) names only audio-originated sources. The service's
`_assert_media_ids_queueable` (`playback_queue.py:321`) gates every add on
`derive_playback_source` returning a non-None value — which it only does for
`podcast_episode` and `video` kinds. Text media (`web_article`, `epub`, `pdf`)
raises `E_INVALID_KIND`, making the queue structurally off-limits to the majority of
the library. The table itself has no kind restriction; the gate is entirely in the
service layer.

### 1.2 No visible queue surface; no consistent entry points

The queue lives inside `GlobalPlayerQueuePanel.tsx` — a dialog anchored to the
player footer, with no independent route, no nav entry, and no action-menu verb on
collection rows that aren't podcast episodes. `resourceActions.ts` exports
`mediaResourceOptions`, `episodeResourceOptions`, `libraryResourceOptions`,
`podcastResourceOptions`, and `conversationResourceOptions` — none surfaces an
"Add to queue" option for arbitrary media (`lib/actions/resourceActions.ts:38–122`).
The swipe action on media rows in collection surfaces is hardwired to delete
(`presenters/media.ts:67–78`). Text works have no queue path whatsoever.

---
## 2. Target behavior (user-facing)

- **From any collection surface** (library, search, browse results, launcher): an
  "Add to Lectern" option appears in the action menu for any readable or playable
  media work; selecting it appends the item at the end of the queue.
- **Launcher media rows** expose a trailing "Add to Lectern" icon action
  (`trailingAction`); the default Enter opens the media as usual.
- **The Lectern pane** (`/lectern`, nav slot `primary`) shows the full queue in
  strict position order. The first row is titled "On the lectern" in a quiet
  emphasized style (not a hero card). Each row shows kind glyph (small-caps label),
  title, author, read/listen progress fraction, drag handle for reorder, and a
  remove affordance. Empty state: one line of quiet type ("Nothing on the lectern
  yet."). Swipe-left on a row removes it from the queue.
- **GlobalPlayerConsumptionPanel** (renamed in-player overlay) shows only the
  audio/video subset of the queue; a footer link "Open Lectern" opens `/lectern`.
  On desktop, the panel continues to open from the "Queue" button in the player
  footer. On mobile, the "Queue" button opens the Lectern pane instead of the panel.
- **Player advance** (`handleEnded`): when a track finishes, the player fetches the
  next item in the queue whose `kind` is `podcast_episode` or `video`; text items
  are skipped in order without being removed. The skipped text items remain in the
  queue, waiting for explicit reading.
- **Reader end-of-document**: when `total_progression` reaches or exceeds 0.95 (the
  existing `_DOC_FINISHED_PROGRESSION` constant at `media.py:451`), a quiet
  one-line `LecternNextPrompt` component appears at the bottom of the document body
  — "Next on the lectern: <title>". Tapping opens that entry (via `openInNewPane`)
  and removes the finished item from the queue. No tap, no action — auto-advance is
  explicitly refused.
- **Podcast auto-queue** via subscription sync continues to work, writing
  `source='auto_subscription'` through the renamed service.
- **Mobile-first nav**: on mobile viewports, Lectern appears as the first primary nav
  destination (ahead of Libraries, Authors, Podcasts, Notes) in NavSheet and the
  mobile nav bar. The workspace restore semantics are unchanged.

---
## 3. Goals / Non-goals

**G-1.** One table, one service, one `/queue` API family for all media kinds. No
   parallel "reading queue" alongside the playback queue.

**G-2.** Source widening: `assistant` source added now for amanuensis; no other new
   sources.

**G-3.** The Lectern is a standard `CollectionView` pane — editorial, anti-card,
   reorder-capable, with the existing `SortableList` drag primitive already in
   `GlobalPlayerQueuePanel.tsx`.

**G-4.** Player advance skips text; reader end-of-document offers but never forces.

**G-5.** Podcast auto-queue behavior is byte-identical after rename.

**G-6.** Mobile: Lectern is first primary destination; queue button opens the pane.

**N-1.** No new resource_edges origin. The Lectern writes no edges.

**N-2.** No automatic advance for text — the reader prompt is explicit tap only.

**N-3.** No cross-device sync of queue position. Single-user, single-device.

**N-4.** No "start from the top" auto-play mode. The queue is a reading list, not a
   playlist engine.

**N-5.** No gamification. The queue position count is not surfaced as a metric or
   a badge; only the Lectern row itself shows remaining count by implication.

**N-6.** No new mobile home surface. `WorkspaceRestore` semantics are unchanged; the
   Lectern is a nav destination, not the default landing page.

---
## 4. Architecture and final state

### 4.1 Ownership table

| Concern | Sole owner (final) | Replaces |
|---|---|---|
| Queue storage | `consumption_queue_items` table | `playback_queue_items` |
| Queue CRUD | `python/nexus/services/consumption_queue.py` | `services/playback_queue.py` |
| Queue routes (BE) | `python/nexus/api/routes/queue.py` | `api/routes/playback.py` (entirely replaced — pre-audit shows file is queue-only) |
| Queue BFF routes | `apps/web/src/app/api/queue/` | `app/api/playback/queue/` |
| Queue FE client | `lib/player/consumptionQueueClient.ts` | `lib/player/playbackQueueClient.ts` |
| In-player audio queue panel | `GlobalPlayerConsumptionPanel.tsx` | `GlobalPlayerQueuePanel.tsx` |
| Full queue pane | `app/(authenticated)/lectern/LecternPaneBody.tsx` (new) | — |
| ORM model | `ConsumptionQueueItem` (renamed class) | `PlaybackQueueItem` |
| "Add to Lectern" action | `lib/actions/resourceActions.ts` `mediaResourceOptions` + `episodeResourceOptions` | (new option in both) |
| Launcher queue verb | `lib/launcher/dispatch.ts` `case "queue-add"` | — |
| Reader end-of-doc prompt | `LecternNextPrompt.tsx` (inline in `MediaPaneBody`) | — |

### 4.2 Queue data model scope

The consumption queue is for **all 5 media kinds**: `web_article`, `epub`, `pdf`,
`podcast_episode`, `video`. The service's queueability gate changes from
"must have a playback source" to "must be visible to the viewer and be one of the
five supported kinds". (Non-document, non-playable, or processing-failed media is
not queueable and reports `E_INVALID_KIND`.)

### 4.3 Kind split in consumers

Audio-kind set (player-consumed): `{'podcast_episode', 'video'}`.
Readable-kind set (reader-consumed): `{'web_article', 'epub', 'pdf'}`.

`ConsumptionQueueItemOut` carries `kind: str`, `stream_url: str | None` (null for
readable kinds), and `reader_href: str` (always `/media/{media_id}`, present for all
kinds) so each consumer can branch on kind without re-fetching.

---
## 5. Data model / migration

Migration file: `NNNN_consumption_queue.py` — number assigned at build time — main
ends at 0168, sibling dawn-write spec claims 0169, unmerged branch
codex/search-retrieval-roadmap claims 0168-0173 and renumbers at merge.

### 5.1 DDL-ish

```sql
-- Rename table
ALTER TABLE playback_queue_items RENAME TO consumption_queue_items;

-- Rename constraints
ALTER TABLE consumption_queue_items
  RENAME CONSTRAINT uq_playback_queue_items_user_media
    TO uq_consumption_queue_items_user_media;
ALTER TABLE consumption_queue_items
  RENAME CONSTRAINT ck_playback_queue_items_position_non_negative
    TO ck_consumption_queue_items_position_non_negative;
ALTER TABLE consumption_queue_items
  DROP CONSTRAINT ck_playback_queue_items_source;
ALTER TABLE consumption_queue_items
  ADD CONSTRAINT ck_consumption_queue_items_source
  CHECK (source IN (
    'manual', 'auto_subscription', 'auto_playlist', 'assistant'
  ));

-- Rename index
ALTER INDEX ix_playback_queue_items_user_position
  RENAME TO ix_consumption_queue_items_user_position;
```

No data migration required. The CHECK widening is additive (existing rows all satisfy
the new constraint). Alembic `down_revision` chains onto 0168 (or the highest
sibling migration that lands before this one).

### 5.2 Downgrade

Drop `ck_consumption_queue_items_source`, re-add with the three-source form,
rename table and constraints back. No data loss (no 'assistant' rows exist at
downgrade time in any test run).

---
## 6. API

### 6.1 New `/queue` family (in `api/routes/queue.py`)

| Method | Path | Notes |
|---|---|---|
| GET | `/queue` | Full ordered queue; optional `?kind_filter=audio\|readable` param |
| POST | `/queue/items` | Add by `media_ids[]`, `insert_position`, `current_media_id` |
| DELETE | `/queue/items/{item_id}` | Remove one item |
| PUT | `/queue/order` | Full reorder by item-id list |
| POST | `/queue/clear` | Empty queue |
| GET | `/queue/next` | Next item after `current_media_id`; optional `?kind=audio\|readable`; defaults to `audio` (used by player and reader prompt) |

`GET /queue?kind_filter=audio` returns items with `kind IN ('podcast_episode','video')`
only — used by `GlobalPlayerConsumptionPanel`. `kind_filter=readable` returns text
items only. Omitting the param returns all items.

`GET /queue/next` already existed as `/playback/queue/next`. It now accepts an
optional `kind` query param (`audio` | `readable`). Omitting or passing `kind=audio`
scopes to `podcast_episode`/`video` (player path). Passing `kind=readable` scopes to
`web_article`/`epub`/`pdf` (reader prompt path at §7.7). In both cases the server
scans forward from `current_media_id` by position and returns the first matching item
or null.

### 6.2 Old `/playback/queue*` routes — deleted

`GET /playback/queue`, `POST /playback/queue/items`, `DELETE /playback/queue/items/{id}`,
`PUT /playback/queue/order`, `POST /playback/queue/clear`, `GET /playback/queue/next`
— all deleted. Pre-build audit of `api/routes/playback.py` confirms the file is
exclusively these six queue routes; the file is therefore deleted in full.

### 6.3 BFF routes

New `apps/web/src/app/api/queue/` mirrors the new `/queue` family:
`route.ts`, `items/route.ts`, `items/[itemId]/route.ts`, `order/route.ts`,
`clear/route.ts`, `next/route.ts`.

Old `apps/web/src/app/api/playback/queue/` directory and all files within it are
deleted.

### 6.4 Schemas

`python/nexus/schemas/playback.py` is deleted; `schemas/queue.py` is the replacement
(use `git mv` if content is 1:1; here symbols are renamed throughout, so delete +
create is appropriate).

Renamed symbols:
- `PlaybackQueueItemOut` → `ConsumptionQueueItemOut`
- `PlaybackQueueListeningStateOut` → `ConsumptionQueueListeningStateOut`
- `PlaybackQueueAddRequest` → `ConsumptionQueueAddRequest`
- `PlaybackQueueOrderRequest` → `ConsumptionQueueOrderRequest`
- `PlaybackQueueInsertPosition` → `ConsumptionQueueInsertPosition`
- `PlaybackQueueSource` Literal widened with `'assistant'`

Full `ConsumptionQueueItemOut` field contract (on-the-wire, all required unless noted):

| Field | Type | Notes |
|---|---|---|
| `item_id` | `UUID` | Queue row PK; used by PUT /queue/order and DELETE /queue/items/{item_id} |
| `media_id` | `UUID` | FK to `media`; used by reader prompt to identify current item |
| `position` | `int` | Queue order (0-based); used by optimistic reorder |
| `kind` | `str` | `web_article` / `epub` / `pdf` / `podcast_episode` / `video` |
| `title` | `str` | Display title from `media.title` |
| `stream_url` | `str \| None` | Streaming URL for audio/video kinds; null for readable kinds |
| `reader_href` | `str` | Always `/media/{media_id}`; navigation href for all kinds |
| `source` | `str` | `manual` / `auto_subscription` / `auto_playlist` / `assistant` |
| `listening_state` | `ConsumptionQueueListeningStateOut \| None` | Audio progress; null for readable kinds |

`ConsumptionQueueListeningStateOut` (was `PlaybackQueueListeningStateOut`):
`position_ms: int`, unchanged semantics.

---
## 7. Frontend

### 7.1 FE client

`lib/player/consumptionQueueClient.ts` replaces `lib/player/playbackQueueClient.ts`.
Exported type `ConsumptionQueueItem` (was `PlaybackQueueItem`) adds `kind: string`
and `reader_href: string`; `stream_url` becomes `string | null`; `source_url` is
removed. All API paths change from `/api/playback/queue` → `/api/queue`. The
`PLAYBACK_QUEUE_UPDATED_EVENT` constant renames to `CONSUMPTION_QUEUE_UPDATED_EVENT`.

`countUpcomingQueueItems` is **deleted**. Its only consumer (`upcomingQueueCount` in
`globalPlayer.tsx:813`) feeds a `queueBadge` count display in `GlobalPlayerFooter.tsx`
(lines 510–513, 694–697). That badge is removed per N-5 ("no count surfaced as a
metric or a badge"). The `Queue` button aria-label no longer includes the count.

**Track construction:** `globalPlayer.tsx:784` currently builds `GlobalPlayerTrack`
with `source_url: queueItem.source_url`. After S2, `ConsumptionQueueItem` drops
`source_url`; this line becomes `source_url: queueItem.stream_url ?? ""`.
`GlobalPlayerTrack.source_url` (the audio stream URL, passed to
`PlaybackErrorOrTimecode`) is unchanged in semantics — it is now sourced from
`stream_url` (non-null for audio kinds by the service contract).

### 7.2 Pane model

`lib/panes/paneRouteModel.ts` `PaneRouteId` union gains `"lectern"`.
`PANE_ROUTE_MODELS` gains:
```typescript
route({
  id: "lectern",
  header: {
    kind: "section",
    destinationId: "lectern",
    defaultFolio: "none",
  },
  pattern: ["lectern"],
  defaultLabel: "Lectern",
  labelMode: "static",
  bodyMode: "standard",
  ...STANDARD_WIDTH_CONTRACT,
})
```

`lib/panes/paneRouteTable.ts` gets only the corresponding icon entry.
`lib/navigation/destinations.ts` gains:
```typescript
{
  id: "lectern",
  label: "Lectern",
  href: "/lectern",
  keywords: ["queue", "reading list", "playlist", "next"],
  slot: "primary",
  match: { exact: ["/lectern"] },
}
```
The fixed app-navigation projection orders Lectern before Libraries. The
section header resolves the route's `header.destinationId` through the same
destination registry; it has no separate label map.

### 7.3 Lectern pane

**File:** `apps/web/src/app/(authenticated)/lectern/LecternPaneBody.tsx`
**Route file:** `apps/web/src/app/(authenticated)/lectern/page.tsx`

Body fetches `GET /api/queue` on mount and after every mutation. Renders a
`CollectionView` (existing component) containing `LecternRowView` items derived from
`ConsumptionQueueItem[]`. `LecternRowView` accepts an `isFirst: boolean` prop; when
true, it renders a small-caps kicker element above the title row:
```tsx
{isFirst && <p className={styles.lecternKicker}>On the lectern</p>}
```
with a hairline separator beneath in CSS. The kicker is a real DOM element (screen-
reader accessible, no CSS `::before { content }` anti-pattern). No hero card, no
special background.

`LecternRowView` extends `CollectionRowView` with drag-handle affordance. Reorder
uses the existing `SortableList` (`components/sortable/SortableList.tsx`) already
used in `GlobalPlayerQueuePanel.tsx`. Remove button is an icon at row end
(non-swipe, for keyboard/desktop). Swipe on mobile: `swipeActions[0]` = remove from
queue (see D-6).

Progress fraction in rows: for audio items, `listening_state` position_ms /
(duration_seconds × 1000); for text items, `total_progression` from the media's
`read_state` data (the same `progress_fraction` field already carried in the media
list endpoint enrichment — verified `media.py:577`).

Empty state:
```tsx
<p className={styles.emptyState}>Nothing on the lectern yet.</p>
```

### 7.4 GlobalPlayerConsumptionPanel

Renamed from `GlobalPlayerQueuePanel.tsx`. No configurable `kindFilter` prop — the
component always filters to audio kinds internally:
```typescript
const AUDIO_KINDS = ["podcast_episode", "video"] as const;
const audioItems = queueItems.filter(i => AUDIO_KINDS.includes(i.kind as typeof AUDIO_KINDS[number]));
```
Heading changes from "Playback queue" to "Up next". Footer adds a link:
```tsx
<Link href="/lectern">Open Lectern</Link>
```
On desktop, opening behavior is unchanged (queueOpen state, overlay at the footer).

### 7.5 Mobile GlobalPlayerFooter change

`openQueueFromMobileExpanded` (`GlobalPlayerFooter.tsx:253`): instead of
`setQueueOpen(true)`, calls `requestOpenInAppPane('/lectern', { labelHint: 'Lectern' })`.
The `GlobalPlayerConsumptionPanel` is now desktop-only; on mobile the Lectern pane
is the queue surface.

### 7.6 Player advance — kind filtering

`playNextInQueue` in `globalPlayer.tsx` (currently at line 818) changes the inner
`fetchNextPlaybackQueueItem` call: the `GET /api/queue/next` endpoint already returns
the "next audio item" (per §6.1). No change needed to the call site; the endpoint
now filters to audio kinds internally. The FE function rename tracks:
`fetchNextPlaybackQueueItem` → `fetchNextAudioQueueItem` (in the renamed client).

### 7.7 Reader end-of-document prompt

**File:** `apps/web/src/components/LecternNextPrompt.tsx`

`MediaPaneBody.tsx` does not currently store `total_progression` in React state —
the value is computed inside the scroll-capture callback (now `reportReaderMovement`, post reader-progress-continuity cutover) and
the initial value is restore-only. A new state variable is added:
```typescript
const [currentTotalProgression, setCurrentTotalProgression] = useState<number | null>(null);
```
Updated inside the existing scroll-save callback (wherever `total_progression` is
computed and written). The threshold constant:
```typescript
const LECTERN_PROMPT_THRESHOLD = 0.95; // matches _DOC_FINISHED_PROGRESSION in media.py:451
```

A `useEffect` watches `currentTotalProgression`:
```typescript
useEffect(() => {
  if ((currentTotalProgression ?? 0) < LECTERN_PROMPT_THRESHOLD) return;
  // fetch next readable item
  fetchNextConsumptionQueueItem('readable', mediaId).then(setNextReadableItem);
}, [currentTotalProgression, mediaId]);
```

The fetch calls `GET /api/queue/next?kind=readable&current_media_id={mediaId}` (the
same `GET /queue/next` endpoint extended in §6.1 with an optional `kind` param). If
found, renders `<LecternNextPrompt>` at the bottom of the document scroll container.

`LecternNextPrompt` renders one quiet line: `Next on the lectern: <title>` — a
plain `<button>` in the body type-scale, no border, no card. On tap:
1. Calls `removeConsumptionQueueItem(currentItemId)` (removes finished item)
2. Calls `openInNewPane?.('/media/{nextItem.media_id}', nextItem.title)`

No auto-advance, no pop-under navigation, no analytics.

### 7.8 Action menu — "Add to Lectern"

`lib/actions/resourceActions.ts` `mediaResourceOptions` gains:
```typescript
if (input.onAddToLectern) {
  options.push({
    id: "add-to-lectern",
    label: "Add to Lectern",
    onSelect: input.onAddToLectern,
  });
}
```
Wired in each surface that renders `mediaResourceOptions` (library entries,
media pane, search rows). `episodeResourceOptions` receives an identical addition —
same `id: "add-to-lectern"` option keyed off `input.onAddToLectern` — and is adopted
in every surface that renders episode rows (podcast pane, search rows).

### 7.9 Launcher queue verb

`lib/launcher/model.ts` `LauncherActionTarget` gains:
```typescript
| { kind: "queue-add"; mediaId: string; title: string }
```
`dispatchTarget` in `dispatch.ts` handles `case "queue-add"`: calls
`addConsumptionQueueItems([target.mediaId], 'last', null)` then shows a
`feedback.show({ severity: "success", title: "Added to Lectern" })` toast.

`lib/launcher/providers.ts`: media result rows gain `trailingAction`:
```typescript
trailingAction: { target: { kind: "queue-add", mediaId: item.id, title: item.title }, ariaLabel: "Add to Lectern" }
```

---
## 8. Key decisions

**D-1. UNIQUE(user_id, media_id) kept; re-queue is move-not-duplicate.**
Adding an already-queued item moves it to the requested position (delete then
re-insert at target position within the same transaction). The constraint stays.
*Rejected:* Loosening to allow duplicates — a work appears once in the reading list
(re-queueing mid-session doesn't add a second copy).

**D-2. One queue, not two.**
There is no separate "reading queue" beside a "playback queue". The same table,
ordered list, and API family serve all kinds. The player's advance and the reader's
prompt each filter by kind; the Lectern renders both.
*Rejected:* Parallel queues — doubles the API surface, breaks the "one queue
position per work" invariant, and produces an impossible UI question: which queue
does "Add to queue" hit?

**D-3. Swipe-in-Lectern removes; other surfaces use the action menu for add.**
`CollectionRow` is structurally single-swipe (`swipeActions?.[0]`, `useRowSwipe`
single callback). In library/search surfaces, the existing delete-swipe is the right
default gesture — overriding it with an add-to-queue swipe would destroy the
established muscle memory and the tone (`ritual, not friction`). The Lectern pane
owns a context where swipe = remove from queue (the obvious action on a queue view).
*Rejected:* Swipe-to-queue on library rows — breaks the delete swipe; per-kind
switching makes the gesture unreliable.

**D-4. Mobile queue button opens the Lectern pane, not a MobileSheet copy.**
The MobileSheet variant of the queue panel would be a third rendering of the same
data. On mobile, the Lectern is the queue; tapping "Queue" in the expanded player
navigates to it. `GlobalPlayerConsumptionPanel` stays as an audio-only desktop
instrument.
*Rejected:* MobileSheet queue panel — three renderings of one list; the Lectern is
already mobile-navigable.

**D-5. Text-media queueability gate widens at the service layer, not the schema.**
`_assert_media_ids_queueable` in `consumption_queue.py` accepts `kind IN
('web_article', 'epub', 'pdf', 'podcast_episode', 'video')` and a visible media
check, dropping the `derive_playback_source` gate. No migration needed; the table
FK has never restricted kind.
*Rejected:* A separate "readable" field on the queue row — unnecessary; `kind` from
the `media` join is sufficient at read time.

**D-6. Player advance filters at the API, not the FE.**
`GET /queue/next` scopes to audio kinds server-side. The FE player calls
`fetchNextAudioQueueItem` and gets an audio item or null — no FE kind-filter logic.
Text items in the queue between audio items are silently skipped (they stay in
position; `queue/next` finds the first audio item after `current_media_id` by
scanning forward).
*Rejected:* FE-side kind filter — requires the FE to fetch the full queue and scan;
the server already has the query.

**D-7. Reader prompt is threshold-based on saved state, not scroll-event.**
`MediaPaneBody` already captures reader movement (now `reportReaderMovement`, post reader-progress-continuity cutover) which writes
`locator.locations.total_progression`. A new `currentTotalProgression` state variable
(§7.7) mirrors this value in React; a `useEffect` watching it fires the fetch — no
new scroll event listener, no intersection observer.
*Rejected:* Intersection observer on a sentinel element — would require injecting a
DOM node at the document end, which conflicts with the reader's text rendering
contract.

**D-8. 'assistant' source added in this migration, not amanuensis.**
The amanuensis spec (`amanuensis-hard-cutover.md` §10) requires this migration to
land first; the CHECK widening to include `'assistant'` belongs here to avoid a
split schema. Amanuensis never touches the migration file.

---
## 9. What dies (exhaustive)

**Table:** `playback_queue_items` — renamed, not dropped.

**Constraints (renamed, old names gone):**
- `uq_playback_queue_items_user_media`
- `ck_playback_queue_items_position_non_negative`
- `ck_playback_queue_items_source`
- `ix_playback_queue_items_user_position`

**ORM class:** `PlaybackQueueItem` — renamed `ConsumptionQueueItem`.

**ORM back-populates:** `User.playback_queue_items` → `User.consumption_queue_items`;
`Media.playback_queue_items` → `Media.consumption_queue_items`.

**Service:** `python/nexus/services/playback_queue.py` — deleted; all symbols
migrate to `consumption_queue.py`. Constants `QUEUE_SOURCE_MANUAL`,
`QUEUE_SOURCE_AUTO_SUBSCRIPTION`, `QUEUE_SOURCE_AUTO_PLAYLIST` move; new
`QUEUE_SOURCE_ASSISTANT = "assistant"`.

**Schemas:** `python/nexus/schemas/playback.py` — deleted; `schemas/queue.py` is the
replacement. `PlaybackQueueItemOut`, `PlaybackQueueListeningStateOut`,
`PlaybackQueueAddRequest`, `PlaybackQueueOrderRequest`, `PlaybackQueueInsertPosition`,
`PlaybackQueueSource` all gone (renamed counterparts live in `schemas/queue.py`).

**Routes (BE):** `api/routes/playback.py` — pre-build audit confirms the file contains
exclusively the six `/playback/queue*` routes. The file is deleted in full; no
player-state endpoints require preservation.

**BFF routes (FE):** `apps/web/src/app/api/playback/queue/` directory and all files:
`route.ts`, `items/route.ts`, `items/[itemId]/route.ts`, `order/route.ts`,
`clear/route.ts`, `next/route.ts` — all deleted.

**FE client:** `lib/player/playbackQueueClient.ts` — deleted. Exports:
`fetchPlaybackQueue`, `addPlaybackQueueItems`, `removePlaybackQueueItem`,
`reorderPlaybackQueue`, `clearPlaybackQueue`, `fetchNextPlaybackQueueItem`,
`countUpcomingQueueItems`, `PLAYBACK_QUEUE_UPDATED_EVENT`, type
`PlaybackQueueItem`, `PlaybackQueueInsertPosition` — all gone, replaced in
`consumptionQueueClient.ts`.

**FE component:** `GlobalPlayerQueuePanel.tsx` — renamed `GlobalPlayerConsumptionPanel.tsx`.
CSS classes that referenced "Playback queue" in `aria-label` and heading text change
to "Up next".

**Tests:**
- `__tests__/components/GlobalPlayerQueue.test.tsx` — renamed to match renamed
  component; test descriptions updated. Screenshot directories deleted and regenerated.
- `python/tests/test_playback_queue.py` — deleted; replaced by
  `python/tests/test_consumption_queue.py` which covers the new `/queue*` endpoints.
  (All HTTP calls in `test_playback_queue.py` reference `/playback/queue*`; every test
  must be updated to hit the new paths.)

**What is NOT deleted:**
- `GlobalPlayerFooter.tsx` — stays; queue-button behavior changed on mobile; badge
  display (`queueBadge`) removed per N-5.
- `SortableList.tsx` — shared primitive, unchanged.
- Player listening state, audio effects, podcast listening states — entirely separate
  from the queue; untouched.
- `__tests__/helpers/audio.ts`, `GlobalPlayerAudioEffects.test.tsx`,
  `GlobalPlayerPersistence.test.tsx`, `GlobalPlayerMediaSession.test.tsx` — modified
  (mock `source_url` → `stream_url` update) but not deleted.

---
## 10. Sibling cutovers and sequencing

**`amanuensis-hard-cutover.md` (SPEC, same batch):** Explicitly gated on this
spec (`amanuensis §10, §11 S6`): `queue_add` tool writes `consumption_queue_items`
with `source='assistant'`. This spec's migration (`NNNN_consumption_queue.py`) and
`consumption_queue.py` service must be merged before amanuensis S6 is built. Both
specs carry this sequencing line.

**`running-journal-hard-cutover.md`:** The final typed header contract supersedes
the earlier standalone standing-head plan. This spec adds `"lectern"` to
`PaneRouteId` together with its section-header contract; the destination registry
provides the natural-case `"Lectern"` label.

**`browse-surface-deletion-hard-cutover.md` (SPEC):** Deletes `"browse"` from
`PaneRouteId` and the `{ id: "browse", slot: "primary" }` DESTINATIONS entry. Mobile
nav ordering in this spec accounts for browse being absent.

**`daily-surface-consolidation-hard-cutover.md` (SPEC):** Deletes `"daily"` and
`"dailyDate"` from `PaneRouteId` and the `{ id: "today", slot: "primary" }` entry.
Mobile nav ordering in this spec accounts for today being absent.

**`attention-ledger-hard-cutover.md` (SPEC, same batch):** shares `presenters/media.ts`
(media-row swipe), `resourceActions.ts`, and `MediaPaneBody.tsx` with this spec.
Attention-ledger replaces the media-row delete swipe with mark-finished (its D-11); this
spec's D-3 keeps delete-swipe on library rows *by not editing that swipe* (Lectern-pane
swipe=remove is on its own rows), so attention-ledger owns the library media-row swipe —
no code conflict. This spec reads `progress_fraction`/`read_state` in Lectern rows (§7.3);
after attention-ledger those fields are derived by `consumption_state()` — same field
names, no change needed here. If both land, sequence attention-ledger's `MediaPaneBody`
edits and this spec's `LecternNextPrompt`/`currentTotalProgression` additively (disjoint
regions).

**`walknotes-hard-cutover.md` (SPEC):** also edits `GlobalPlayerFooter.tsx` (adds Mark +
hold-to-speak + review). This spec edits the same file (mobile queue button → `/lectern`,
`queueBadge` removal). Disjoint regions; merge additively.

**Shared files requiring coordination:**
- `lib/navigation/destinations.ts`: this spec adds the `lectern` entry; browse-surface
  and daily-surface specs delete `browse` and `today` entries; all three must apply
  without conflict (all additive/deletive to the same array, no ordering overlap).
- `lib/panes/paneRouteModel.ts`: this spec adds `"lectern"`; browse and daily specs
  delete `"browse"`, `"daily"`, `"dailyDate"`; no conflict if applied in sequence.
- `lib/actions/resourceActions.ts`: this spec adds `onAddToLectern` to
  `mediaResourceOptions`/`episodeResourceOptions`. **`attention-ledger-hard-cutover.md`
  (SPEC, same batch) also edits this file** (adds mark-finished/unread to
  `mediaResourceOptions`) and **`one-press-artifact-engine-hard-cutover.md` adds
  `distill-conversation` to `conversationResourceOptions`** — all additive, distinct
  push sites, no conflict.

---
## 11. Slices (each independently buildable)

**S0 — Migration + ORM rename (mechanical)**
Rename table, constraints, indexes. Rename ORM class `PlaybackQueueItem` →
`ConsumptionQueueItem`; rename back-populate attributes on `User` and `Media`.
Update `media_deletion.py:518,668`. Update `podcasts/ingest.py:430`.
No service logic changes yet; old service imports renamed model.
*Verify:* `make test-migrations` (up + down); `cd python && uv run ruff check . && uv run pyright`; `rg 'playback_queue_items' python/ --include='*.py'` → only migration history.

**S1 — New service + schemas + BE routes**
Delete `services/playback_queue.py`. Create `services/consumption_queue.py` (same
logic, renamed symbols, widened source set, widened queueability gate to all 5 kinds,
new `ConsumptionQueueItemOut` with full field contract per §6.4).
Delete `schemas/playback.py`; create `schemas/queue.py`.
Delete `api/routes/playback.py` entirely (queue-only, per §9).
Create `api/routes/queue.py` with the `/queue` family incl. `?kind_filter` param and
`GET /queue/next?kind=audio|readable`.
Register `queue_router` in `python/nexus/api/routes/__init__.py` **outside** the
`if settings.podcasts_enabled:` guard — the queue serves web articles, epubs, and
PDFs regardless of podcast feature flag. Delete the `playback_router` import and
`include_router` call (inside that guard).
*Verify:* `python/tests/test_consumption_queue.py` (new); `uv run pyright`.

**S2 — BFF routes + FE client**
Delete `app/api/playback/queue/` tree.
Create `app/api/queue/` with 6 route files (proxy pattern matching S1 paths).
Delete `lib/player/playbackQueueClient.ts`; create `lib/player/consumptionQueueClient.ts`.
Update all imports in `globalPlayer.tsx`, `GlobalPlayerFooter.tsx`.
*Verify:* `cd apps/web && bun run typecheck`; `bun run test:unit`.

**S3 — Lectern pane**
Add `"lectern"` to `PaneRouteId`, `PANE_ROUTE_MODELS`, `paneRouteTable.ts` chrome entry.
Add lectern entry to `DESTINATIONS`.
Create `app/(authenticated)/lectern/page.tsx` and `LecternPaneBody.tsx`.
Create `LecternPaneBody.test.tsx` (browser test).
*Verify:* `bun run typecheck && bun run test:browser -t lectern`.

**S4 — GlobalPlayerConsumptionPanel + mobile footer**
Rename `GlobalPlayerQueuePanel.tsx` → `GlobalPlayerConsumptionPanel.tsx`.
Remove `kindFilter` prop; add internal AUDIO_KINDS filter and "Open Lectern" footer link.
Remove `countUpcomingQueueItems` + `upcomingQueueCount` useMemo from `globalPlayer.tsx`;
remove `queueBadge` display from `GlobalPlayerFooter.tsx`.
Fix track construction: `source_url: queueItem.stream_url ?? ""`.
Update `source_url` → `stream_url` in `__tests__/helpers/audio.ts`,
`GlobalPlayerAudioEffects.test.tsx`, `GlobalPlayerPersistence.test.tsx`,
`GlobalPlayerMediaSession.test.tsx`.
Change `openQueueFromMobileExpanded` to open `/lectern` pane.
Rename test file `GlobalPlayerQueue.test.tsx` → `GlobalPlayerConsumptionPanel.test.tsx`.
Update `GlobalPlayerFooter.tsx` import.
*Verify:* `bun run test:browser -t GlobalPlayer` (the audio queue + persistence +
audio effects + media session tests must all pass); additionally run
`rg 'source_url' apps/web/src/__tests__/ --include="*.ts" --include="*.tsx"` → zero.

**S5 — Action menu, launcher verb, swipe-in-Lectern**
`resourceActions.ts`: add `onAddToLectern` to `mediaResourceOptions` +
`episodeResourceOptions`.
Adopt in library entry rows, search rows, media pane action menu.
`lib/launcher/model.ts`: add `"queue-add"` target.
`lib/launcher/dispatch.ts`: handle `case "queue-add"`.
`lib/launcher/providers.ts`: add `trailingAction` to media result rows.
`LecternPaneBody.tsx`: add swipe action (remove) to `LecternRowView`.
*Verify:* `bun run typecheck && bun run test:unit && bun run test:browser`.

**S6 — Reader end-of-document prompt**
Create `LecternNextPrompt.tsx`.
`MediaPaneBody.tsx`: add `currentTotalProgression` state; update scroll-save callback
to call `setCurrentTotalProgression`; `useEffect` on `currentTotalProgression` fetches
`GET /api/queue/next?kind=readable` at threshold 0.95; render `LecternNextPrompt`;
handle tap (remove + openInNewPane).
*Verify:* `bun run test:browser -t "LecternNextPrompt"` + typecheck.

---
## 12. Acceptance criteria (testable)

**AC-1.** Queuing a web article and a podcast episode — in that order — yields a
Lectern list of two items: article first (position 0), episode second (position 1).
Both appear together in `GET /queue`. (Unit test, `consumption_queue.py`.)

**AC-2.** `GET /queue?kind_filter=audio` returns only the episode from AC-1.
`GET /queue?kind_filter=readable` returns only the article. (Unit test.)

**AC-3.** Player finishing the episode while the article is in the queue: the
`handleEnded` callback calls `GET /queue/next?current_media_id=<episode-id>`.
Because no audio item follows, the response is null; playback stops. The article
remains in the queue untouched. (Browser test, `GlobalPlayerConsumptionPanel.test.tsx`.)

**AC-4.** Player `next` skip: episode → article → second episode in queue order.
`GET /queue/next?current_media_id=<first-episode-id>` returns the second episode,
skipping the article. (Unit test on `queue.py` route.)

**AC-5.** Podcast subscription sync with `auto_queue=true` delivers new episodes
with `source='auto_subscription'` unchanged after the rename.
(Integration test on `podcasts/ingest.py`.)

**AC-6.** `rg 'playback_queue_items' python/ --include='*.py'` returns only
migration history files — no live code references.

**AC-7.** `rg 'from nexus.services.playback_queue\|import playback_queue' python/ --include='*.py'`
returns zero results.

**AC-8.** Lectern nav entry appears in `NAV_MODEL` with `slot: "primary"`.
`rg '"lectern"' apps/web/src/lib/navigation/destinations.ts` returns one hit with
`slot: "primary"`. (Unit test in pane identity tests.)

**AC-9.** On mobile viewport, "Queue" button in GlobalPlayerFooter expanded sheet
does NOT open `GlobalPlayerConsumptionPanel` overlay; it calls
`requestOpenInAppPane('/lectern', ...)`. (Browser test in GlobalPlayerFooter suite.)

**AC-10.** Reader end-of-document prompt: when `currentTotalProgression >= 0.95`, a
"Next on the lectern: <title>" button appears at document bottom. Tapping it
removes the current item from the queue and opens the next readable entry. Below
0.95, the prompt is absent. (Browser test in `MediaPaneBody.test.tsx`.)

**AC-11.** Re-queuing an already-queued item moves it (no duplicate): `POST
/queue/items` with an already-queued `media_id` + `insert_position: "next"` results
in one item at the requested position, not two. (Unit test.)

**AC-12.** Action menu on a library media row includes "Add to Lectern" option when
`onAddToLectern` is wired. (Browser test on `LibraryPaneBody.test.tsx`.)

**AC-13.** Action menu on a podcast episode row includes "Add to Lectern" option when
`onAddToLectern` is wired in `episodeResourceOptions`. (Browser test in
`GlobalPlayerConsumptionPanel.test.tsx` or a dedicated episode-row test.)

---
## 13. Negative gates (grep-able)

```bash
# Gate G-1: no live reference to the old table name
rg 'playback_queue_items' python/ --include='*.py' \
  --exclude-dir='__pycache__' \
  | grep -v 'migrations/alembic/versions/'
# Expected: no output

# Gate G-2: old service import deleted
rg 'services[./]playback_queue|from nexus\.services\.playback_queue|import playback_queue_service' \
  python/ --include='*.py'
# Expected: no output

# Gate G-3: old schema module deleted
rg 'schemas[./]playback|from nexus\.schemas\.playback' \
  python/ --include='*.py'
# Expected: no output

# Gate G-4: old BFF queue routes deleted
rg 'api/playback/queue' apps/web/src --include='*.ts' --include='*.tsx'
# Expected: no output

# Gate G-5: old FE client deleted
rg 'playbackQueueClient|fetchPlaybackQueue|addPlaybackQueueItems|removePlaybackQueueItem|reorderPlaybackQueue|clearPlaybackQueue|PLAYBACK_QUEUE_UPDATED_EVENT' \
  apps/web/src --include='*.ts' --include='*.tsx'
# Expected: no output

# Gate G-6: old component deleted
rg 'GlobalPlayerQueuePanel' apps/web/src --include='*.ts' --include='*.tsx'
# Expected: no output

# Gate G-7: sole writer contract — only consumption_queue.py writes to the table
rg 'consumption_queue_items' python/ --include='*.py' \
  | grep -v 'migrations/\|services/consumption_queue.py\|services/media_deletion.py'
# Expected: no output (media_deletion.py is the cascade cleaner, allowed)
```

Vitest source-grep assertion (in `pane identity` unit suite):
```typescript
it("lectern destination has primary slot", () => {
  const dest = DESTINATIONS.find(d => d.id === "lectern");
  expect(dest?.slot).toBe("primary");
});
```

---
## 14. Test plan

### Unit (.test.ts — Node, no DOM)
- `consumption_queue.test.ts`: list, add, remove, reorder, clear, re-queue-as-move,
  queueability gate for all 5 kinds, `kind_filter` param, podcast auto-queue.
- `resourceActions.test.ts`: `mediaResourceOptions` and `episodeResourceOptions` with
  `onAddToLectern` wired and unwired.
- `lectern-destination.test.ts`: DESTINATIONS contains lectern with `slot: "primary"`;
  `PaneRouteId` exhaustive check includes `"lectern"`.

### Browser (.test.tsx — Chromium)
- `GlobalPlayerConsumptionPanel.test.tsx` (renamed from `GlobalPlayerQueue.test.tsx`):
  audio-only filter, "Open Lectern" link, existing audio-queue tests pass with new
  names.
- `GlobalPlayerFooter.test.tsx`: mobile queue button calls
  `requestOpenInAppPane('/lectern', …)`, does not set `queueOpen` state.
- `LecternPaneBody.test.tsx`: renders items, first-item emphasis, reorder, remove,
  swipe-to-remove, empty state.
- `MediaPaneBody.test.tsx`: at `currentTotalProgression >= 0.95`, `LecternNextPrompt` renders;
  tap calls remove + openInNewPane; below threshold, prompt absent.

### Guards
```bash
cd apps/web && bun run typecheck && bun run lint
```
Both must be clean. The exhaustive `PANE_ROUTE_MODELS` definition makes a
missing Lectern route/header contract a type or route-table failure in this
build.

### BE static
```bash
cd python && uv run ruff check . && uv run pyright
```

### BE integration
```bash
make test-back-integration  # full suite; focused: -k "queue or lectern"
make test-migrations        # up + down
```

### E2E (not run at spec time)
- Navigate to `/lectern` on mobile; verify Lectern is first nav item.
- Queue an article from a library row; open Lectern; verify it appears.
- Play an episode to completion; verify player stops (no audio item follows).
- Read an article to end; verify prompt appears; tap it; verify navigation.

---
## 15. Files (created / modified / deleted)

### Created
- `python/nexus/migrations/alembic/versions/NNNN_consumption_queue.py`
- `python/nexus/services/consumption_queue.py`
- `python/nexus/schemas/queue.py`
- `python/nexus/api/routes/queue.py`
- `apps/web/src/app/api/queue/route.ts`
- `apps/web/src/app/api/queue/items/route.ts`
- `apps/web/src/app/api/queue/items/[itemId]/route.ts`
- `apps/web/src/app/api/queue/order/route.ts`
- `apps/web/src/app/api/queue/clear/route.ts`
- `apps/web/src/app/api/queue/next/route.ts`
- `apps/web/src/lib/player/consumptionQueueClient.ts`
- `apps/web/src/app/(authenticated)/lectern/page.tsx`
- `apps/web/src/app/(authenticated)/lectern/LecternPaneBody.tsx`
- `apps/web/src/app/(authenticated)/lectern/LecternPaneBody.module.css`
- `apps/web/src/components/GlobalPlayerConsumptionPanel.tsx`
- `apps/web/src/components/LecternNextPrompt.tsx`
- `apps/web/src/__tests__/components/GlobalPlayerConsumptionPanel.test.tsx`
- `apps/web/src/__tests__/components/LecternPaneBody.test.tsx`
- `python/tests/test_consumption_queue.py`

### Modified
- `python/nexus/db/models.py` — rename class, back-populates, constraint names
- `python/nexus/services/media_deletion.py:518,668` — table name
- `python/nexus/services/podcasts/ingest.py:430` — service import
- `python/nexus/api/routes/__init__.py` — register `queue_router` (outside `podcasts_enabled` guard); remove `playback_router` import and `include_router` call
- `apps/web/src/lib/panes/paneRouteModel.ts` — add `"lectern"` to union + model
- `apps/web/src/lib/panes/paneRouteTable.ts` — add lectern chrome entry
- `apps/web/src/lib/navigation/destinations.ts` — add lectern destination
- `apps/web/src/lib/actions/resourceActions.ts` — add `onAddToLectern` to `mediaResourceOptions` + `episodeResourceOptions`
- `apps/web/src/lib/launcher/model.ts` — add `"queue-add"` target
- `apps/web/src/lib/launcher/dispatch.ts` — handle `case "queue-add"`
- `apps/web/src/lib/launcher/providers.ts` — add trailingAction to media rows
- `apps/web/src/lib/player/globalPlayer.tsx` — import rename; `fetchNextAudioQueueItem`; track construction `source_url: queueItem.stream_url ?? ""`; remove `countUpcomingQueueItems` import and `upcomingQueueCount` useMemo
- `apps/web/src/components/GlobalPlayerFooter.tsx` — mobile queue button; remove badge (`queueBadge` span + aria-label count); import rename
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx` — add `currentTotalProgression` state; update scroll-save callback; `LecternNextPrompt` integration
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.test.tsx` — AC-10 browser tests for `LecternNextPrompt` at threshold 0.95
- `apps/web/src/__tests__/components/GlobalPlayerFooter.test.tsx` — mobile queue test; badge-removed assertion
- `apps/web/src/__tests__/helpers/audio.ts` — mock track construction `source_url` → `stream_url`
- `apps/web/src/__tests__/components/GlobalPlayerAudioEffects.test.tsx` — mock queue item `source_url` → `stream_url`
- `apps/web/src/__tests__/components/GlobalPlayerPersistence.test.tsx` — mock queue item `source_url` → `stream_url`
- `apps/web/src/__tests__/components/GlobalPlayerMediaSession.test.tsx` — mock queue item `source_url` → `stream_url`

### Deleted
- `python/nexus/services/playback_queue.py`
- `python/nexus/schemas/playback.py`
- `python/nexus/api/routes/playback.py` (queue-only; deleted in full)
- `python/tests/test_playback_queue.py` (replaced by `test_consumption_queue.py`)
- `apps/web/src/app/api/playback/queue/` (entire directory)
- `apps/web/src/lib/player/playbackQueueClient.ts`
- `apps/web/src/components/GlobalPlayerQueuePanel.tsx`
- `apps/web/src/__tests__/components/GlobalPlayerQueue.test.tsx`
- `apps/web/src/__tests__/components/__screenshots__/GlobalPlayerQueue.test.tsx/` (dir)

---
## 16. Risks

**R-1. Player regression — tests enumerate (HIGH).**
`GlobalPlayerFooter.test.tsx`, `GlobalPlayerAudioEffects.test.tsx`,
`GlobalPlayerMediaSession.test.tsx`, `GlobalPlayerPersistence.test.tsx`, and
`__tests__/helpers/audio.ts` all construct mock queue items or tracks with
`source_url`. After S2 drops `source_url` from `ConsumptionQueueItem`, every mock
with a `source_url` field is either a type error or silently passes a stale field.
*Mitigation:* S4 is atomic — rename component, update all imports, and update all
`source_url` → `stream_url` mock sites in a single slice before marking done. The
negative gate G-5 does not catch `source_url` in mock objects; run
`rg 'source_url' apps/web/src/__tests__/ --include="*.ts" --include="*.tsx"` → zero
output is an additional gate.

**R-2. Swipe-conflict with delete on non-Lectern surfaces (LOW).**
Decision D-3 resolves this by leaving delete-swipe on library rows unchanged. The
risk is an implementer accidentally changing `swipeActions` in the media presenter
to queue-add. *Mitigation:* AC-12 and the presenter tests verify the action appears
in the menu, not as a swipe. Negative gate: `rg 'add-to-lectern.*swipe\|swipe.*add-to-lectern'` → zero.

**R-3. Re-queue UPSERT race (LOW).**
If two concurrent requests add the same media_id for the same user, the UNIQUE
constraint will catch the second. *Mitigation:* the service's `_insert_media_ids_for_viewer`
already skips `existing_media_ids` before inserting; the move-not-duplicate path
wraps in the existing `transaction()` context. No new concurrency risk introduced.

**R-4. Readable-kind end-of-document fetch latency (LOW).**
Fetching `GET /api/queue/next?kind=readable` at the 0.95 progression threshold may be
slow on a cold queue load. *Mitigation:* the prompt only appears after progression ≥ 0.95
(late in a long document); a 200–500 ms fetch is imperceptible at that point. If the
fetch fails, the prompt simply doesn't render — non-fatal.

**R-5. migration number collision with dawn-write or search-roadmap (MEDIUM).**
*Mitigation:* placeholder `NNNN` in filename; assigned at build time after checking
the live main chain and any pending merges. Note in the migration header.
