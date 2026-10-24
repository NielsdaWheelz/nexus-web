# paged rereads can miss rows whose sort keys move between requests

problem: `apps/web/src/lib/api/useServerList.ts` reads one page per request,
including atomic prefix refreshes. a live sort key can move behind a consumed
cursor between requests: an import's `matched_at` after a matching event, or a
metadata history entry's time after completion. first-occurrence deduplication
removes repeated rows but cannot recover omitted ones. the collection cutover
removed imports/history/assistant writes from `usePagePrefix`; it did not add
cross-request snapshot isolation.

impact: a row can remain absent until a later refresh reconciles a quiescent
view. automatic reconciliation waits behind admitted work, eligibility and
failure recovery; there is no five-second publication bound. durable data is
unaffected.

evidence: `useServerList.ts`'s `walk` and continuation each invoke `fetchPage`
per page; `python/nexus/services/imports.py` derives live ordering. the original
imports design identified this schedule; no live omission reproduced here.

current decision: live views with refresh as reconciliation, documented in
architecture section 8.12. stronger consistency is outside this cutover; raising
endpoint limits does not solve arbitrary collection completeness.

resolved when: an actual requirement justifies stronger consistency and its
chosen owner guarantees membership while a row moves across a held page boundary.
