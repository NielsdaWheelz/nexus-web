# api cancellation has no dispatch fact

`apiFetch` exposes the same `AbortError` when an installed command is aborted
while awaiting session admission and when a dispatched fetch or response body
is aborted (`apps/web/src/lib/api/client.ts:332-334,362-379`, e47819e34).
unlike `ApiError`, that error carries no sent/unsent fact.

an upload confirmation cancelled inside that call must conservatively retain
its frozen request. a later refusal cannot authorize changing a request that
may still commit. an actually unsent cancellation can therefore require an
extra exact retry or guarded abandonment. an already-aborted signal can be
rejected before invocation; it does not resolve the in-call ambiguity.

if the cancellation contract is extended, preserve ordinary cancellation
handling while exposing the boundary's actual dispatch fact. resolved when
admission-wait cancellation and post-dispatch cancellation are distinguishable
without guessing, with retained confirmation bytes verified in both paths.
