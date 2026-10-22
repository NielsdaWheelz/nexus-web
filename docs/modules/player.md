# Player Module

## Scope

The player owns three independent concepts and three synchronizations between
them.

- **Lectern** — the viewer's ordered list of intentions: ensure, place, remove, order.
- **Consumption state** — where the viewer stands with a media: an explicit
  override register (`finished` / `unread` / none, with a revision every write
  advances and never reuses), else positive podcast listening position means
  in progress, else reader engagement, else unread; plus the first-completion
  fact and the listening position under its reset epoch.
- **Audio session** — what one device is playing, owned by exactly one engine
  per device: an `<audio>` element in the browser, the media3 service in the
  Android shell.

The synchronizations: **done** (finish + leave the Lectern, then open the next
readable row), **natural end** (fenced finish + leave the Lectern, then play
the next audio row; settled by whichever engine heard the end) and **resume**
(the server decides where a play starts; the client asks it at play time). One
successor rule, on the client (`lecternNext`): the first row of the wanted
activation after the media's row, from the head when it has none; a media off
the Lectern stops at its end. The server owns the "finished means start over"
rule.

**quick reads** and **suggestions** sit beside the
Lectern without owning queue state. Browse owns discovery and Preview; the
[podcast module](podcast.md) owns acquisition and sync. Observed activity and
Stats are [Consumption Activity](consumption-activity.md). Android offline
downloads are adjacent, not player state ([offline](offline.md)).

## Invariants

1. public writes are serializable under the viewer row lock
   (`services/consumption/__init__.py: viewer_txn`). internal lectern primitives
   take the viewer lock inside their caller's transaction; internal append
   callers use read committed.
2. every write is absolute and states its retry rule. lectern commands retain
   their captured order revision: an accepted command advances it, so an old
   retry conflicts even when its intent is already satisfied. a fresh matching
   remove of an absent row still advances the fence. finish re-applies (no
   second completion); unread and reset re-apply (the fences advance again).
3. The override revision is never reused (reset and the clearing of unread
   keep the row). A finish answers `Finish {revision, prior_status,
   completion_id, removed}`; its undo, carrying that answer, applies only while
   the override still holds that revision, and a resend that already landed
   (the next revision, back in the prior status, the fact gone) succeeds.
4. Listening writes are fenced by `reset_epoch` alone: last writer wins within
   an epoch, a reset wins across epochs. Unread, reset and undo bump the epoch.
5. A natural end is fenced on the override revision the device last saw and
   the reset epoch of its terminal sample; a resend that already landed (the
   next revision, finished, the same epoch) succeeds.
6. One audio owner per device: the Android shell plays natively (or shows
   "Update Nexus for Android"), everything else plays in the browser.
7. A Lectern holds at most 2000 rows, hidden ones included; media teardown
   removes every consumption row of the media, and Remove from Nexus removes the
   viewer's row (taking the viewer lock before the media, as teardown does).
8. A mounted reader or player of a media flushes and pauses its unsaved
   progress before unread, reset and undo of that media, and reads the
   server's after (`holdProgress`).
9. A tab's lectern writes go one at a time: membership intents (add, remove,
   play next) in admission order, one per media, each sent at the floor its
   predecessor left (the highest revision the tab knows, from a read or its own
   acknowledgement); a move only on an idle lane at the exact revision on
   screen. A lost answer blocks the lane until "check" or a read past its
   revision settles it; a refusal reaches its caller. A membership write is
   refused as a conflict only when the revision moved, so the lane then waits
   for a read past it; a move's conflict leaves the floor alone, since the
   server also refuses a move whose row went hidden at an unchanged revision.

## Backend owners

`python/nexus/services/consumption/`:

- `lectern.py` — sole DML owner of `consumption_queue_items` and the Lectern
  read. Positions are dense over visible and hidden rows (a row is hidden while
  its media is not visible to the viewer or is being torn down; hidden rows
  keep their slots, since a placement permutes the visible rows through the
  visible slots and a new row takes a new last slot, and they count toward the
  cap). `place` puts one media first or
  after another media's visible row (first when that row is absent or hidden);
  a null placement only ensures membership: an absent media takes the absolute
  tail and an existing row keeps its identity, added time and position;
  `remove_media_in_txn` answers what an undo needs (`{item_id,
  added_at, after_item_id}`); `restore_in_txn` puts that row back after its
  former predecessor while it is visible, else first;
  `append_missing_in_txn` and `remove_item_in_txn` serve internal callers in
  the caller's transaction. all accepted public membership
  commands and explicit internal remove/restore/nonempty-append intent advance
  the viewer's shared sequence revision, including already-satisfied intent.
  strict reorder preserves membership and hidden slots; its precondition is
  checked under the viewer lock before actor/successor validation.
- `state.py` — sole DML owner of `consumption_overrides`,
  `reader_engagement_states` and `consumption_completion_facts`: the player
  read, the reader cursor composition, listening and preview writes, finish,
  undo, unread, reset, the natural-end settle, the podcast batch state and
  media teardown.
- `listening.py` — sole DML owner of `podcast_listening_states` (position,
  duration, nullable episode rate, reset epoch, `last_engaged_at`). A write is
  `UPDATE … WHERE reset_epoch = :epoch`, else an insert when the epoch is 0;
  positions are clamped only to positive duration; an absent rate or duration
  keeps the stored one. `install_preview` writes only when there is no row.
- `projection.py` — the read model other slices compose: the one read-state
  ladder in SQL (`engagement_fact_rows_sql`, `episode_state_*_sql`), read
  states (`Unread | InProgress | Finished`), engagement recency and anchors,
  `player_descriptors`. A descriptor's `position_ms` is 0 when the episode is
  finished by override; `playback_rate` is the episode rate ?? the
  subscription default ?? 1; `podcast_id` is present iff the viewer subscribes.
- `reader_cursor.py`, `activity.py`, `stats.py` — see
  [reader-implementation.md](reader-implementation.md) and
  [consumption-activity.md](consumption-activity.md).

## Wire

```http
GET    /lectern                       -> {items: [{media_summary, added_at, activation}], at_capacity, order_revision}
PUT    /lectern/items/{media_id}      {placement: First | After{media_id} | null, expected_order_revision} -> {order_revision}
DELETE /lectern/items/{media_id}?expected_order_revision=... -> {order_revision}
PUT    /lectern/items/{media_id}/position {before_media_id: UUID | null, expected_order_revision} -> {media_ids, order_revision}
POST   /media/{id}/finish             {leave_lectern} -> Finish
POST   /media/{id}/finish/undo        Finish -> 204
POST   /media/{id}/unread             -> 204
POST   /media/{id}/progress/reset     -> 204
POST   /media/{id}/natural-end        {terminal_listening, expected_override_revision} -> 204
GET    /media/{id}/player             -> PlayerDescriptor (404 when not playable)
PUT    /media/{id}/listening-state    ListeningIn -> ListeningPositionOut
POST   /media/{id}/preview-position   {position_ms, duration_ms} -> 204
GET    /lectern/suggestions, /lectern/quick-reads   (suggestions)
```

`api/routes/consumption.py` owns the Lectern, its suggestions and the
read-state writes; `api/routes/playback.py` the player read, the listening
write and the preview hand-off (both registered before the `media` router).

a null placement ensures membership without moving a present row. the 200
acknowledgement advances the revision; every retry keeps the original revision,
so a repeated old command cannot rebase. strict reorder cannot add a member.
revisions are canonical positive decimal strings bounded by signed bigint.
stale writes return409 `E_RESOURCE_CONFLICT`; membership acknowledgements contain
no order snapshot. a move also answers 409 `E_RESOURCE_CONFLICT` when its row or
successor is no longer visible, at an unchanged revision.
`at_capacity` counts
every row, hidden members included; `items` stay visibility-filtered, so a
media's absence from them does not establish non-membership.

Errors: a placement 404 (unknown media), 400 (after itself), 409 `E_LIMIT`
(2000 rows, an absent media only) or `E_MEDIA_DELETING`; an undo 409 `E_RESOURCE_CONFLICT`
("Completion is no longer undoable") or `E_LIMIT` when its row cannot return;
a settle 409 `E_RESOURCE_CONFLICT` when superseded, 404 when gone, 400
`E_INVALID_KIND` for a non-episode. A listening write answers the accepted
`{position_ms, reset_epoch, consumption_override_revision}`; an accepted
position clears unread and, with known progress at least 95%, writes sticky
finished under the same lock. A stale epoch answers 409
`E_STALE_LISTENING_REVISION` with that tuple in `error.details.current`; the
writer adopts it. "Mark as played" changes state only; the row stays.

Change topics: Lectern writes, finish, undo and settle publish `Lectern`;
finish, undo, unread, reset and settle publish `Consumption`.

## Frontend owners

`AuthenticatedShell` mounts `MediaSummaryProvider`, `LibraryOrderProvider`
(library moves, [library](library.md)), `LecternProvider` and
`GlobalPlayerProvider`, which wraps the workspace and `GlobalPlayerSurfaces`.

- `lib/lectern/lectern.tsx` (`LecternProvider`) is the lectern's one owner: the
  one read every surface shares (`useLectern`: rows, activations, capacity,
  revision; it rereads on `Lectern`, `Metadata` and foreground refresh, and ready
  rows stay shown during a reread), the write lane (invariant 9) behind
  `useLecternCommands` (ensure, remove, place; pending intents; receipts) and the
  lectern's order (`useLecternOrder`: the pending move, its notice, the last
  acknowledged order while the read lags it). An identical pending intent joins;
  an opposed one is superseded without a send; a queued intent reads as
  sending. Receipts carry the exact acknowledged intent kind and cover the
  written media until a read reaches their revision; only Ensure
  acknowledgements accept suggestions. Before the first read, and after a
  membership write's conflict until a read passes it, writes say "lectern is
  not ready · load lectern". `lecternNext` is the successor rule. `lib/lectern/api.ts` is the
  transport.
- `lib/consumption/state.tsx` — finish with an untimed offer of its exact undo,
  unread, reset, natural-end settlement, and the `holdProgress` registry the
  reader and player join. `ResourceActionsProvider` owns the consumption
  commands above pane lifetime; sending or unconfirmed undo remains a required
  workspace condition. the offer ends on use, dismissal or owner invalidation;
  it does not survive account teardown or reload.
- `app/(authenticated)/lectern/LecternPaneBody.tsx` — **On the lectern** (play
  rows, one url `sort` key, filter, drag moves one row in Custom view), Quick
  reads and Suggestions.
- `components/collections/LecternAddControl.tsx` — shared additive control for
  approved reading rows and existing quick-read/suggestion/transcript cohorts.
  it consumes the action runtime projection without per-row menu reads.
  pending intent and receipts are account-session-local; unrelated edits remain
  available after uncertainty. the required recovery condition remains until
  acknowledgement; account teardown or reload ends it.
- `lib/player/playerRuntime.tsx` — `GlobalPlayerProvider`: engine choice, the
  state/timeline context split, device history (previous restarts after 3 s,
  else pops back; next pops forward, else the next Lectern audio row), the fresh
  `GET /api/media/{id}/player` before a play of another media (2 s bound, else
  the descriptor it was given), serialized loads with the latest request
  winning, requested playback preferences and keyboard shortcuts. requested rate
  and silence choices stay separate from observed engine state; one flight
  applies the newest pair. queued work retains its engine-owned load subject and
  request generation. replacement retires old work and presentation; temporary
  native unavailability retains the confirmed subject and captured save receipts.
  `seekTo({positionMs, expectedSubject?})` captures the current subject when
  omitted and validates it again at engine application. retired seeks do nothing.
  Every play of the loaded episode (bar, page, keyboard, transcript) goes to
  its engine, which owns where a resume starts.
  Server rendering and the first client render start absent. Only the existing
  client initialization effect can observe a missing Android bridge and report
  `UpdateRequired`; native response timeouts report `NotResponding`, cleared by
  the next frame. The server cannot infer bridge failure from its own environment.
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
  playing; `keepalive` on pagehide only with news), the activity observer, the
  Media Session and the natural-end settle (retried on network or 5xx; on 204
  it plays the next audio row it read from the Lectern before settling, from
  the position a fresh `GET /media/{id}/player` reports, 2 s bound, else the
  Lectern's copy).
  Only the attached episode samples the shared element: a load detaches the
  outgoing episode after taking its last sample, and its late writes send that. The episode rate
  is sent only after the listener sets one; until then the stored value stands.
- `lib/player/nativeEngine.ts` — the Android engine, a thin client of
  `window.nexusPlayer` (below); an unanswered bounded request shows "Player
  unavailable" until the next frame arrives. preference commands resolve after
  application and snapshot publication. expired replies are ignored; live
  replies cannot replace an intervening confirmed load. real pushes from the
  current controller remain authoritative.
- `components/player/` — the persistent desktop/mobile player, loaded-source
  sheet, desktop playback/chapter pickers and shared presentational fields.
  the authenticated workspace always renders one stable player slot and footer,
  including server rendering and initial hydration. `Absent` shows “nothing
  playing” and a real `/lectern` link using workspace follow/fork activation;
  it exposes no transport or fabricated duration and never starts audio.
  `Loaded` retains identity, transport and stop while load-scoped preferences
  initialize; preference-dependent controls require the current settings subject.
  `Unavailable` exposes the actual warning and android update link only when
  required. stop calls the existing dismiss command; confirmed absence returns
  to idle. closing an overlay preserves playback. the downloaded shelf is a
  separate composition.
  normal idle/loaded footprints match: wide desktop is 80px, narrow desktop
  128px; coarse pointing adds 16px for seeking. the 42rem breakpoint belongs to
  the player container. equal side tracks center transport in the whole player.
  enlarged text and substantive failures may grow without clipping controls.
  the 64px mobile mini adds the existing safe inset and shows artwork, title,
  subtitle and play/pause in one row, with a decorative progress edge.
  the mobile drawer orders identity, transport, seek and utilities. its native
  handle is the only header control. playback and chapters begin closed and
  are mutually exclusive plain disclosures; opening/closing the sheet, changing
  subject or changing viewport mode retires them. desktop retains anchored
  pickers and an interactive footer. positive estimated device-only saved time
  and episode up-next live inside playback; chapter context lives in chapters.
  preview exposes rate only, with no episode history, chapters or default save.
  numbered skips show 15 seconds back and 30 seconds forward. ordinary pending
  work uses control markers; failures expose details and recovery. application
  gain is unity; volume belongs exclusively to the os/device.
  pointer scrubbing previews locally and commits once on captured release,
  including outside the range. cancellation, capture loss, source retirement or
  sheet closure discards it. keyboard seeks carry the rendered range's subject.
  mobile motion, occupied space and keyboard/sheet suppression follow the shared
  [workspace geometry contract](workspace.md#mobile-reader-chrome).
  source-specific overlays close on absence, unavailability or viewport-mode
  change. mobile keeps now playing open across loaded-source changes. ordinary
  dismissal returns to its actual opener; disappearing player controls recover
  owned focus to the visible idle link, otherwise the active pane landmark,
  without scrolling or reclaiming unrelated focus. an open mobile sheet owns
  lost settings-field focus across load-subject changes and preserves surviving
  controls. source navigation keeps destination focus. one live region outside
  inert surfaces owns session/status
  announcements: initial idle is silent, confirmed absence after a known source
  says “playback stopped”, and unavailability warns once without claiming a stop.
  last confirmed source kind/identity survive unavailability, so recovery of that
  source does not announce a new play. settings actions retain their own feedback.

remember captures the displayed rate/silence pair and the subscription's uuid
and settings version; it never rereads a later engine/source. it is disabled
until the current application succeeds and saved defaults are readable. saving
does no engine work: no reload, seek, pause, override clearing or listening write.
its owner outlives picker dismissal. old feedback cannot describe a replacement
subject. live controls apply immediately; the subscription form uses the same
fields for its unsaved draft.

`lib/podcasts/useSubscriptionSettingsSave.ts` owns the shared frozen-command
receipt and recovery. a rejected write can retry exactly; an unknown outcome
offers readback without resending. conflict review requires an explicit fresh
save. an unfollowed or replaced subscription cannot receive the old command.
saved reads never overwrite current playback. saved receipts name their captured
pair; later control changes do not become remembered implicitly.

silence defaults are podcast-owned: `Natural` means on; `Off` or null means off.
the current browser engine has no silence processor and explicitly refuses on,
including an inherited on choice; it never reports a fake applied state.
browser capability handling must preserve android defaults when remembering
speed; see [release playback settings](../issues/release-playback-settings.md).
browser silence processing is not a release dependency.

## The Android bridge

`window.nexusPlayer` carries trusted json frames in the grammar of
`window.nexusDownloads`: `{id, op, ...args}` → `{id, ok: true, snapshot?}` |
`{id, ok: false, error}`, and pushed `{snapshot}` on every change and each
second while playing. Ops: `hello{accountId}`, `load{descriptor}`,
`preview{descriptor}`, `play{key, descriptor?}` (the page's descriptor, for
an unanswered resume), `pause{key}`, `seek{key, positionMs}`,
`skip{key, deltaMs}`, `rate{key, value}`, `fence{key}`, `reconcile{key}`,
`sessionShortenPauses{key, on}` (this load's boolean override),
`dismiss{}`.
every keyed op also carries `expected_load_id`; every snapshot has nullable
`load_id`, mapped to the web session's `playbackSubject`. each install, including
same-media reload and service restart, gets a fresh id. the service checks both
key and load id under its load lock immediately before application; mismatch
answers `Stale` without mutation. transient transport loss preserves identity.
The object's name is the compatibility identity: an incompatible change renames
it, and an app without it renders "Update Nexus for Android". There is no
protocol version or hash.

`position` is the accepted `{positionMs, resetEpoch,
consumptionOverrideRevision}` tuple above.

Every snapshot requires `consumptionRevision`. It advances after an acknowledged
listening write so hosted list summaries refresh from accepted facts. Pending
samples do not advance it. Backend, web and Android ship together for this cutover.

unread/reset/undo preparation drains the loaded episode's recorder before
sending the write. a preparation timeout refuses that unsent write through
existing transport feedback. reconciliation drains again before reading
authority, even after a timed-out preparation; a failed read retains the
workspace and saving gate. retry reads only, and separate play/seek resumes
activity after reconciliation.

The native service owns ExoPlayer and the media session (notification and lock
screen), listening writes, activity spans in a durable outbox, and natural ends:
it posts `POST /media/{id}/natural-end` itself with the webview's cookies and,
on 204, plays the first audio row after the ended one in the `GET /lectern` it
read before settling, so an episode advances with the webview gone. A downloaded
episode plays from its `OfflineStore` lease. pause shortening is
`skipSilenceEnabled`: this load's override, else the podcast mode, else off.
only the time-saved counter remains device-owned. settings and seeks join the
existing load lock and publish their actual effect before acknowledging. source
publication follows the complete install, including initial settings; no
intermediate snapshot can claim the new occurrence. a terminal recorder write
advances only its still-attached originating episode; durable restored writes
settle without advancing a later load. reconnect hello replies cannot overwrite
an intervening push or a replacement controller/document.
the media session retains device-volume access and hardware/audio-focus handling;
application-volume commands and grants are absent.

## Boundary with podcast sync

playback never fetches feeds or writes transcripts. following automatically
acquires episode metadata; filing a show organizes those episodes. neither sync
nor history appends to the lectern. queue placement remains explicit.
