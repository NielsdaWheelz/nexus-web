# release: consumption (PR 1 history: capture, exclusions, stats)

hard cutover: the api refuses the old forms and there is no compatibility arm.
`X-Nexus-Wire` is not bumped during the campaign (conventions): web, api and
the apk ship together in the one release; an open tab fails its stats and
activity requests until reloaded.

| before | after | retry rule |
|---|---|---|
| `POST /consumption/activity {media_ref "media:<uuid>", device_class, batch}`; one bad span → 400 for the batch | `{media_id, device_class, batch}` → 204; spans older than 30 days, more than 5 min ahead or overlapping their predecessor are skipped | capture keys (unchanged) |
| `POST /consumption/activity-exclusions {client_mutation_id, Exclude{media_ref, modality, device_handle, …} \| Restore{exclusion_handle}}` → `{outcome, exclusion_handle}` | `PUT /consumption/exclusions/{id} {media_id, modality, device_id, started_at, ended_at}` → 204; `DELETE /consumption/exclusions/{id}` → 204 | same id → 204; session already excluded → 204; restored → 204; another viewer's id → 409 |
| `GET /consumption/stats ?media_ref&device_handle&bucket=…Week…` → sealed `ncd1.`/`nce1.` handles, `media_ref`, an embedded sessions page | `?media_id&device_id&bucket=Hour\|Day\|Month\|Year` → raw `device_id`, exclusion `id`, `media_id`; no sessions page (`totals.session_count`, `longest_session` stay) | read |
| `GET /consumption/sessions` limit 1..100, sealed device in the cursor | limit 1..200, raw device in the cursor | keyset under `as_of`; cursors minted before the deploy answer 400 once |
| stats pane url `media=media:<uuid>`, `device=ncd1.…`, always canonicalized in place | `media=<uuid>`, `device=<raw id>`; only what the viewer chose, never rewritten | n/a |

## pairing

- **web + api**: one deploy. a stats pane persisted in a workspace with an old
  `media=`/`device=` filter reads the filter as absent.
- **android** (late android slice implements; this file states the contract):
  the activity outbox body names `media_id` (uuid), not `media_ref`. the
  installed pre-release apk sends no `X-Nexus-Wire`, and its recorder retries
  only 401, 408, 429 and 5xx (`ListeningRecorder.kt` `retryable` on main), so
  it drops a batch the edge refuses with 426: drain its outbox before the
  deploy (`release-edge.md` step 1). an apk built from an intermediate sha
  sends the header and retries 426, but the old body is refused for good (400)
  and dropped, so no apk ships before the android slice's recorder. install
  the new apk right after deploy.
- **extension**: untouched.

## preflight / env / data

- no migration, no env change, no backfill. `NEXUS_HANDLE_KEY` stays (other
  sealed handles still use it).
- data effects: none. historic duplicate active exclusions of one session (D7)
  are listed once and all restored by one Restore.
- rehearsal census on a restored backup (mac only), for the release notes:
  active exclusions duplicated per session (D7 reach); spans per user and
  distinct devices (stats cost; device ids are now shown to their owner);
  `resource_mutations` rows in scope `Consumption.ActivityExclusions` (inert
  after deploy).

## owner smoke

- Stats: period switch (the "Updating … Showing the prior …" line), Previous /
  Today / Next, device and work filters (chips), exclude a session and restore
  it, Load more sessions.
- read a document and play an episode for a minute each; both appear in Stats.
