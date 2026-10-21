# search retries lack an interaction budget

status: open; source-confirmed policy, repeated-timeout runtime check pending.
origin: 2026-10-21 search latency review.

`apps/web/src/lib/api/serverState.tsx:65-95` gives reads three attempts and
retries transport/non-defect 5xx failures. `lib/api/proxy.ts:105-107,174-176,226`
allows each search request 30 seconds to response headers and emits a retryable
504 on timeout. `lib/search/searchApi.ts:7-30` supplies no overall deadline for
either full search or previews; `lib/nexus/useNexusFind.ts:70-77` additionally
starts content only after direct retrieval settles.

impact: three header timeouts can keep one search stage pending for roughly
90 seconds plus backoff; this is a consequence of the policy, not a measured
incident or an upper bound on body consumption. timed-out retries can also
repeat expensive retrieval. the observed 13–16 second successful searches do
not require retries and have a separate retrieval-performance owner.

reproduce: in an isolated stack, hold search headers past the proxy deadline
and observe attempts and elapsed time. give interactive search one elapsed-time
budget across retries and body reading; retain successful phases and expose a
targeted retry. preserve the shared read primitives rather than creating a
second search transport.

resolved when a slow/failed current query terminates within its declared
interaction budget, obsolete queries cannot update the view, and retries do
not restart a fresh full budget. backend cancellation needs separate proof.
