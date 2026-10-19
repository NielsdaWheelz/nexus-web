# production codex encrypted-state unlock source is unavailable

status: open · origin: 2026-10-14 release recovery review · area: codex host / recovery

production's `/var/lib/nexus/codex-state.luks` is mounted and working, but its
off-host unlock source is unknown. the mac keychain candidate
`nexus-codex-nightly-luks` failed one read-only cryptsetup passphrase test at
05:57 utc, exit 2. the backing file, mapper and mount stayed unchanged. bounded
mac/devbox metadata and provisioning-record searches found no further source.

evidence: release artifact
`host-resize-feasibility-20261014/existing-keychain-readonly-unlock-test.json`,
sha256 `921cd8e6e97b6e59a5c976a4eda7eee487ce522c33822fd05380da1ec7ef007c`.
the volume is 1 gib with about 14 mib used. no replacement key was generated,
and no encrypted-state or power operation ran. the owner prohibits resizing;
the release now retains the current host and does not require a reboot.

impact: after a reboot, codex cannot return through the documented unlock
procedure. this is a recovery gap, not evidence of damaged current state.

fix: find and verify the original off-host key, or use the already-authorized
same-host migration into a new encrypted container with a durably stored
off-host key. gracefully stop its writer, preserve all state and attributes,
retain the original container, and prove close/reopen plus data equality before
cutover. never export decrypted account state or retain a key on production.

acceptance: record the protected off-host key location and successful fresh
unlock/mount/native-health proof; update the runbook. formatting must satisfy
the separately tracked memory-bound and keyslot requirements in
`codex-state-luks-format-oom.md`. do not reboot while recovery is unproved.
