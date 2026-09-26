# codex auth refresh not qualified

status: open · origin: 2026-09-25 latest-model cutover · area: codex host credentials

## problem and evidence

the pinned 0.157.1 app-server read a private copy of enrolled personal auth,
completed a text-only turn, and synced the credential file without changing
the original digest. no actual token refresh or native rename/write event was
witnessed. therefore the new host's writable-file boundary is unqualified for
refresh; a successful text turn proves only current-token use.

## prerequisite and acceptance

with a near-expiry enrolled credential in a disposable profile, observe a real
refresh through the pinned app-server and verify the persisted artifact remains
valid and private after native exit. if its write/rename semantics changed,
repair the narrow host boundary and repeat the proof.
