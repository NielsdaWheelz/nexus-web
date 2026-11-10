# replication stop under a future page clock

the disposable navigation check advanced the page's `Date` to 2031 while its
worker and server kept real 2026 time. after local writing and remote appends,
`apps/web/src/lib/authored/client.ts:142` reported that the local notes store
stopped responding. the
original rejected worker frame was not retained, so the cause is unknown.
evidence: private runs `20261110-060556-e9ff6bc13907` and
`20261110-064710-328b604798c9`, navigation traces before captured-note admission.
the failure preceded the assertion and browser teardown.

with real wall time, `20261110-070849-8eac1536f297` completed the same writes and
captured-note focus with no failed worker responses or pending operations;
replication results were valid. that bounds the observation; it does not prove
clock skew caused the earlier stop. ordinary navigation and midnight behavior
have separate checks.

to resolve: reproduce with passive worker error/exception evidence, identify the
original replication rejection, and either repair its owner or establish why
the inconsistent-clock fixture is outside the supported contract. retain exact
pending command bytes and local writing throughout; do not replace the stop with
a retry loop or infer a focus defect from the generic message.
