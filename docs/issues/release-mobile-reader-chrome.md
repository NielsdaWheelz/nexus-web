# mobile reader chrome qualification and release

status: locally implemented and qualified. production activation is separate
and must retain [the transcript paired cutover](release-transcript-reader.md)
and [queue recorder drain](release-playback-queue.md).

hosted reader overlays introduce no native protocol. shared reader assets also
ship in the apk; existing downloaded copies retain their interaction and do not
need redownloading for layout changes. publish api/web/workers/apk together under
the existing wire-14 and migration-0312 release prerequisites (after 0311).

before closing: verify the activated served source and installed apk identities,
then text/pdf actual taps, endpoint access, selection, find/keyboard, player and
persistent feedback. report physical/emulator and gesture/three-button evidence
separately; browser emulation alone does not establish native behavior. the owner
restricted this implementation's device work to an emulator.

local native qualification uses an isolated application id and an official
chromium snapshot provider on an owned api35 avd. it does not establish the
production phone, play-stable provider, release signing or app-link/oauth behavior.
record final observed qualification and exact build identities in the pr; keep
this issue until paired activation and the owner checks are complete.
