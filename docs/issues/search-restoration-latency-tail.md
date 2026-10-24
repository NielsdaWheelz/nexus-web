# restored-pane related request times out during publication

the current affected verification (`22f06aec`) preserves one pre-input restored
hybrid response with status 504. its correlated api trace identifies the 3000-ms
api timer while waiting for expensive-retrieval admission. the after-input keyword
and related requests both succeed and present matching results in 779/2911 ms
during the same single-attempt book publication. this is one controlled journey,
not a percentile or success claim for every background request.

impact: a restored pane can lose related results during publication even while
the active search remains usable. no deadline was extended. the earlier 126
lexical timeout remains historical evidence; its memory-limit events never
established a causal allocation failure.

private evidence: `cache-verification-client/preservation.private.tar` under
`.nexus-local/search-qualification/`, sha `1ca96265`, and its correlated
`cache-verification-independent-review.private.json`, sha `d18eeadd`.
the original failed receipts retain their original verdicts.

resolve through an explicit product decision about restored-pane reliability
during publication. if a longer finite wait is proposed, measure actual
completion first; if scheduling changes, verify affected cancellation and active
search behavior. do not infer a retrieval defect from admission expiry, discard
the failure, or launch another broad warm campaign solely for this observation.
