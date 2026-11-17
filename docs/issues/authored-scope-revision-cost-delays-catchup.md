# authored catch-up terminal state remains unqualified

`6d130e45c` repairs repeated fragment-length work in metadata expansion. one
runtime-role repeatable-read comparison retained all 26,627 ordered records,
1,710 nulls, revisions and page responses: first/continuation pages fell from
5.42/5.43 s to 3.48/3.38 s. the canonical revision and authority algorithm stay
unchanged; the earlier per-reference sweep correction also remains intact.
positive clipped-table and existing-record revocation cases passed in the
real-postgres fixture; this production corpus emitted no incomplete-table facts.

ordinary retained-client observation on that source completed 16 scope-input
and 7 scope-text requests successfully. there were no errors among 86 completed
account requests, including no five-second pool refusals. another 24 interval
requests were successful health checks. nevertheless, the account
still displayed “syncing” after the informational 60-second wait. full hydration
and its adopted terminal state were not observed; this does not establish a
fresh sweep fence or an installed-device outcome.

resolve by identifying the unfinished client lane and observing a truthful
terminal state on representative retained data. preserve canonical revision
bytes, exact permissions and accepted source prefixes; no larger pools,
truncated corpus or hidden pending state. request cancellation remains separate:
[api work outliving cancellation](api-sync-work-outlives-request-cancellation.md).
private evidence: `f-scope-compare-d43f66f2-4bc0-43fd-821b-d4a9db7ea2bb-metadata.json`,
`ordinary-production-after-scope-observation.json` and `live-api-after-scope-G.log`
under `~/.local/state/nexus-read-responsiveness-20261116/`.
