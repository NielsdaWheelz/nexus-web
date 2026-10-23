# transcript reader paired release

status: implemented locally; paired production activation remains outstanding.

the reader/snapshot wire is revision 14. the checked production identity and
`android-v0.3.5` release both named `99320b630e978dc0fe0d8f727e334e0ea0229a0e`,
whose wire revision is 13. further breaking changes before the next release
share this bump; recheck release state before activation.

the combined native bridge is now `nexusQueueSession`, with no aliases for
`nexusAudioSession`, `nexusAudio`, `nexusPlayback` or `nexusPlayer`. follow the
[queue recorder drain and paired release prerequisites](release-playback-queue.md). old apks must show update
required. api, web, workers and the new apk must ship as a
paired cutover. unloaded or ended timestamp starts require fresh server state;
loaded seeking remains available offline.

before activation: migration `0311`, after `0310`, adds chapter end-absence provenance:
existing chapter facts and ids survive, but historical null ends stay unverified
(`end_absence_confirmed = false`). their exact scopes remain unavailable until a
new publisher observation confirms an absent end. no data is deleted. supplied
invalid publisher ends now refuse the source observation before persistence.
apply the deployment controller's migration ancestry preflight, stop writers,
verify a backup or an explicit durable operator waiver, then verify exact head.
the combined schema head is queue migration `0312` after this migration.
local rehearsals do not establish production migration safety.

qualify loaded offline seeking, fresh unloaded starts, stale-command ordering
and old-app refusal on the activated builds. local browser and installed emulator
results do not establish production or physical-device behavior. deployment is
outside this implementation's scope.

resolved when the paired release is activated and these boundaries are verified;
record build identities and observed results in its pr. retain this issue until then.
