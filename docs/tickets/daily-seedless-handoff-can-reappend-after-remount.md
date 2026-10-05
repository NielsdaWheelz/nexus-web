# daily seedless handoff can reappend after remount

status: deferred. origin: 2026-10-04 independent source review. area: daily / handoff ownership.

at `c13ddb87c9b03b1904dcd047c79617a240544829`, `apps/web/src/lib/resourceSurface/useResourceSurfaceSession.ts:266–269` keeps applied handoff ids per mount, while lines 766–825 append their text into the persistent account writer. `apps/web/src/components/resource-surface/ResourceSurfaceBodyEditor.tsx:66–68,197–213` does not mount a filtered-out row, so that editor cannot claim its handoff.

impact: remount before a hidden row claims its completed seedless handoff can lose the applied-id memory and append again. this is a source-derived hazard, not an observed duplicate.

prerequisite and fix: qualify the daily retained handoff/claim boundary; keep application identity with the durable owner that retains the appended body, preserving composition and claim contracts.

acceptance: apply a completed seedless handoff while its row is hidden, remount before claim, then reveal it: text appends once and the handoff settles.
