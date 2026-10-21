# release playback settings

ship the api, web and android apk together. migration `0305` follows `0304` and
adds `podcast_subscriptions.settings_version INTEGER NOT NULL DEFAULT 1`.
existing subscription ids, nullable defaults, auto-queue watermarks and episode
pins remain. settings patches now require captured subscription id/version and
paired playback fields. wire 13 is already allocated since deployed 12; verify
the release state before allocating another revision.

the owner approved merging before the production-backup rehearsal. that
rehearsal remains owed before release; it is neither complete nor waived for
deployment. rehearse on the newest production backup, then use the existing
ancestry, stopped-writer, verified-backup and exact-head release checks. a fresh
disposable database does not replace that rehearsal. the existing
[production backup gap](release-backup-missing-after-8a67.md) tracks its prerequisite.

native playback now exports `window.nexusPlayer`; the old object is removed.
old apks enter the existing update-required state. pair the apk with the web;
no alias, fallback or old snapshot reader. null podcast silence means off,
including devices with a former on default. device-only choices are retired,
not imported into server rows. the time-saved counter remains.

browser silence processing remains the owner's next-pr dependency. settings
expose failures truthfully and never acknowledge a browser no-op. the integrated
release must qualify genuine silence removal, intact speech and original-media
seeking/chapters on browser and a real handset. also resolve/qualify the native
same-key load boundary in [native load identity](player-native-settings-lack-load-identity.md).
settings-only qualification does not close these processing obligations.

parallel player-surface work touches the same files; reconcile composition and
repeat affected playback/settings journeys on the integrated branch.

resolved when the migration rehearsal, integrated audio qualification and paired
deployment are complete. this branch does not deploy the application.
