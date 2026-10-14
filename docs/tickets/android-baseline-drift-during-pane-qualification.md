# unrelated android task resources disappeared during qualification

status: open · origin: 2026-10-13 pane-controls physical qualification · area: android / task ownership

before installing the isolated `app.nexus.android.panecontrols.debug` package,
the handset also had `app.nexus.android.addimport.debug` and reverse mapping
`tcp:59830 tcp:59830`. the final cleanup audit no longer found those two
resources. `app.nexus.android` and `app.nexus.android.debug` remained installed.

the qualification commands only uninstalled the pane-controls package and
removed its 3197/8197/59421/59440 reverse mappings plus its debug forward. they
did not target the add-import package or port 59830. attribution is unknown;
another task's deliberate cleanup is plausible. evidence: external
`native-owned-state.json` records the baseline, and
`native-cleanup-receipt.json` records the final audit at
`2026-10-13T23:32:16.719Z`. those disposable raw receipts were removed after
qualification; the [durable record](../pane-controls-verification.md) retains
the result and limitation.

what to do: confirm whether the owner of the add-import task intentionally
removed its package and reverse mapping. do not recreate another task's
resources without establishing ownership and need.

resolved when: the resource owner's cleanup is confirmed, or an unintended
change is attributed and the required state restored by its owner.
