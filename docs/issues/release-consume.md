# release: consumption (PR 1 history: capture, exclusions, stats; PR 2 read state, the lectern, suggestions)

hard cutover: the api refuses the old forms and there is no compatibility arm.
the final combined release uses `X-Nexus-Wire: 2`: web, api and the apk ship
together; an old tab fails its stats and activity requests until reloaded.

| before | after | retry rule |
|---|---|---|
| `POST /consumption/activity {media_ref "media:<uuid>", device_class, batch}`; one bad span → 400 for the batch | `{media_id, device_class, batch}` → 204; spans older than 30 days, more than 5 min ahead or overlapping their predecessor are skipped | capture keys (unchanged) |
| `POST /consumption/activity-exclusions {client_mutation_id, Exclude{media_ref, modality, device_handle, …} \| Restore{exclusion_handle}}` → `{outcome, exclusion_handle}` | `PUT /consumption/exclusions/{id} {media_id, modality, device_id, started_at, ended_at}` → 204; `DELETE /consumption/exclusions/{id}` → 204 | same id → 204; session already excluded → 204; restored → 204; another viewer's id → 409 |
| `GET /consumption/stats ?media_ref&device_handle&bucket=…Week…` → sealed `ncd1.`/`nce1.` handles, `media_ref`, an embedded sessions page | `?media_id&device_id&bucket=Hour\|Day\|Month\|Year` → raw `device_id`, exclusion `id`, `media_id`; no sessions page (`totals.session_count`, `longest_session` stay) | read |
| `GET /consumption/sessions` limit 1..100, sealed device in the cursor | limit 1..200, raw device in the cursor | keyset under `as_of`; cursors minted before the deploy answer 400 once |
| stats pane url `media=media:<uuid>`, `device=ncd1.…`, always canonicalized in place | `media=<uuid>`, `device=<raw id>`; only what the viewer chose, never rewritten | n/a |
| `GET /lectern` `{items: [{item_id, media_summary, href, added_at, activation}], at_capacity}` | `{items: [{media_summary, added_at, activation}], at_capacity}` (`activation.kind` required) | read |
| `POST /lectern/commands {client_mutation_id, EnsureItem \| PlaceItems \| RemoveItem \| SetOrder}` | `PUT /lectern/items/{media_id} {placement: First \| After{media_id} \| null}` → 204 (null ensures: an absent media goes last, a present row stays; After an absent anchor = First; 400 after itself; 409 `E_LIMIT`, `E_MEDIA_DELETING`); `DELETE /lectern/items/{media_id}` → 204; no SetOrder (a drag moves one row) | absolute; absent → 204 |
| `POST /consumption/commands {client_mutation_id, EnsureMediaFinished \| Done}` → `ConsumptionResult{outcome, lectern, next_item, finish_id, progress_state}` | `POST /media/{id}/finish {leave_lectern}` → `Finish{revision, prior_status, completion_id, removed}` | re-applies; the resent answer's Undo keeps it finished |
| `… UndoFinish{media_id, finish_id, restore}` | `POST /media/{id}/finish/undo` (body: the `Finish` answer) → 204; 409 `E_RESOURCE_CONFLICT` | applies while the revision is the finish's; a landed resend → 204 |
| `… SetUnread`, `… ResetProgress` | `POST /media/{id}/unread`, `POST /media/{id}/progress/reset` → 204 | re-apply (fences advance again) |
| `… SettleNaturalEnd{media_id, terminal_listening, expected_consumption_override_revision}` → `next_item` | `POST /media/{id}/natural-end {terminal_listening, expected_override_revision}` → 204; 409 superseded, 404 gone, 400 `E_INVALID_KIND`; no next row named | fenced; a landed resend → 204 |
| `PUT /media/{id}/reader-state`: a landed retry → 409 | an identical resend → 200 with current (accepted again only from the current base) | resend → 200 |
| `GET /lectern/quick-reads` (any query → 400; candidate engine) | no query check; plain eligibility, Lectern members included | read |
| lectern pane url `sort=…&direction=…` | one `sort` key (`added_desc`, `added_asc`, `title_asc`, `title_desc`; absent = custom); an old pair shows "Invalid Lectern view" + Reset view once | n/a |

## pairing

- **web + api**: one deploy. a stats pane persisted in a workspace with an old
  `media=`/`device=` filter reads the filter as absent; a lectern pane with an
  old `sort=…&direction=…` shows "Invalid Lectern view" until Reset view.
- **android** (late android slice implements; this file states the contract):
  - activity: the outbox body names `media_id` (uuid), not `media_ref`.
  - natural end: `POST /api/media/{id}/natural-end {terminal_listening,
    expected_override_revision}` (no `client_mutation_id`, no `next_item`).
    before settling, read `GET /api/lectern` and take the first `FooterAudio`
    row after the ended media's row (none when the media had no row); on 204
    play it; on 409 drop the queued settle and do not advance; on 404 drop.
    a resend after a lost answer gets 204 again. 426 keeps the queue (edge
    rule).
  - `GET /api/lectern` items lose `item_id` and `href`.
  - reader-state: an identical resend answers 200 with the current cursor.
  - the `adopt` bridge op is no longer sent (reconcile reads the server); the
    service may drop its handler.
  - listening-state and player: unchanged.
  - the installed pre-release apk sends no `X-Nexus-Wire`, and its recorder
    retries only 401, 408, 429 and 5xx (`ListeningRecorder.kt` `retryable` on
    main), so it drops settles and spans the edge refuses with 426: drain its
    queue before the deploy (`release-edge.md` step 1). an apk built from an
    intermediate sha sends the header and retries 426, but the old forms are
    refused for good (settle route 404/405, activity body 400) and dropped, so
    no apk ships before the android slice's recorder. install the new apk right
    after deploy (edge order).
- **extension**: no consumption feature changes; use the matched wire-2 build.

## preflight / env / data

- one migration, `0281_consumption_override_register` (after the train head
  0280; renumber at merge): `consumption_overrides.status` becomes nullable
  (reset keeps the row and advances its revision); drops
  `consumption_overrides.created_at`, `reader_engagement_states.created_at`,
  `reader_media_state.created_at`, `reader_media_state.updated_at`,
  `podcast_listening_states.updated_at` (no reader or writer). no row changes;
  nothing is refused; downgrade restores the pre-release backup. production
  writers stop for it (release runbook).
- no env change, no backfill. `NEXUS_HANDLE_KEY` stays (other sealed handles
  still use it).
- data effects: none. historic duplicate active exclusions of one session (D7)
  are listed once and all restored by one Restore.
- rehearsal census on a restored backup (mac only), for the release notes:
  active exclusions duplicated per session (D7 reach); spans per user and
  distinct devices (stats cost; device ids are now shown to their owner);
  `resource_mutations` rows in the scopes `Lectern.Commands`,
  `Consumption.Commands`, `Consumption.ActivityExclusions` (inert after
  deploy; the last user-removing slice drops the table); overrides by status
  and max revision; `reader_media_state` locators whose kind disagrees with the
  media kind (expect 0: loads no longer re-check it); max lectern rows per user
  and hidden rows (I1).

## owner smoke

- Stats: period switch (the "Updating … Showing the prior …" line), Previous /
  Today / Next, device and work filters (chips), exclude a session and restore
  it, Load more sessions.
- read a document and play an episode for a minute each; both appear in Stats.
- home Lectern: add, Play next, drag, remove; Mark finished → Undo; read to the
  end of a lectern document → "Next on the lectern" → Undo; Reset progress with
  the reader open (it lands at the start, no "newer reading spot" prompt); web
  and phone natural end advance; Quick reads and Suggestions Add.
