# release playback settings

ship api/web with migrations `0305` (settings version) and `0306` from the
[podcast details cutover](release-podcast-details.md), preserving subscription
values and episode pins. settings writes require the captured subscription
uuid/version and the complete nullable playback pair. the later
[transcript cutover](release-transcript-reader.md) owns wire 14 and the paired
native activation; verify release state before changing it.

native exports `window.nexusPlayback`; pair the apk with web. old apks enter the
existing update-required state. device-only silence defaults/readers/commands
are removed; null means off and no device choice is imported into server rows.
native settings acknowledge actual application under the existing load lock.

browser processing remains explicitly deferred by the owner (2026-10-21): the
engine refuses unsupported on instead of acknowledging a no-op. implement and
qualify actual silence removal, intact speech and original-media-time seeking
before claiming the combined audio capability. see
[browser processing](browser-player-hides-silence-preference.md). native load
identity now fences settings across source replacements; paired activation is
tracked by the transcript cutover above.
the owner explicitly waived android silence-skipping qualification for this task.

use stopped writers, a verified backup, migration ancestry and exact-head checks;
rehearse the migration on a recent production backup before deployment. resolved
when the coordinated release and its processing dependency are complete. no
deployment is performed by this implementation task.
