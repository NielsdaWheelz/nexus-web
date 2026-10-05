# player slice: designed, not implemented

status: open · origin: 2026-10-04 cleanup campaign (claude coordinator) · area: player, lectern, listening/consumption (web, android, python)

## what is open

the player slice (browser + android runtimes, the web↔android protocol, android playback service, recorder and outbox, lectern, listening/consumption python; ~24.6k formatted lines) has a spec, a fresh-rewrite design (~5.5k in-budget, ~6.9k incl. neighbouring owners) and a live harness (desktop chromium + android emulator, 25 journeys: 22 pass, 3 xfail) but no implementation.

design in one line: one natural-end path (`SettleNaturalEnd` from whichever engine heard the end), the server owns the resume point and successor, the reset epoch is the only listening fence, one `window.nexusAudio` bridge replaces three hand-written codecs and the protocol sha/version, one migration (fold `is_completed` into finished overrides; drop `is_completed`, `write_revision`, `consumption_queue_items.source`).

## owner questions (block implementation)

replaying a finished episode (start at 0?), whether hidden-tab listening counts, rate pinning (inherit until set?), whether "Mark as played" removes the lectern row, browser volume boost/mono and pause-shortening cuts, protocol identity, notification next/prev, shelf offline playback.

## prerequisites

owner answers; a signed apk ships with web+api (old apks get the update banner); drain old activity outboxes before deploy. spec, design and harness: `/Users/nnandal/Documents/code/nexus-web-campaign-artifacts/2026-10-04/player/` (outside the repo). worktree `nexus-web-elon-player` (branch `cleanup/player-reauthor`, no commits) is kept.

## acceptance

the rewrite lands with the harness green on desktop and the emulator and the defects `player-replay-finished-episode-starts-at-end`, `desktop-hidden-tab-listening-records-no-activity`, `desktop-natural-end-skips-override-fence`, `episode-playback-rate-differs-by-device`, `mark-as-played-keeps-lectern-row`, `listening-unload-keepalive-can-lose-position`, `natural-end-position-exceeds-duration` resolved.
