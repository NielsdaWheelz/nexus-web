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
1,538ms server execution. the plan consumes an average 437 admitted readings on each of
25,002 candidate loops (1,150 audience readings total), because a candidate union mixes invariant admitted readings
with chunk-correlated exact frozen refs. private evidence is
`membership-diagnostics/remote/count-plan.private.json` (sql digest `340952d2`),
with the completed trace beside it. the runtime closed normally before this edit;
the historical full preservation proof is reused, not rerun.

splitting admitted and exact existence predicates on frozen `4298cd25f` removes
that correlated scan, but the actual count plan takes 3,753.115ms: it builds a
hashed eligibility set of 720,473 chunk ids before the bounded 25,001-row count,
reading 108,319 buffer pages. the split is not a performance acceptance.

one private sql-only candidate on the same continuous postgres process and caps
takes 522.361ms. it tests source reading membership through the chunk's existing
owner id, and restricts canonical piece admission to piece reading ids for that
source. the exact-ref arm is unchanged. the audience relation has 1,150 rows and
three one-time scans; the plan does not build the full chunk-id eligibility set.
this is mechanism evidence, not qualification of an actual application change.
private evidence: `split-diagnostics/remote/` and the distinct direct-count plan;
original and candidate sql digests are `1cb16a42` and `f0bf063f`. both runtime
windows closed normally before their respective product edits.

the current source adopts that candidate inline. the semantic reader's existing
ready predicate owns current root lexical publication; `reading_chunks_sql` still
owns complete canonical piece/index/bounds admission. each reading witness keeps
its filters. preferred-owner hydration, ranking, readiness and caps stay fixed.
small source/piece/frozen-ref/mixed-scope, legal overlap, deterministic owner and
stale-publication checks pass on current `b5234285`. the bounded count and one
current-index recall comparison complete:52/53 qualifying owners and every
reference semantic first-page owner survive without lexical masking. these
mechanism and bounded quality conditions pass, but the issue's complete affected
active related journey remains open: strict-v6 returns504 during presentation
after extra semantic retrieval. see [the active gate](search-related-timeout-during-publication.md).
private candidate timing is not an api latency or complete acceptance claim.
