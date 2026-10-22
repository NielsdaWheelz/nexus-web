# release playback settings

ship api/web with migrations `0305` (settings version) and `0306` from the
[podcast details cutover](release-podcast-details.md), preserving subscription
values and episode pins. settings writes require the captured subscription
uuid/version and the complete nullable playback pair. wire 13 is already
allocated since deployed 12; verify release state before changing it.

native exports `window.nexusPlayer`; pair the apk with web. old apks enter the
existing update-required state. device-only silence defaults/readers/commands
are removed; null means off and no device choice is imported into server rows.
native settings acknowledge the engine's enabled policy under the existing load
lock; this is not proof of acoustic quality or that a quiet interval was found.

the owner now accepts android-only silence skipping (2026-10-21). browser
processing is not a release dependency. browser speed/remembering preserves the
raw android silence default under the [player contract](../modules/player.md).
pair the web capability cutover with the apk using media3 1.11.1 and kotlin
2.3.10. the [native processor](android-silence-threshold-uses-affected-media3.md)
still requires real listening qualification. android qualification was waived
for the earlier settings task; that waiver supplies no acoustic proof
for this follow-up. native commands use the engine-owned load identity under the
existing lock; processing changes must preserve that [contract](../modules/player.md#the-android-bridge).

the persistent-player cutover removes application volume across web/native,
including bridge commands and media-session gain grants; hardware/device volume
remains. `nexusPlayer` is still the pending, unreleased identity at the stable
`android-v0.3.4` release (`nexusPlayback`), so this cutover shares that allocation.
release the paired apk/web together; never expose both bridge identities.

use stopped writers, a verified backup, migration ancestry and exact-head checks;
rehearse the migration on a recent production backup before deployment. resolved
when the coordinated release and these scoped playback follow-ups are complete. no
deployment is performed by this implementation task.
