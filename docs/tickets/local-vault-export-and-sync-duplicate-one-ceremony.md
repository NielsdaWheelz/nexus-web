# local-vault export and sync duplicate one nine-step ceremony

status: open (decision needed) · origin: 2026-09-17 slop sweep (claude session)
· area: settings local vault · oi-141

`apps/web/src/app/(authenticated)/settings/local-vault/SettingsLocalVaultPaneBody.tsx:186-214`
(`exportVault`) and `:216-248` (`syncVault`) are the same nine steps: null-handle
guard, `setFailure`/`setBusy`/`setStatus("syncing")`, a `hasVaultPermission`
guard with identical copy, `apiFetch('/api/vault')`, `writeVaultPayload`, the
conflict-count status and message, `showError`, and `setBusy(false)` in a
`finally`. only the opening differs: `syncVault` first calls
`readEditableVaultFiles` and POSTs them.

the two are not the same operation, which is why this is a decision and not a
dedupe. `exportVault` is a server-to-folder pull that discards local edits;
`syncVault` uploads the folder before rewriting it. deleting `exportVault`
removes the only way to overwrite a bad local edit from the server without first
uploading it — the "download export" link at `:334-343` writes a zip, not the
connected folder. the pane already treats them as distinct modes: both are wired
to the same primary control by status (`:313-314`).

decision: does the owner ever want the discard-local pull?

prerequisite: none beyond that answer.

fix: if the pull is not wanted, delete `exportVault` (186-214) and its "export
vault" button (344-351). if it is, keep both and factor the shared nine steps
into one helper the two entry points call.

acceptance: the pane has no two functions whose bodies are the same ceremony,
and every vault write mode the owner named is reachable.
