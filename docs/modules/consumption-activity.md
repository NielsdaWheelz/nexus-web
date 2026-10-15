# Consumption Activity

## Scope

Consumption Activity is Nexus's personal observed-history capability. It owns
bounded reading, listening, and video-pane spans; client delivery;
exact-session exclusion and restore; first observed canonical completion facts; and the factual `/stats` and
session reads. It does not own
the reader cursor, current reader engagement, audio heartbeat state, explicit
consumption state, or user-authored time.

## Facts and semantics

- `consumption_activity_spans` is the sole positive-duration fact family. It
  stores bounded observations; stable client capture keys make a resent batch
  idempotent.
- `consumption_activity_exclusions` stores a viewer's decision not to count one
  exact observed gap-and-island session. Restore reactivates the underlying
  spans; neither operation edits or creates observation facts.
- `consumption_completion_facts` stores the first post-cutover canonical
  `Finished` transition for one viewer/media. Exact completion Undo may remove
  the fact it created; ordinary later Unread and `ResetProgress` do not rewrite
  history.
  Current percentage follows the saved cursor/listening position; accepted
  known progress ≥95% writes sticky finished separately. Unread preserves the
  bookmark and genuine canonical activity resumes it. These current-state rules
  belong to [the player](player.md), not observed-time aggregation.
- Reading requires the eligible focused reader/input state in a visible tab.
  Listening follows the sole platform audio owner (the global browser audio
  element off Android, the native Media3 service in the Android shell) and
  counts while audio plays, hidden tab or not: audio is the evidence, not focus.
  Viewing is focused, visible video-pane time, not verified provider playback.
- Sessions are read-time projections over spans, never stored rows or browser
  identities. Forward word/media-position change is a cursor delta, not unique
  consumption.
- Retained highlights, note blocks, and neutral Links remain their own source
  rows. Their Stats counts are current retained facts, not immutable activity.

For every Stats query:

```text
recordedActiveMs = accepted visible observed duration
excludedActiveMs = recorded duration removed by active exclusions
activeMs         = recordedActiveMs - excludedActiveMs
```

All breakdowns, sessions, streaks, and Year presentation derive from effective
`activeMs`. There is no manual or alternate observed-time projection.

## Owners

| Concern | Owner |
| --- | --- |
| Viewer-locked write transactions | `python/nexus/services/consumption/__init__.py` |
| Span ingest and session exclusions | `python/nexus/services/consumption/activity.py` |
| Current state writes, completion facts and public reads | `python/nexus/services/consumption/service.py` |
| Aggregation, filtering, sessions and the Stats and Sessions payloads | `python/nexus/services/consumption/stats.py` |
| The read-state derivation | `python/nexus/services/consumption/projection.py` |
| Wire shapes and routes | `python/nexus/schemas/consumption_activity.py`, `api/routes/consumption_activity.py`; the web reads generated wire types |
| Browser capture and delivery | `apps/web/src/lib/consumption/capture.tsx` (in memory) |
| Android listening capture and durability | `playback/ListeningRecorder.kt`, `playback/ActivityOutbox.kt` |
| Presentation | the authenticated Stats pane (`app/(authenticated)/stats/`) |

## Contract

Devices are the opaque stored id the bff stamps from the httpOnly `nx_device`
cookie (`X-Nexus-Device`); no body or query names the caller's device. Stats,
sessions and exclusions carry that raw id as `device_id` (any of the viewer's
devices), works their `media_id`, exclusions their uuid `id`. Nothing is sealed.

- `POST /consumption/activity {media_id, device_class, batch{modality, spans[1..120]}}`
  → 204. Retry: each span's `capture_key` is its identity, so a resent batch
  stores nothing new; a key reused with other facts refuses the batch (409
  `E_ACTIVITY_CAPTURE_CONFLICT`). Spans older than 30 days, more than 5 minutes
  ahead or overlapping their predecessor are skipped; the rest land.
- `PUT /consumption/exclusions/{id} {media_id, modality, device_id, started_at, ended_at}`
  → 204: stop counting one exact, unclipped, all-time session. The id is
  client-minted once per session and resent on retry: the same id answers
  success, a session already excluded under another id answers success, another
  viewer's id is 409, an interval that is not one current session is 400.
- `DELETE /consumption/exclusions/{id}` → 204: count the session again,
  restoring every active exclusion of it; already restored is success, an
  unknown id 404.
- `GET /consumption/stats` (`end`, `time_zone`, `bucket` Hour | Day | Month |
  Year, optional `start`, `modality`, `media_id`, `contributor_handle`,
  `device_id`) and `GET /consumption/sessions` (the same scope, `cursor`,
  `limit` 1..200) are no-store reads. Sessions page by keyset `(started_at,
  media_id, modality, device_id)` under the first page's `as_of`; a cursor
  carries a hash of its scope and is refused (400) under another.
- Writers publish the `Consumption` change topic; the Stats pane rereads on it
  only while active, on activation and when the page returns to the screen.

## Invariants

- Spans are bounded (1..30,000 ms) observations; `capture_key` is unique per
  viewer. Exclusions never edit or create spans; at most one exclusion of a
  session is active (the viewer lock serializes the check); Stats lists older
  duplicates once.
- Every Stats read projects one `as_of` snapshot over currently visible media;
  `activeMs = recordedActiveMs - excludedActiveMs`.
- Civil ranges resolve once to utc instants in the request's zone (the sql
  three-hour midnight rule); dates a zone skips return empty facts.
- Browser capture has one tab-local owner: each (media, modality) group accrues
  at most one span, from its single eligible observer (an observer is its
  handle); two eligible observers record nothing. Spans close at 10 s
  checkpoints, on ineligibility, observer or device-class change and pagehide;
  batches are one lane (≤ 120 spans, ≤ 40 kB); network, 408, 429 and 5xx
  failures retry with backoff, other refusals drop the batch; pagehide hands
  at most 60 kB to the browser with `keepalive`. A tab closed offline loses
  what it held. Android listening is durable in its outbox.
- Current state (`reader_media_state`, `reader_engagement_states`,
  `podcast_listening_states`) stays separate; resets keep spans and completion
  facts. Media teardown removes exclusions and both fact families before the
  parent media row.

## Operations

There is no rollup or cache: every figure is projected at read time.

## Non-goals

No positive manual entry, timer, import, external-app or physical-book tracking,
raw interaction log, stored session, second device identity, sharing/export,
partial-span editing, genre taxonomy, badge, or LLM reflection exists in this
capability. Progress, completion, and Library time estimates never fabricate
observed duration.
