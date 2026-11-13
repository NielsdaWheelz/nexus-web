# librarian reads contend for ordinary database capacity

deployed source `9b435d881b371d6bc5f7323bfe60c5e322ff3834` improves
retained-pane return, but a fresh production librarian pane still waits seconds.
at `2026-11-12T23:15Z`, four successive `GET /me/chat-selection` requests
returned 503 with `db_pool_exhausted` after 5,003–5,006 ms. their automatic
retries succeeded after another 285–2,799 ms. concurrent
`GET /librarian/messages` requests exhausted the same pool; successful timeline
responses took 1,518–4,021 ms. these are api timings, not browser paint times.

the native catalog is not the cause of those waits: corresponding
`GET /llm-catalog` responses took 9–36 ms warm and 271 ms on first observation.
selection is one indexed account read (`services/chat/selection.py:31`), served
through the same ordinary pool as timeline and scope preparation.
`config.py:69` permits two ordinary sync checkouts, with a five-second wait.
authored scope-input/text requests share one permit before checkout
(`api/routes/authored.py:139`); they cannot occupy both connections themselves.
scope-text requests were concurrently arriving about once per second and taking
about 500 ms. identify the other checkout owner before changing capacity.

the observed window contains 17 turns, 34 messages, 30 tool calls and 68
retrievals. 57 retrieval occurrences share one epub media with 33 distinct
locators. response batching already deduplicates identical references, but
`chat/references.py:54` still repeats resource authority after item hydration and
resolves each distinct locator separately through `live_references.py:90`.
abandoned synchronous work can also survive browser cancellation; see
[the existing lifetime issue](api-sync-work-outlives-request-cancellation.md).

an isolated refresh from the already-ready phone at `23:26:54Z` returned in
1,848 ms (request `d70e2b19-dd64-4f06-a838-c9e07c7b8ae2`). 200-ms activity
samples place almost that entire interval inside one ordinary transaction,
with negligible checkout wait: early fragment/media-scope io, then captured
passage/evidence reads, repeated highlight/media authority and client-side
processing, ending in locator-scope reads. the other connection served authored
hydration intermittently. this proves warm timeline projection cost; it does
not prove that the 33 locators dominate it. both api and postgres showed zero
oom kills and zero cpu throttling. reproduce this epub-heavy shape before
selecting another batching or projection change.

a separate read-only profile of that exact 17-turn window executed 126 sql
statements and three excerpt-helper processes. repeated resource authority,
apparatus-scope reads and excerpt projection accounted for substantially more
work than the 33 location-scope queries. the disposable profile reached its
256 mib memory cap, so its timings are attribution evidence, not acceptance
measurements or predictions. it closed its transaction and process normally.
another stock-firefox check started only after the restored transcript and model
controls were ready: fresh messages took 1,908 ms; remembered-model readiness
took 1,507–2,167 ms. startup does not explain the recurring delay.

capture overlapping request timings and active query families on this corpus;
separate checkout wait, query execution and response construction. repair the
measured expensive or retained owner. do not increase pool limits, timeout
budgets, or weaken remembered-selection authority on this evidence alone.
resolved when repeated fresh-pane reads and the normal concurrent authored
hydration complete without checkout exhaustion, with transcript and readiness
timings recorded separately; a warm retained-pane return is not that proof.
