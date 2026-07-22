# Player Module

## Scope

The player module owns two related but distinct concerns: the **Lectern** (one
ordered, mixed-media list of outstanding intentions) and **Now Playing** (one
device-local audio session, not a second durable list). Podcast, video, reader,
agent, and Launcher actions address the ordered list. The Resonance subsystem's
read-only **At hand** Slate is adjacent to the Lectern but does not become
another queue or acquire mutation ownership. The player is the consumer of
podcast episodes (and YouTube videos) for playback; the
[podcast module](podcast.md) owns discovery, sync, and transcription, and
hands episodes to the Lectern via auto-subscription.

Full behavioral contracts, wire shapes, and acceptance criteria:
`docs/cutovers/lectern-player-lifecycle-hard-cutover.md` and
`docs/cutovers/resonance-reading-slate-hard-cutover.md`.

## Backend Owners

`python/nexus/services/consumption/` is the sole backend consumption owner,
split one table per store:

- `service.py` — the public boundary. Two command facades
  (`run_lectern_command` / `run_consumption_command`) each open a fresh
  session and own one `retry_serializable` transaction: viewer lock -> replay
  claim -> validation -> domain writes -> semantic memo -> snapshot read. Read
  facades (`get_lectern` / `get_listening_state`) run on the request-scoped
  session. Policy-neutral engagement, recent-anchor, complete membership, and
  item-count ports are consumed by Resonance. Two narrow
  in-transaction exceptions compose here rather than going
  through a command: `ensure_missing_items_in_txn` (the auto-subscription
  watermark step; only caller is `services/podcasts/poll.py`) and
  `delete_media_consumption_state_in_txn` (media teardown; only caller is
  `services/media_deletion.py`).
- `_lectern_store.py` — sole DML owner of `consumption_queue_items` (Lectern
  membership/order). Builds the canonical `LecternSnapshot`.
- `_state_store.py` — sole DML owner of `consumption_overrides` (explicit
  `Unread`/`Finished` state).
- `_listening_store.py` — sole DML owner of `podcast_listening_states`
  (position/duration/speed, completion flag, and the heartbeat fencing tokens
  `write_revision`/`reset_epoch`). `last_engaged_at` is advanced by successful
  heartbeats only. The separate operational `updated_at` still advances for
  manual Finished/Unread mutations; those state-only commands preserve
  `last_engaged_at`, and a new manual-Finished row starts with it absent.
  Migration 0185 seeds the new clock from operational `updated_at` only when
  post-fencing state proves the latest mutation was a heartbeat: revision is
  positive, completion is false, and either position is positive or no reset
  has occurred. Pre-fencing, completed, and post-reset zero-position rows remain
  absent because their timestamp is ambiguous.
- `_reader_engagement_store.py` — sole DML owner of `reader_engagement_states`:
  one current-state row per (viewer, media) carrying `last_engaged_at`
  recency and, for non-PDF locators, a monotonic `max_total_progression`
  (`GREATEST(existing, new)` on every save). No session, device, span, dwell,
  or event-history rows exist — a save is a plain idempotent
  `INSERT ... ON CONFLICT (user_id, media_id) DO UPDATE`, with no fencing
  token, composed by the reader-state route after a successful/idempotent
  cursor write (see [reader-implementation.md](reader-implementation.md)).
- `_projection.py` — the combined explicit-override + reader-engagement read
  model (`Unread`/`InProgress`/`Finished` + progress fraction), plus batched
  `PlayerDescriptor`s for podcast-episode media, reusing
  `services/playback_source.derive_playback_source` exactly as a Lectern item
  does (listening join + chapters + artwork/title). `services/media.py`,
  `services/library_entries.py`, and `services/podcasts/{episodes,
  subscriptions_query}.py` adopt this projection; no other module reads
  `consumption_overrides`/`podcast_listening_states`/`reader_engagement_states`
  directly except the one documented exception in `services/media.py`
  (`MediaOut.listening_state`, a raw passthrough of position/duration/speed
  distinct from the derived read-state projection).

`python/nexus/services/resonance/` owns the deterministic Reading Slate. It
combines Consumption-owned Continuity with media- and podcast-owned Arrival
facts plus policy-neutral graph, contributor, and calibrated semantic evidence,
then returns at most ten placeable media outside the complete queue. `Finished`
targets are excluded; finished resources may still serve as anchors. The request
performs no model or provider call and uses one repeatable-read, read-only
database snapshot.

Media teardown (`docs/cutovers/lectern-player-lifecycle-hard-cutover.md` §3.1;
see also [storage.md](storage.md)) composes one consumption call,
`consumption_service.delete_media_consumption_state_in_txn` (all users'
Lectern/override/listening/reader-engagement rows), inside the deletion
transaction — `services/media_deletion.py` never writes those tables
directly.

`python/nexus/services/playback_source.py` resolves the playable source for a
media item (`derive_playback_source`); it is shared by the projection, the
media/podcast DTOs, and the Lectern snapshot so activation derivation
(`FooterAudio` / `Readable` / `OpenPane`) is identical everywhere.

## Command and Heartbeat Ports

```http
GET  /lectern
GET  /lectern/slate
POST /lectern/commands
POST /consumption/commands
GET  /media/{id}/listening-state
PUT  /media/{id}/listening-state
```

`python/nexus/api/routes/lectern.py` owns the Lectern reads and two
transport-only command ports; `python/nexus/api/routes/listening_state.py`
owns the singular heartbeat GET/PUT (no batch endpoint). The two POST ports
are bounded aggregate command ports, not a generic command bus: `Lectern`
commands (`PlaceItems`/`RemoveItem`/`SetOrder`) and `Consumption` commands
(`EnsureMediaFinished`/`FinishLecternItem`/`SetUnread`/`SetBatchState`) each
share one transaction/replay scope (`Lectern.Commands` /
`Consumption.Commands`) and one canonical response. POST is
semantic-idempotent through a client-generated `clientMutationId`, keyed by
`(viewerId, mutationScope, clientMutationId)` through the shared
`services/resource_mutation_replay.py` ledger. The listening-state PUT is a
separate, unreplayable CAS mutation fenced by `write_revision`/`reset_epoch`
(§5.4) — it never memoizes and never reuses the command replay ledger. It
writes only position/duration/speed; the heartbeat carries no client-supplied
elapsed-time delta and no client-supplied device identifier, and piggybacks
no other table's write — reading engagement is recorded on its own path (see
[reader-implementation.md](reader-implementation.md)), independent of the
listening heartbeat.

Owned-absence fields on every wire shape use `Presence<T>` from
`nexus/schemas/presence.py` / `apps/web/src/lib/api/presence.ts`
([rules/boundaries.md](../rules/boundaries.md)) — never `null` or omission.

## Frontend Owners

`AuthenticatedShell.tsx` mounts `LecternProvider` (one `AsyncResource` + one
mutation FIFO that owns every Lectern/consumption mutation and reconciliation
GET) above `GlobalPlayerProvider` (one `PlayerSession`), which wraps
`WorkspaceHost` and `GlobalPlayerFooter` — a shell-resident `region` labelled
**Media player** that persists across pane navigation and is never an editor
(the Lectern pane is the sole full-list editor).

- `apps/web/src/lib/lectern/` — the Lectern capability: `contract.ts` (the one
  transport-free, isomorphic owner of every Lectern/consumption wire type and
  strict decoder), `client.ts` (HTTP calls only), `LecternProvider.tsx` (the
  FIFO + optimistic-mutation owner), and `useCompletionUndo.ts` (the ten-second
  Undo toast after explicit exact completion). Server pane seeding imports the
  pure contract directly and never imports the browser transport facade.
- `apps/web/src/app/(authenticated)/lectern/LecternPaneBody.tsx` renders the
  canonical **On the lectern** collection followed by the shared **At hand**
  Slate. The Slate consumes an optional server first-paint seed, otherwise
  queries on first active mount and every inactive-to-active transition,
  delegates Add to `LecternProvider.placeItems`, and never owns a second
  mutation lane. After success it preserves the exact surviving rows and
  appends at most one novel canonical replacement. `LecternMutationNotice`
  remains the sole assertive owner and Retry surface for an unknown Lectern
  command outcome.
- `apps/web/src/lib/resonance/` and
  `components/collections/ReadingSlateSection.tsx` own strict Slate transport,
  presentation, the destination-keyed read/add/refill state machine, focus,
  and quiet read recovery. They do not own queue state or write commands.
- `apps/web/src/lib/player/` — the audio session: `playerSession.ts` (pure
  session/origin/history/resume state machine, zero React/I-O),
  `listeningHeartbeat.ts` (the single-flight, generation-keyed heartbeat
  engine), `globalPlayer.tsx` (the app-wide `<audio>` element, Web Audio
  effects graph, OS media-session integration), plus `audioEffects.ts`,
  `chapters.ts`, `mediaSession.ts`, `subscriptionPlaybackSpeed.ts`, and
  `usePlayerKeyboardShortcuts.ts`.
- `apps/web/src/components/GlobalPlayerFooter.tsx` — transport, Walknotes
  entry points, and the read-only "Next on the Lectern" / "Forward: _title_"
  preview. The dock is not an editor; all "Open Lectern" affordances navigate
  via `requestOpenInAppPane`.

## Boundary With Podcast Sync

Playback never fetches feeds or writes transcripts. On sync, the podcast
module persists the episode + its `external_playback_url`; auto-subscription
(`services/podcasts/poll.py`) composes `ensure_missing_items_in_txn` in the
same transaction as advancing `podcast_subscriptions.auto_queue_watermark_at`,
so insertion and watermark are one database fact. The Lectern then resolves
and streams that source and the listening heartbeat records position. The
transcript shown alongside playback is the current transcript rendered from
media fragments; the player does not own transcript state.
