# codex auth refresh not qualified

status: open · origin: 2026-09-25 latest-model cutover · area: codex host credentials

## problem and evidence

the native callback cutover pins stock app-server 0.160.0 and replaces the
old exact-file bind with a host-only private account directory, permitting
native atomic auth-file replacement. workers mount no account state. actual
uid/gid-10001 concurrent native turns and cancellation isolation passed in
`/private/tmp/nexus-native-topology-zcDlUE`; no native credential refresh was
observed. directory ownership and successful turns do not qualify refresh.
forcing refresh on a byte copy of the live profile could rotate the shared
remote refresh token and strand the original, so that is not a safe fixture.

## prerequisite and acceptance

with a near-expiry enrolled credential in a disposable profile, observe a real
refresh through the pinned app-server and verify the persisted artifact remains
valid and private after native exit. if its write/rename semantics changed,
repair the narrow host boundary and repeat the proof.
