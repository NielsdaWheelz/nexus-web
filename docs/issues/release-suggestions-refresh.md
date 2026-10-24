# quiet suggestions release

status: implemented on `codex/quiet-suggestions`; local qualification in progress.
paired release and hosted/installed qualification remain outstanding.

the cutover removes explicit force-generation admission. both suggestions
refresh endpoints become bodyless
ensure-fresh admission; ordinary ui refresh reads the latest completed publication.
ship web/api and paired installed clients through the existing release process.

verify the actual release interval before changing `WIRE_REVISION`. source is 15
on 2026-10-23; [offline startup](release-offline-startup.md) records its bump from
released 14. retain 15 while that interval remains open, otherwise apply the next
single bump. regenerate web wire types; retain normal mismatch rejection. no
database migration, data conversion, environment change or new infrastructure.

before release, confirm the deployed source/build identities and paired clients.
qualify ordinary refresh and visit preservation in the intended hosted/installed
environments; preserve existing unsaved-work/update protections. local disposable
proof does not establish deployed or physical-device behavior.

resolved when the hard cutover is released with the required client pairing and
the scoped live journeys are verified. source implementation alone does not close
this release record.
