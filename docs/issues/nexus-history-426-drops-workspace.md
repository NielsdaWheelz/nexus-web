# a stale tab's nexus history write takes the workspace down

problem: `lib/nexus/useNexusFind.ts` `remember()` models only `TRANSPORT_CODES`
(`E_NETWORK`, `E_UPSTREAM`, `E_UPSTREAM_TIMEOUT`). Every other code, the 426
`E_WIRE_MISMATCH` included, goes to `setDefect` and is thrown in render to the
workspace boundary.

impact: in a tab built for another wire that the leave-page prompt kept (unsaved
text), choosing a nexus result replaces the whole workspace with "Nexus was
updated. Reload this page to continue.", and the text the prompt kept is gone.
Panes that throw the 426 fall only to their own boundary, which reads the same
copy and reports no defect; the workspace save keeps the workspace up.

evidence: review of the api edge PR A, finding 2 (`useNexusFind.ts:113-118`).
Not fixed there: the actions, notes and t4e slices all edit this file.

fix: classify with `apiTransportFeedback`, which owns the 426 copy, instead of
`TRANSPORT_CODES`.

resolved when: a stale tab kept by the leave-page prompt records a nexus
selection and keeps its workspace and draft (an E5-style edge journey).
