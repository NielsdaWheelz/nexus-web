# a delayed placement retry can overtake the opposite intent

status: open · origin: 2026-10-14 library picker design audit · area: api / library command ordering

problem: convergent add/remove verbs are repeatable, but repeated delivery is not ordered against a later opposite command.

evidence: `apps/web/src/lib/libraries/libraryPlacement.ts:45-87` retries explicit verbs without a stable command id. `python/nexus/api/routes/media.py:161-192` accepts no replay identity. `apps/web/src/lib/api/client.ts:379-397` checks transport/status only. existing media/library locks serialize database transactions but cannot identify a delayed duplicate as an already-settled user command.

reproduce conceptually: delay original add a before its database lock; client loses its response; retry a succeeds; remove b succeeds; original a finally runs and restores membership. this is a source-derived ordering hazard, not a live fault-injection result.

prerequisites: retain the library domain's lock order, authorization, last-reference and inherited-placement rules. define receipt handling for replay after authority loss or a refusal; a fresh refusal alone cannot settle an earlier unknown attempt.

fix: extend the existing placement command contract with frozen command identity. reuse `python/nexus/services/resource_mutation_replay.py:41-94`; lookup and record under the domain's serialization discipline and commit receipt with the mutation. retries preserve id and body; the client dispatches the next target command only after the predecessor is settled. the user selected account-scoped session-storage recovery across reload in the same tab. no new queue service or replay table is required; independent-tab intent ordering remains outside this contract.

acceptance: a delayed original request arriving after successful replay and inverse command becomes a replay, not a new mutation; final membership reflects b. same id with changed payload is rejected; unknown retry/refusal retains recovery until a terminal result is established.
