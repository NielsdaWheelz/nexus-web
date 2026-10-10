# Player Module

## Scope

The player owns three independent concepts and three synchronizations between
them.

- **Lectern** — the viewer's ordered list of intentions: place, remove, order.
- **Consumption state** — where the viewer stands with a media: an explicit
  override (`finished` / `unread`), else positive podcast listening position
  means in progress, else reader engagement, else
  unread; plus the first-completion fact and the listening position under its
  reset epoch.
- **Audio session** — what one device is playing, owned by exactly one engine
  per device: an `<audio>` element in the browser, the media3 service in the
  Android shell.

The synchronizations: **done** (finish + leave the Lectern + next readable),
**natural end** (fenced finish + leave the Lectern + next audio, settled by
whichever engine heard the end) and **resume** (the server decides where a
play starts; the client asks it at play time). The server picks successors,
decides origin (a media with a visible Lectern row advances at its end, one
off the Lectern stops) and owns the "finished means start over" rule.

**quick reads** and **suggestions** sit beside the
Lectern without owning queue state. Browse owns discovery and Preview; the
[podcast module](podcast.md) owns acquisition and sync. Observed activity and
Stats are [Consumption Activity](consumption-activity.md). Android offline
downloads are adjacent, not player state ([offline](offline.md)).

## Invariants

1. Every write is serializable under the viewer row lock
   (`services/consumption/__init__.py: viewer_txn`).
2. Commands replay by `clientMutationId` (`replayed_command`, memo in
   `resource_mutations`).
3. Listening writes are fenced by `reset_epoch` alone: last writer wins within
   an epoch, a reset wins across epochs. `ResetProgress` bumps the epoch.
4. A natural end retains its captured reset epoch and drains its own heartbeat
   before using the acknowledged override revision. Later unread/reset commands
   supersede it.
5. One audio owner per device: the Android shell plays natively (or shows
   "Update Nexus for Android"), everything else plays in the browser.
6. Raw device ids never leave the BFF; only sealed `ncd1.` handles do.
7. A Lectern holds at most 2000 rows; media teardown removes every consumption
   row of the media.
8. The server owns successor choice, origin and the resume point.

## Backend owners

`python/nexus/services/consumption/`:

- `lectern.py` — sole DML owner of `consumption_queue_items`. Positions are
  dense over visible and hidden rows (a row is hidden while its media is not
  visible to the viewer or is being torn down; hidden rows keep their slots).
  `place` puts a block at the visible boundary or after a visible anchor;
  `set_order` takes the exact visible permutation; `remove_media` returns the
  visible index the row had (where the successor search starts); `restore`
  puts back a removed row with its id and `added_at` (undo only).
- `listening.py` — sole DML owner of `podcast_listening_states` (position,
  duration, nullable episode rate, reset epoch, `last_engaged_at`). A write is
  `UPDATE … WHERE reset_epoch = :epoch`, else an insert when the epoch is 0;
  positions are clamped only to positive duration; an absent rate or duration keeps the
  stored one. `install_preview` writes only when there is no progress.
- `projection.py` — the read model other slices compose: the one read-state
  ladder in SQL (`engagement_fact_rows_sql`, `episode_state_*_sql`), read
  states, recency and anchors, `player_descriptors` and `lectern_snapshot`.
  A descriptor's `positionMs` is 0 when the episode is finished by override;
  `playbackRate` is the episode
  rate ?? the subscription default ?? 1; `podcastId` is present iff the viewer
  subscribes.
- `service.py` — the public facade: `get_lectern`, `get_player`, the Lectern and
  consumption commands, `record_listening`, `install_preview_position`, the
  reader cursor composition, the podcast batch state used by the podcasts
  route, assistant ensure/remove and media teardown. It is the sole DML owner of
  `consumption_overrides`, `reader_engagement_states` and
  `consumption_completion_facts`.
- `activity.py` (span ingest), `exclusions.py`, `stats.py`, `handles.py`,
  `reader_cursor.py` — see [consumption-activity.md](consumption-activity.md)
  and [reader-implementation.md](reader-implementation.md).

## Wire

```http
GET  /lectern                       -> LecternSnapshot
POST /lectern/commands              PlaceItems | RemoveItem | SetOrder
POST /consumption/commands          EnsureMediaFinished | Done | SetUnread | ResetProgress
                                    | UndoFinish | SettleNaturalEnd
GET  /media/{id}/player             -> PlayerDescriptor (404 when not playable)
PUT  /media/{id}/listening-state    {positionMs, durationMs, episodePlaybackRate, expectedResetEpoch} -> Data[ListeningPositionOut]
POST /media/{id}/preview-position   {positionMs, durationMs} -> 204
POST /consumption/activity          {mediaRef, deviceClass, batch} -> 204 (the BFF adds deviceId)
GET  /lectern/suggestions, /lectern/quick-reads   (suggestions)
```

`api/routes/lectern.py` owns the Lectern reads and the two command ports;
`api/routes/playback.py` owns the player read, the listening write, the preview
hand-off and activity capture (registered before the `media` router).

A listening write answers 200 with the accepted
`{positionMs, resetEpoch, consumptionOverrideRevision}` tuple. An accepted
position clears unread and, with known progress at least 95%, writes sticky
finished under the same viewer lock. A stale epoch answers 409
`E_STALE_LISTENING_REVISION` with that tuple in `error.details.current`; the
writer adopts it with no read. A consumption command answers
`ConsumptionResult {outcome: Done |
Superseded | Gone, lectern, nextItem, finishId, progressState,
libraryEntriesCollectionRevision}`; `finishId` (the command's own
`clientMutationId`) is present after EnsureMediaFinished and Done. `nextItem` is present only for `Done` (the
first visible Readable row after the removed one) and `SettleNaturalEnd` (the
first visible FooterAudio row after it), no wrap. `Superseded`: the override
revision or the reset epoch moved. `Gone`: the media is no longer readable.

`UndoFinish {mediaId, finishId, restore?}` is atomic and applies only while the
override is still the one that finish wrote: the finish's replay memo records
the override it replaced (absent, or its status and revision) and the
first-completion fact it created, and the undo puts back exactly that override
(a finish never moves progress, so this is the prior state) and deletes that
fact; after a Done it re-inserts the row with its id and `addedAt` after its
nearest surviving predecessor (first when that is gone). "Mark as played"
changes state only; the row stays where it is.

## Frontend owners

`AuthenticatedShell` mounts `MediaSummaryProvider` above `LecternProvider` and
`GlobalPlayerProvider`, which wraps the workspace and `GlobalPlayerSurfaces`.

- `lib/lectern/contract.ts` — branded ids and the wire projected once into
  domain values. `LecternProvider.tsx` — the snapshot resource and every
  Lectern/consumption command on one promise chain (installs never
  interleave), refetch-then-rethrow on failure, the `progressState` event after
  ResetProgress, and paired progress-fence hooks that drain/gate then reconcile
  mounted owners around unread, reset and undo. `useCompletionUndo.ts`
  — the ten-second "Marked as finished" HUD. `view.ts` — the url-only sort.
- `app/(authenticated)/lectern/LecternPaneBody.tsx` — **On the lectern** (play
  rows, sort, filter, drag reorder in Custom view), Quick reads, At hand.
- `lib/player/playerRuntime.tsx` — `GlobalPlayerProvider`: engine choice, the
  state/timeline context split, device history (previous restarts after 3 s,
  else pops back; next pops forward, else the next Lectern audio row), the fresh
  `GET /api/media/{id}/player` before a play of another media (2 s bound, else
  the descriptor it was given), serialized loads with the latest request
  winning, remember-rate, adoption of a reset elsewhere, keyboard shortcuts.
  Every play of the loaded episode (bar, page, keyboard, transcript) goes to
  its engine, which owns where a resume starts.
- Both engines resume alike. While the device holds a listening sample the
  server may not have ("news": playing, seeking, a write in flight or failed)
  a play resumes in place. Otherwise it asks `GET /media/{id}/player` (2 s;
  unanswered, the page's descriptor stands in when it knows a newer reset
  epoch, else the session itself). An answer that moved the session (another
  position or epoch, or the session ended) is loaded, so a paused episode
  picks up another device's position or reset and the replay of an ended one
  starts at 0 under the fence the end left; otherwise the session resumes in
  place under the answer's override revision. The same holds for the OS
  controls: the Media Session in the browser, the notification and media
  buttons on Android.
- `lib/player/browserEngine.ts` — the `<audio>` engine: listening writes (one
  flight, newest sample; at once on pause, seek and rate; every 15 s while
  playing; `keepalive` on pagehide only with news), the recorder observer, the
  Media Session and the natural-end settle (one id, retried on network or 5xx).
  Only the attached episode samples the shared element: a load detaches the
  outgoing episode after taking its last sample, and its late writes send that. The episode rate
  is sent only after the listener sets one; until then the stored value stands.
- `lib/player/nativeEngine.ts` — the Android engine, a thin client of
  `window.nexusPlayback` (below); a reply missing for 5 s shows "Player
  unavailable" until the next frame arrives.
- `components/player/` — the desktop bar, the mobile mini bar and sheet, and
  `PlayerPanel` (speed, remember for this podcast, pause shortening on Android,
  chapters).

## The Android bridge

`window.nexusPlayback` carries trusted json frames in the grammar of
`window.nexusDownloads`: `{id, op, ...args}` → `{id, ok: true, snapshot?}` |
`{id, ok: false, error}`, and pushed `{snapshot}` on every change and each
second while playing. Ops: `hello{accountId}`, `load{descriptor}`,
`preview{descriptor}`, `play{key, descriptor?}` (the page's descriptor, for
an unanswered resume), `pause{key}`, `seek{key, positionMs}`,
`skip{key, deltaMs}`, `rate{key, value}`, `adopt{key, position}`,
`fence{key}`, `reconcile{key}`,
`volume{value}`, `shortenPauses{on}` (device default),
`sessionShortenPauses{key, on|null}` (this session's override), `dismiss{}`.
The object's name is the compatibility identity: an incompatible change renames
it, and an app without it renders "Update Nexus for Android". There is no
protocol version or hash.

`position` is the accepted `{positionMs, resetEpoch,
consumptionOverrideRevision}` tuple above.

Every snapshot requires `consumptionRevision`. It advances after an acknowledged
listening write so hosted list summaries refresh from accepted facts. Pending
samples do not advance it. Backend, web and Android ship together for this cutover.

unread/reset preparation drains the loaded episode's recorder before sending the
command. a preparation timeout refuses that unsent command through existing
transport feedback. reconciliation drains again before reading authority, even
after a timed-out preparation; a failed read retains the workspace and saving
gate. retry reads only, and separate play/seek resumes activity after adoption.
an adoption timeout after a committed command retains local feedback rather than
reporting that command as refused.

The native service owns ExoPlayer and the media session (notification and lock
screen), listening writes, activity spans in a durable outbox, and natural ends:
it posts `SettleNaturalEnd` itself with the webview's cookies and plays the
returned `nextItem`, so an episode advances with the webview gone. A downloaded
episode plays from its `OfflineStore` lease. Pause shortening is
`skipSilenceEnabled`: this session's override ?? the podcast's mode ?? the
device default, with the time it saved on this device.

## Boundary with podcast sync

Playback never fetches feeds or writes transcripts. Live sync may append
auto-queue episodes through `lectern.ensure_missing_in_txn`; backfill never
enqueues.
