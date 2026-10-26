# native foreground sync remains offline after server recovery

native17, c7d2b98b, run `20261025-163524-b0cadd6aa0ad`: saved-PDF capture,
cold reopen, note menu and offline autosave passed. restoring actual server
reachability without an OS network change did not upload the same note within
120s. DeviceSession stayed Unavailable after cold offline admission; only
successful bootstrap schedules renewal. normal authored retries were rejected
before HTTP by NexusOriginClient until native foreground/network changed.

fix reuses the existing foreground authored retry cadence to await the existing
coalesced DeviceSession check only when admission is Unavailable. it rechecks the
captured document/account fence before normal transport; SQL never waits on that
check. no new poller, public command, navigation workaround or background owner.

resolve with the unchanged actual shelf capture/edit → server recovery → same
note accepted, without navigation, foreground cycling or simulated network events.
