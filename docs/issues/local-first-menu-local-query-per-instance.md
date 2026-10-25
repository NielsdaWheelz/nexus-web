# every resource menu keeps its own local query subscription

`components/resources/ContextualActionMenu.tsx` calls `useAuthoredActions(resourceRef)`, which subscribes a local
`resource` query for that ref while the menu trigger is mounted, open or not. outline rows already subscribe the same
ref (`ResourceOutlineRow` `AuthoredRow`), so a list of N authored rows holds about 2N subscriptions, and every local
commit or status broadcast re-runs them in the authored worker (`lib/authored/client.ts` change fan-out).

impact: unmeasured. possible typing latency or worker load on long outlines and daily pages (spec budget: typing
paint <= 50 ms, 100,000 blocks).

evidence: independent review of the local authored verbs, 2026-10-25; `lib/notes/hooks.ts` `useAuthoredQuery` (one
store subscription per call).

proposed fix: settle the menu publication contract first (local verbs published at open, see
`/tmp/nexus-localfirst-resource-ui-status.md` "OPEN — needs ownership grant"); then either let the row pass its
projection to the menu or subscribe only from menu preparation. a menu opened before its local read resolves offline
currently shows only "requires a connection" and closes with "actions changed" when the read lands.

resolved when: the scale case measures typing paint and worker time on a 100+ row outline with menus mounted, within
budget, or the subscription is shared/deferred and the same case passes.
