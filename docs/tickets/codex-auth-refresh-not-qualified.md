# codex auth refresh not qualified

status: open · origin: 2026-09-25 latest-model cutover · area: codex host credentials

## problem and evidence

the pinned 0.157.1 app-server completed all 15 codex model/effort cells on
`d6b06991c`, but the protected auth file kept its original digest and mtime
(`1790402374.7912033`). its access token expires on 2026-10-05 23:07 utc;
none of those turns exercised refresh or a native credential write. the host's
writable-file boundary remains unqualified for refresh.
forcing refresh on a byte copy of the live profile could rotate the shared
remote refresh token and strand the original, so that is not a safe fixture.

## prerequisite and acceptance

with a near-expiry enrolled credential in a disposable profile, observe a real
refresh through the pinned app-server and verify the persisted artifact remains
valid and private after native exit. if its write/rename semantics changed,
repair the narrow host boundary and repeat the proof.
