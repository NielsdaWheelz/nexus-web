# installed writing startup stall

an isolated phone launch after real password handoff retained “opening writing…”
for at least ten seconds. the confirmed native binding was readable, but the
writing-ready gate kept navigation and pane bodies unavailable. the same build
opened successfully in the preceding run; causality is unresolved.

the same ten-second failure occurred on the owned emulator in
`20261023-160428-2b72e494501c`, `artifacts/emulator-catalog-evidence.json`.
explicit launcher activation after handoff preceded successful later attempts,
but run `20261023-161805-020b743f740e` was already visible and focused before
that activation. this does not establish a hidden-app explanation. later phone
offline cold launches passed; the observed gap concerns initial handoff startup.

it recurred on the phone in `20261023-172157-cce5b44989cd` before any catalog
journey actions. the following run, `20261023-172940-dd3424935202`, captured
normal startup in `artifacts/contracts-writing-startup.json`: visible/focused,
no pending browser locks or browser errors; the sign-out lease was released
and the journal database appeared within 88 ms of the binding observation.
that successful observation does not explain or resolve the intermittent stall.

evidence: offline-catalog qualification run
`20261023-154104-f67133a1d363`, `artifacts/native-failure.json` and the zphone
playwright trace; source `2559e5f57` plus the frozen offline-catalog integration.
owners: `AuthenticatedShell.WritingRuntime`, `lib/notes/journal.ts:852`,
and `WorkspaceHost`'s writing-ready gate. installed initialization waits on local
runtime/web locks and indexeddb, not a native writing bridge or server request.

next failing reproduction must capture visibility/focus,
`navigator.locks.query()`, `indexedDB.databases()` and browser errors before
cleanup, without reloading or extending the deadline to mask the failure.
resolve by identifying the pending operation or proving hidden-driver state,
then verifying foreground startup and ordinary offline cold startup.
