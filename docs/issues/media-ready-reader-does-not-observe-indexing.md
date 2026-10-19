# a readable media pane can stop observing unfinished indexing

status: open
origin: 2026-10-16 feedback design audit; source at `69c00182c832`
area: web / media readiness feedback

problem: reopening readable media while its search index is still preparing
can leave the preparation message stale after indexing completes.

evidence: `apps/web/src/lib/media/useMediaProcessingStatus.ts:11,19-36`
treats `ready_for_reading` as settled and decides initial observation from
processing status alone. `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:113`
passes no retrieval state. the backend deliberately treats readable media with
pending/indexing work as in flight (`python/nexus/services/media.py:421-457`).
an unrelated imports invalidation or metadata reread can mask the gap. source
analysis only; no live reproduction in this review.

prerequisites: use the authoritative processing observation contract, which
includes readable media with unfinished search work and source refreshes.
fix: establish observation when entering a media pane without using source
readiness as a proxy for all work being settled; let the server's terminal
frame own completion.

acceptance: open media already ready for reading with pending/indexing retrieval,
then finish indexing. its capability state and preparation message update
without reloading, reopening, or unrelated imports/metadata activity. fully
settled media does not retain an unnecessary live subscription.
