# release the offline cutover in order

status: open · origin: 2026-10-04 `cleanup/offline-reauthor` · area: offline (android + web + api) release

the offline rewrite ([module](../modules/offline.md)) is a hard cutover across
apk, web and api with no version negotiation and no on-device migration. web
and api deploy together; the apk is installed by hand. the order matters.

## steps

1. **before the deploy**, on the phone, open the old apk online once and let
   it settle, so pending offline reading positions sync through the old
   `/offline-reader-state` routes. after step 2 they cannot.
2. **deploy web and api** (one release). the new Caddyfile matcher
   `^/stream/media/[0-9a-f-]{36}/reading-copy$` ships with it.
3. **build the apk, clear the app's storage, install, sign in.** clear storage
   with Settings → Apps → Nexus → Storage → Clear storage, or uninstall first.
   then install the new apk and sign in. clearing storage also signs the
   webview out; that is expected.

do not install the new apk before step 2.

## what breaks in each window

**old apk against new web+api** (between steps 2 and 3):
- the new web finds no `window.nexusOffline`: *Download for offline* is
  disabled *Not supported on this device*, there is no *Downloads* entry, and
  *Sign Out* is the plain web post.
- that sign-out does **not** purge the old apk's offline data (an I1 gap for
  the window). do not hand the phone to another account in this window.
- old position sync hits the deleted `/offline-reader-state` and gets 404:
  positions read *source unavailable* and stay local, then are dropped at
  step 3.
- new downloads are impossible: the spec, package-token and account-binding
  routes are all 404.
- still working: downloaded episodes play (the player protocol is unchanged)
  and old copies open in the old shelf offline.

**new apk against old web+api** (if step 3 runs before step 2):
- the old web finds no `nexusOfflineReading`: *Sign Out* reads "temporarily
  unavailable" on android and offline actions are disabled.
- the new apk's position PUT carries `expected_reader_generation`, which the
  old api rejects with 422 (`extra="forbid"`); the sync job keeps retrying.
- reading-copy GET is 404 → *Download failed · source unavailable*.

## on-device data

- reading copies made before the shared reader core (pr1 of the reader
  rewrite: `reader.json` became `{media, document}`) no longer open in the new
  shelf. the shelf says so and offers *Remove downloaded copy*; re-download
  them. the server and the apk's shelf bundle change format together, so ship
  that release's web+api and apk together as in steps 2–3.

- there is no migration code. without *Clear storage*,
  `databases/offline_reading.db`, `files/offline-reading/`,
  `files/offline-media/` (possibly gigabytes of audio) and
  `databases/exoplayer_internal.db` are orphaned forever.
- old downloads and any still-unsynced old positions are dropped either way.

## build inputs

`NEXUS_ANDROID_RELEASE_API_ORIGIN` is no longer read; the reading-copy origin
is the `stream_base_url` each stream token carries. passing it is harmless;
drop it from release notes and the release machine's environment.

## acceptance

on the handset after step 3: J1–J11 of the offline harness pass, including a
sign-out purge, an account switch, a cold start offline, an interrupted
transfer that resumes, a user stop from Task Manager, and a conflict made by
moving the hosted position after download. `adb shell run-as app.nexus.android
ls databases files` shows none of the orphaned paths above. delete this ticket
when the cutover is released.
