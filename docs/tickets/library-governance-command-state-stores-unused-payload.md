# library governance command state stores unused payload

status: deferred · origin: 2026-10-04 source audit · area: library governance / web

`apps/web/src/lib/libraries/governanceState.ts:48–64` stores each running command's target, role and route epoch. current reads in `apps/web/src/components/libraries/LibraryMembersSurface.tsx:246,423,604,618` use only `operation.kind` for busy state; execution closures and their separate route token own the actual arguments and settlement. `apps/web/src/lib/libraries/useLibraryMembers.ts:124–128,738–742` adds a conditional `Omit` type and cast to install the otherwise unread fields. this duplicates command context and complicates types. no user-visible failure or runtime measurement is claimed.

acceptance: verify the full consumer closure, then keep only the command kind in running state and remove its unused payload/type cast. conserve all five command requests, settlement, route fencing and busy/confirmation feedback.
