# Player Module

## Scope

The player module owns two related but distinct concerns: the **Lectern** (the
one ordered, mixed-media list of outstanding intentions — podcast, video,
reader, agent, and Launcher actions all address it) and **Now Playing** (one
device-local audio session, not a second durable list). It is the consumer of
podcast episodes (and YouTube videos) for playback; the
[podcast module](podcast.md) owns discovery, sync, and transcription, and
hands episodes to the Lectern via auto-subscription.

Full behavioral contract, wire shapes, and acceptance criteria:
`docs/cutovers/lectern-player-lifecycle-hard-cutover.md`.

## Backend Owners

`python/nexus/services/consumption/` is the sole backend consumption owner,
split one table per store:

- `service.py` — the public boundary. Two command facades
  (`run_lectern_command` / `run_consumption_command`) each open a fresh
  session and own one `retry_serializable` transaction: viewer lock -> replay
  claim -> validation -> domain writes -> semantic memo -> snapshot read. Read
  facades (`get_lectern` / `get_listening_state`) run on the request-scoped
  session. Two narrow in-transaction exceptions compose here rather than going
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
  `write_revision`/`reset_epoch`).
- `_projection.py` — the combined explicit-override + attention-derived read
  model (`Unread`/`InProgress`/`Finished` + progress fraction), plus batched
  `PlayerDescriptor`s for podcast-episode media, reusing
  `services/playback_source.derive_playback_source` exactly as a Lectern item
  does (listening join + chapters + artwork/title). `services/media.py`,
  `services/library_entries.py`, and `services/podcasts/{episodes,
  subscriptions_query}.py` adopt this projection; no other module reads
  `consumption_overrides`/`podcast_listening_states` directly except the one
  documented exception in `services/media.py` (`MediaOut.listening_state`, a
  raw passthrough of position/duration/speed distinct from the derived
  read-state projection).

`python/nexus/services/attention.py` remains the sole writer of
`reading_sessions` (dwell, 30-minute session continuity, `attention_on_day`)
and no longer touches `consumption_overrides`; it exposes only derived session
aggregates (`session_aggregates`, `reading_recency`) to the projection.

Media teardown (`docs/cutovers/lectern-player-lifecycle-hard-cutover.md` §3.1;
see also [storage.md](storage.md)) composes
`consumption_service.delete_media_consumption_state_in_txn` (all users'
Lectern/override/listening rows) and `attention.delete_media_state`
(`reading_sessions`) inside the same deletion transaction —
`services/media_deletion.py` never writes those tables directly.

`python/nexus/services/playback_source.py` resolves the playable source for a
media item (`derive_playback_source`); it is shared by the projection, the
media/podcast DTOs, and the Lectern snapshot so activation derivation
(`FooterAudio` / `Readable` / `OpenPane`) is identical everywhere.

## Command and Heartbeat Ports

```http
GET  /lectern
POST /lectern/commands
POST /consumption/commands
GET  /media/{id}/listening-state
PUT  /media/{id}/listening-state
```

`python/nexus/api/routes/lectern.py` owns the three transport-only routes
above the two command ports; `python/nexus/api/routes/listening_state.py`
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
(§5.4) — it never memoizes and never reuses the command replay ledger.

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

- `apps/web/src/lib/lectern/` — the Lectern capability: `client.ts` (the one
  transport boundary that decodes every Lectern/consumption wire shape into
  owned typed data), `LecternProvider.tsx` (the FIFO + optimistic-mutation
  owner), `useCompletionUndo.ts` (the ten-second Undo toast after explicit
  exact completion).
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
