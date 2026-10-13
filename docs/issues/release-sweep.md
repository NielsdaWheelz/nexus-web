# release: wire sweep (plain nullable, snake_case keys)

The commit "replace presence with plain nullable and use snake_case across the wire" changes
every client contract at once. Absence is `null` instead of `{"kind": "Absent"}` /
`{"kind": "Present", "value": v}`, and every key is snake_case (`timeZone` →
`time_zone`, `mediaSummary` → `media_summary`, ...). The api refuses the old forms (422):
there is no compatibility arm.

## pairing (all from the release sha, in the one release)

- **apk**: ship an apk built from the release sha. The hosted web hands the apk the wire
  player descriptor, so an old apk cannot play anything against the new web: its `load` reads
  `mediaId` (and a preview's Presence `imageUrl`), the `JSONException` is answered `Invalid`,
  and every episode and preview fails until the new apk is installed (a new apk against the
  old web fails the same way). Its listening writes, natural-end settles and activity batches
  are refused as well. Owner installs it and smokes playback (position survives a reload;
  Stats shows the listening) and offline.
- **firefox extension**: ship the build from the release sha. The old one decodes
  `GET /session` email/display_name as Presence and rejects the new `null`, so capture refuses
  to start.
- **web**: Vercel deploys the same sha. A chat tab open across the deploy gets the reload
  prompt (`X-Nexus-Chat-Contract` 5 → 6); every other tab fails (422 or a decode defect)
  until reloaded; there is no wire-version header yet (the skew slice adds `X-Nexus-Wire`).

## preflight / env

- **memory client config**: `/etc/nexus/memory-config/<sha256>.json` is published by
  `deploy/hetzner/sync-env.sh` and was a Presence document (production: `{"kind":"Absent"}`).
  The api and interactive worker now read `null` or the config object and refuse to start on
  the old file ("invalid private memory client configuration"). Run `sync-env.sh` from the
  release sha before the release so the pointer names a `null` file. If memory is ever
  configured, `NEXUS_MEMORY_CLIENT_CONFIG` must be the plain config object.
- no env key is added or removed.

## data (migration 0279)

- unwraps every exact Presence object in every public jsonb column except
  `note_blocks.body_pm_json`, `model_cutover_archives.reviewed_manifest` and
  `resource_mutations` (import/processing history, chat run events, chunk locators and
  evidence selectors, apparatus note groups, job payloads/results, x source snapshots, ...);
  snake-cases the keys of `workspace_sessions.state`. Each column is scanned once
  (`::text LIKE`): expect minutes, not seconds, on the production volume. Irreversible: the
  pre-migration backup is the only copy of the old forms.
- replay ledger rows (`resource_mutations`) keep the old forms: a retry that spans the deploy
  either mismatches its request hash (409) or, for a snake-keyed request whose memo is camel or
  Presence, fails to replay. Quiesce writers first.

## quiesce before the deploy (owner)

- no unsaved notes (no "unsaved" badge), no chat send pending: the notes writing journal and
  chat drafts persist frozen requests in browser storage in the old shape.
- the phone online and the player idle long enough to upload: the new apk sends from
  `player/spans.json` and never reads the old `player/activity.json` outbox (camelCase spans
  the api would refuse; the file stays behind, inert); offline reading positions saved on the device before the upgrade carry
  the old locator shape and are refused on sync.
- no browser capture in flight: a packet uploaded before the deploy holds Presence metadata
  and fails validation when confirmed after it.

## stored article packets (with writers stopped, after 0279)

Every `browser_article_capture` packet already in storage holds `byline`, `excerpt`,
`site_name` and `published_time` as Presence objects; the decoder now refuses them
(`E_INVALID_FILE_TYPE`, terminal), so a refresh, retry or stale requeue of any captured article
would fail it. `nexus convert-browser-article-captures` now ends with
`unwrap_article_packet_presence`: each such packet is rewritten in the current form to a fresh
object, its attempts move to it (`size_bytes`, `sha256`, `media.browser_capture_sha256`
follow), and the old object stays under `retained_legacy_paths` for rollback. The release
already runs that command twice after migrating with writers stopped and refuses any
second-pass output (`deploy/hetzner/release.py` `convert_browser_captures`); the first pass
prints one `unwrapped media ...` line per packet. A packet that is neither current nor exactly
Presence-wrapped stops the run naming its media. Keep the command until this release ran
(`docs/tickets/remove-browser-capture-conversion-command.md`).

## rollback

Restore the pre-release backup, re-run `deploy/hetzner/sync-env.sh` from the previous sha
(its memory config file is a Presence document again; the previous image refuses the `null`
file at startup, and `sync-env` never runs implicitly; the old content-addressed files are
never pruned), then redeploy the previous sha, apk and extension together. The restored
attempts name the retained pre-unwrap packets.

## resolved when

The release carrying this commit ran with: `sync-env.sh` republished from the release sha,
0279 applied, the packet unwrap run with a zero-work second pass, the new apk installed and smoked (playback position sync, natural end,
listening activity in Stats, offline download), the new extension capturing, and no 422 in
the api logs from old clients after the owner's devices updated.
