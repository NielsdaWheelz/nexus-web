# consumption activity

## scope

consumption activity owns bounded reading, listening and video-pane observations;
client delivery; exact-sitting exclusion and restore; first canonical completion
facts; and the reading record. it does not own the reader cursor, engagement,
audio heartbeat, explicit consumption state or user-authored time.

## facts and semantics

- `consumption_activity_spans` is the sole positive-duration fact family. stable
  client capture keys make resent batches idempotent.
- `consumption_activity_exclusions` records the decision not to count one exact
  all-time sitting. each accepted command uuid retains its exclusion row;
  equivalent active rows represent one logical excluded sitting. restore
  reactivates its spans; neither command changes or creates observations.
- `consumption_completion_facts` stores the first observed canonical `Finished`
  transition per viewer and work. exact completion undo may remove the fact it
  created; ordinary unread and reset preserve history. the account action owner
  retains the exact inverse behind an untimed optional offer; an unknown undo
  outcome reuses that receipt without adding restart persistence.
- current percentage follows the saved cursor or listening position. accepted
  progress at least 95% writes sticky finished separately. unread preserves the
  bookmark, and canonical activity resumes it. these state rules belong to
  [the player](player.md).
- reading requires eligible focused input in a visible tab. listening follows
  the sole platform audio owner: the global browser audio element, or android's
  native media service. audio counts while playing, including when hidden.
  viewing measures focused, visible video-pane time, without claiming provider
  playback.
- a sitting is an island of effective spans for one work, modality and device,
  separated by a thirty-minute gap. it is projected, never stored.
- effective time excludes spans inside active exclusions. all record figures,
  sittings and days derive from this one relation over currently visible media.
- a day belongs to the civil date on which its span starts in the account's
  `calendar_time_zone`. a span is not split at midnight. five minutes counts a
  day; stamp levels begin at five, twenty, forty-five and ninety minutes.
- weeks run monday to sunday and belong to the year of their monday. one counted
  day keeps a week; seven make it entire. weeks running counts back from this
  week, or the preceding week when this one is not yet kept, across year edges.
- covered stretches are merged span progress intervals. a pass retains its time
  but contributes neither coverage nor pace: more than fifteen words a second,
  a quarter pdf page a second, or four times wall-clock listening advancement.
  missing measurements do not imply a pass.
- print thickness is an estimate from words, with boards for epubs. listening
  and viewing use transcript words, or the duration estimate when available.
  thickness never represents observed time.
- the stack contains completion facts, once per work, grouped by the account-zone
  year of completion. rereads do not add another spine. removing a work still
  removes its observations, exclusions and completion fact.

## owners

| concern | owner |
| --- | --- |
| viewer-locked writes | `python/nexus/services/consumption/__init__.py` |
| span ingest and exclusions | `activity.py` in that directory |
| current state and completion facts | `state.py` |
| record, work record and sittings projections | `stats.py` |
| navigation units, parts and pdf pages | `structure.py` |
| the one current read-state ladder | `projection.py` |
| wire shapes and routes | `schemas/consumption_activity.py`, `api/routes/consumption_activity.py` |
| browser capture and delivery | `apps/web/src/lib/consumption/capture.tsx` |
| durable android listening delivery | `playback/ListeningRecorder.kt`, `playback/ActivityOutbox.kt` |
| pane composition and corrections | `app/(authenticated)/stats/StatsPaneBody.tsx`, `Sittings.tsx` |
| landscape, slip and stack | `Landscape.tsx`, `landscapeGeometry.ts`, `Slip.tsx`, `Stack.tsx` and their css modules |
| text exports and duration spelling | `apps/web/src/lib/consumption/recordText.ts` |
| record clipboard outcome | `apps/web/src/lib/consumption/RecordCopyButton.tsx` |
| finished text end line | `app/(authenticated)/media/[id]/HereEnds.tsx` |

## contract

paths below are api paths before the web's `/api` prefix. devices are opaque ids
stamped by the bff from the http-only `nx_device` cookie. sittings carry
`device_id` only to name exact exclusions; the interface shows no device label.
works and exclusions use plain uuids.

- `POST /consumption/activity {media_id, device_class, batch{modality, spans}}`
  accepts one to 120 spans and returns 204. a resent capture key stores nothing
  new; reused identity with different bytes is 409 `E_ACTIVITY_CAPTURE_CONFLICT`.
  spans older than thirty days, more than five minutes ahead, or overlapping
  their predecessor are skipped; the rest land.
- `PUT /consumption/exclusions/{id} {media_id, modality, device_id, started_at,
  ended_at}` returns 204. the client mints one id per exact all-time sitting and
  resends it. the same id or a sitting already excluded under another id succeeds;
  each accepted id remains a receipt after restore. another viewer's id is 409;
  a non-sitting interval is 400.
- `DELETE /consumption/exclusions/{id}` returns 204 and restores every active
  exclusion of that sitting. an already restored id succeeds without touching
  a later exclusion; an unknown id is 404.
- `GET /consumption/record` reads the account-zone today, all-time slip days,
  up to six recent unfinished open works, the first work in hand, yearly stacks,
  lifetime print height and four records. the slip shows the current year's
  weeks; all-time days support runs across years.
- `GET /consumption/works/{media_id}` reads one visible work's units, parts,
  cursor, coverage, full-read estimate, sittings, days and completion. inaccessible
  works are 404. epub, article and pdf units require a ready reader publication;
  pdfs use pages and episodes use timed chapters.
- `GET /consumption/sittings?cursor&limit` reads all-time effective sittings
  together with active exclusions, newest first. limit is one to 200, default
  fifty. keyset order is `(started_at, ended_at, media_id, modality, device_id)`;
  a cursor freezes `as_of` and is bound to its viewer. excluded rows retain their
  original time and exclusion id but have no progress interval.
- every read uses one repeatable-read snapshot and one `as_of`; there is no
  stored figure, rollup or cache. wire absence is `null`.
- writers publish `Consumption`. the active pane rereads on changes, activation,
  page return and account midnight. record and sittings are its only views;
  work and year selections belong to the record url. retired views and filters
  are invalid, with a reset action.
- corrections require no dialog. an unknown outcome remains a `Hold` with the
  same retry identity. a fresh excluded row carrying that command's id proves
  exclusion; another command's id requires an acknowledged retry.
  a complete fresh list without it proves restore. a definitive 400 or 404 settles
  the held command; transport uncertainty and a busy refusal retain its retry.
- landscape widths retain source proportions. the minimum visible peak criterion
  qualifies the reference thirteen-unit layout at 320 px; arbitrary tiny source
  units may remain tiny rather than distort the scale.
- date clauses label the reading start and finish separately when observation
  begins after an earlier completion; the facts and export ribbon remain unchanged.
- a finished text document shows its end line independently of lectern membership.
  its work record reads on mount or transition into finished, without following
  `Consumption`. unfinished texts retain their ordinary end line. exports are
  plain text through the existing clipboard feedback contract.

## capture invariants

spans last one to 30,000 ms; capture keys are viewer-unique. the viewer lock
serializes exclusion writes; active rows for one sitting display once. current reader and
listening state remain separate, and reset preserves observations and facts.

browser capture has one tab-local owner. each work/modality group accrues at most
one span; two eligible observers record nothing. spans close at ten-second
checkpoints, ineligibility, observer/device-class changes and page hide. batches
use one lane, at most 120 spans or 40 kb. network, 408, 429 and 5xx retry with
backoff; other refusals drop the batch. page hide hands at most 60 kb to browser
keepalive. a tab closed offline loses its in-memory queue. android listening
retains its durable outbox.

## non-goals

no positive manual entry, timer, import, external-app or physical-book tracking,
raw interaction log, stored sitting, second device identity, partial-span edit,
genre taxonomy, feed, leaderboard, streak reward or generated reflection.
progress, completion, print thickness and library time estimates never fabricate
observed duration. the record counts and draws what was read outside reading;
it never announces a loss.
