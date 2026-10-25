# semantic eligibility count resolves preferred readings

on frozen `9170f6780` / main `2b85ecb3d`, the focal related-search diagnostic
times out before choosing exact or approximate vector retrieval. the bounded
eligible-chunk count takes28,492.962ms and returns57014 at
2026-10-25T04:34:29.008318826Z. postgres records no oom, backend kill or recovery.
extra neighbours and presentation never complete. this is separate from the
older publication-time timeout; its cause cannot be assigned retrospectively.

`semantic.nearest_chunks` applies the content-chunk owner predicate from
`search/sources.py` before its25,001 threshold. that predicate resolves preferred
reading identities. the exact estimate-only plan retains correlated source-first
sorts and fragment-extent aggregates inside eligibility counting. this establishes
unnecessary planned work, not its measured share of elapsed time.

private evidence: `search-release-integration/parts-v3-diagnostics/`, including
the closed assessment and exact statement/plan. the populated0316→0317 canonical
and fifteen-family projection proofs pass. no recall, publication or browser
journey ran on this checkpoint. all owned runtime resources closed normally.

use the shared published reading bounds for boolean semantic membership, preserving
permissions, scopes, filters, model and readiness. choose preferred reading only
for selected hits. prove small source/piece/neighbour parity and a completed bounded
count on the verified317 clone; then qualify the affected active related journey.
the separate2.225s indexed-stage observation remains a latency concern, not a
claim of steady-state cost. keep ranking, hardware and failure deadlines fixed.

on frozen `dbc919b5d`, boolean membership completes the actual hybrid diagnostic:
extra neighbours complete in 3.727s (captured count 2.634s, ann 1.075s), indexed
work in 2.391s, presentation in 8.601s. instrumentation rewrites its whole private
json before and after every sql statement; these are instrumented observations,
not api phase costs. no recall, publication or browser acceptance ran.

a separate exact count `explain analyze buffers timing false` completes with
1,538ms server execution. the plan still scans 437 admitted readings on each of
25,002 candidate loops because a candidate union mixes invariant admitted readings
with chunk-correlated exact frozen refs. private evidence is
`membership-diagnostics/remote/count-plan.private.json` (sql digest `340952d2`),
with the completed trace beside it. the runtime closed normally before this edit;
the historical full preservation proof is reused, not rerun.

the current candidate splits membership into parenthesized admitted-or-exact
existence predicates, each retaining the canonical published reading bounds and
reading filters. preferred-owner hydration, ranking, readiness and caps stay fixed.
mechanism acceptance remains pending: the new actual plan must eliminate the
437-reading rescan per candidate, small source/piece/frozen-ref/mixed-scope parity
must pass, and the affected active related journey must qualify. source shape
alone establishes no performance improvement.
