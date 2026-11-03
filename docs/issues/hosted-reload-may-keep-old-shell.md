# qualify hosted update activation across two builds

natural service-worker activation waits for all old clients to close. a reload
can retain the old shell and its shared worker. feedback homes now says to close
all nexus tabs when a worker waits, and offers reload only for a document-only
mismatch; the complete two-build hosted transition remains unobserved.

owners: `apps/web/src/lib/authored/shell.ts` observes the waiting worker;
`apps/web/src/lib/native/admission.ts` chooses the remedy;
`apps/web/src/lib/api/failure.ts` supplies its closed copy. no `skipWaiting`
path forces a new worker into an old document's asset closure.

reproduce in an owned profile: keep build a open, stage build b, observe the
waiting worker and its close-tabs instruction, close every old client, reopen
and verify both the page and authored worker run b. separately verify reload
on an unambiguously document-only mismatch reaches b.

resolved when those transitions are observed with exact build identifiers and
retained local writing intact. source review of the remedy is not that proof.
