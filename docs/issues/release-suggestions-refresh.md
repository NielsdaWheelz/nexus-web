# quiet suggestions release

status: implemented on `codex/quiet-suggestions`; local qualification in progress.
paired release and hosted/installed qualification remain outstanding.

the cutover removes explicit force-generation admission. both suggestions
refresh endpoints become bodyless
ensure-fresh admission; ordinary ui refresh reads the latest completed publication.
ship web/api and paired installed clients through the existing release process.

wire 15 retains the pending once-per-release bump. the public frontend `/version`
currently names `dc12792e0`, whose source declares wire 14 (checked 2026-10-24).
recheck the release interval before shipping. web wire types are regenerated;
retain normal mismatch rejection. no database migration, data conversion,
environment change or new infrastructure.

before release, confirm the deployed source/build identities and paired clients.
qualify ordinary refresh and visit preservation in the intended hosted/installed
environments; preserve existing unsaved-work/update protections. local disposable
proof does not establish deployed or physical-device behavior.

resolved when the hard cutover is released with the required client pairing and
the scoped live journeys are verified. source implementation alone does not close
this release record.
