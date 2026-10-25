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
