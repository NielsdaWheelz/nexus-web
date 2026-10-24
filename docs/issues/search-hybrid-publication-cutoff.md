# historical publication abort remains unjoined

the `eb78c9c0` run aborts browser related search at 3753 ms without a response id.
one api 499 reports 1514.38 ms, but the records cannot establish that it belongs to
the failed browser request. its responsible stage remains unknown. private
evidence: `current-corpus-client/preservation.private.tar` under
`.nexus-local/search-qualification/`, sha `890cc27a`.

the subsequent correlated reproduction identifies the browser read deadline,
roughly 1.8 s of api work and a substantial unassigned browser-to-completion gap.
an earlier identical-url request remains pending until shortly before the focal
request enters the proxy. that supports browser cache coordination as a mechanism;
it does not retrospectively join the historical 499 or prove the exact old blocker.

`apiFetch` now assigns request identity before dispatch and enforces no-store.
the two-page admission-held control admits both identical-url requests before
either response. the affected corpus verification then presents keyword/related
results in 779/2911 ms during one committed publication under unchanged deadlines.
private trace/verification archives: `operation-trace-client/` and
`cache-verification-client/` in the same qualification directory.

the current affected operation passes; historical attribution remains uncertain.
resolve this historical question only with attributable original evidence. do not
repeat runs to manufacture that evidence. the observed current background 504 is
tracked separately in [restoration latency](search-restoration-latency-tail.md).
