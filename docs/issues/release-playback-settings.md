# release playback settings

production api/web `99320b630` shipped on 2026-10-22 at schema 0306 and wire 13,
with the paired `android-v0.3.5` published and installed. migrations `0305`
(settings version) and `0306` from the podcast details cutover preserve
subscription values and episode pins. settings writes require the captured
subscription uuid/version and the complete nullable playback pair.

native and web now share `window.nexusAudioSession`; older `nexusPlayer`,
`nexusPlayback` and `nexusAudio` identities are not accepted. old apks enter the
existing update-required state. device-only silence defaults/readers/commands
are removed; null means off and no device choice is imported into server rows.
native settings acknowledge the engine's enabled policy under the existing load
lock; this is not proof of acoustic quality or that a quiet interval was found.

the owner now accepts android-only silence skipping (2026-10-21). browser
processing is not a release dependency. browser speed/remembering preserves the
raw android silence default under the [player contract](../modules/player.md).
pair the web capability cutover with the apk using media3 1.11.1 and kotlin
2.3.10. native source-time, processing and playback qualification passed; the
owner accepted the actual off/on recordings. bluetooth remains explicitly
untested by owner decision. native commands use the engine-owned load identity
under the existing lock; processing changes must preserve that
[contract](../modules/player.md#the-android-bridge).

the persistent-player cutover removes application volume across web/native,
including bridge commands and media-session gain grants; hardware/device volume
remains. `android-v0.3.5` used `nexusPlayer`; the later transcript cutover uses
the fresh identity above, with no compatibility bridge.

the stopped-writer backup, full restored rehearsal and earlier coordinated
deployment are complete. this silence update (e0110e980, after production's
`99320b630`) is qualified on disposable services and a debug apk; it still needs
its paired web and apk release. the [transcript cutover](release-transcript-reader.md)
also owns wire 14 and migration 0310. delete this record when that release ships.
