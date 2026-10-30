# search watchdogs must cover complete serialized work

status: deployed transport ceilings remain open. `1d9aa51ea` replaces browser
server-side capacity waiting with current-intent deferral. the pr body owns its
focused local proof; actual 2 gib qualification is a deployment gate,
separate from merging that product correction.

both background read allowances now derive from the configured fresh-child wall
(default/max 900 seconds); api 115/bff 120/browser 125 and browser prefix
allowances are unchanged. the earlier child watchdog still covers the whole
handler, so this grants neither 900 seconds of computation nor joined cleanup
on forced kill. the session lock retains admission until backend retirement and
publication requires a complete read. the retired independent 30-second guard
failed the integrated named refresh with `SearchBudgetExpired`. on integrated
`f96858c24`, that same retained job completed its normal second attempt and
published with the failed history preserved; no reset or requeue was needed.
that closes the named-refresh failure, while foreground completion below remains
open. these operational
safeguards do not promise latency or qualify useful work by themselves. one
absolute request clock covers actual provider/setup/read/materialization work.
browser admission refuses occupied capacity before embedding; the current client
intent stays pending between attempts. capacity waiting neither spends nor resets
its finite execution allowance.
generic waiting copy suffices. retirement remains joined before capacity reuse.

current integrated `f96858c24`, actual 2 gib remainder `c2c16973e10a`, still
fails foreground completion: the unchanged `tolkien` hybrid intent received
504/`E_SEARCH_TIMEOUT`; lexical returned 200/20, and the other intent completed
both phases. request `63bd8392-4cec-4c5e-8dbf-2f4055223d5e` was admitted after
28 ms, then its api 115-second timer fired (`search.timer_fired` followed by
`search.budget.expired` in `api/search_operation.py:101`). indexed retrieval
consumed 86.870 seconds; nearest-chunk work began at 88.830 seconds and was
cancelled at the deadline. backend retirement and joined cleanup completed
before the api response (115.186 seconds). the bff forwarded that upstream 504
in 115.197 seconds with no abort cause. this is admitted execution expiry,
not accumulated capacity waiting or a demonstrated bff/browser timeout. query
cost attribution remains open; no timer or retry change is selected. the native
named retry and distinct fresh global job both published normally in this run;
that does not close foreground completion, final revision or backup acceptance.
retained request/monitor evidence is private under the existing qualification
owner. resolution requires useful exact hybrid completion through the responsible
owner, preserving scope/attribution and truthful finite safeguards; a timeout is
not a passing search. no production reproduction was performed.

historical source evidence at `4ceb03555`: `python/nexus/api/search_operation.py:26-39`
starts the absolute deadline before invoking the route read.
`python/nexus/services/search/admission.py:139-148,166-206` wraps physical checkout,
gate admission and the yielded read in that same deadline; `_admit` at lines
54-68 applies its remaining time to the gate wait. foreground policy is 115s in
the historical `python/nexus/services/search/policy.py:7-8`; bff120/browser125 totals remain in
`apps/web/src/lib/search/policy.ts:4-6`, with bff enforcement in
`apps/web/src/lib/api/proxy.ts:122-132`. those foreground and transport values
remain unchanged by the background repair.

historical synthetic held-gate checks and real warm c6 global-refresh/foreground
coexistence completed with useful lexical/hybrid results and physical retirement.
the 7173 e8 case also completed real foreground overlap, semantic witness, writing
and final two-feed convergence at input 1212; its overall FAILED verdict was an
invalid backup filename rejected before creation. the next 1b case instead failed
the memory envelope with a parent oom/kill despite later verified backup. see
[capacity](search-backup-overlap-oom.md). neither promotes historical 0321 proof
to integrated 0329, cold, deployed-transport, phone or actual 2 gib acceptance.
the current ff83 canonical/semantic lab pass uses fake providers and does not
exercise this native contention or deployed-transport gate.

retained production function metadata reported 300 seconds; loaded caddy had no
explicit reverse-proxy timeout. the candidate's deployed chain and actual ordinary
public ingress ceilings remain unverified. private component access suffices;
no new tunnel or streaming gate is introduced.

resolve the deployment gate by measuring complete work against actual transport
ceilings and proving foreground lexical/hybrid success under the chosen admission
policy plus due-feed convergence and finite queue drain on the required topology.
the user's revised acceptance permits deliberate heavy/backup serialization;
simultaneous peak execution is not required. the product correction refuses
browser capacity before embedding and keeps current intent pending outside
execution clocks; finite provider/transport guards, cancellation and physical
retirement remain. prefix allowance is carried across completed and failed
admitted fetches, with only genuine busy deferral exempt. no blind timer reset,
new protocol, phase telemetry or scheduler is introduced. local success does not
qualify deployed ceilings or actual 2 gib fit. if the costs
cannot fit, return that concrete conflict for a design decision. historical hosting/component
receipts remain in this issue's privately archived original under
`.nexus-local/search-integration-docs-20261029.private/original-source/docs/issues/`.
