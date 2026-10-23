# writing runtime overlap evidence is limited

source cause fixed: `apps/web/src/lib/notes/journal.ts` serializes exported
start/stop operations before the same-account fast path. stop and security pause
invalidate startup generations synchronously; superseded starts cannot adopt a
runtime lease. rejected operations settle the chain before its next operation.

ordinary recovery, account switching, sign-out retry and competing sign-outs
passed in private run20 (`20261021-180404-f0859a2a9b78`,
`/tmp/nexus-writing-live-20.log`). no continuing teardown defect was observed.

remaining uncertainty: those journeys did not suspend an older stop across a
new same-account start or force overlapping initial starts. serialization was
source-reviewed; those exact interleavings were not exercised. this limits the
concurrency claim, not the demonstrated ordinary flows. close when existing
runtime evidence covers that ordering; no separate verification framework is
required.
