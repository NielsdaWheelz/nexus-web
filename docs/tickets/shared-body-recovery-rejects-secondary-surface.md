# shared body recovery rejects a secondary surface

status: deferred. origin: 2026-10-04 independent source review. area: resource surface / retained body recovery.

at `c13ddb87c9b03b1904dcd047c79617a240544829`, `apps/web/src/lib/notes/writingSession.ts:823–825` filters retained bodies by `ownerKeys` membership but returns the original `ownerKey`. `apps/web/src/lib/resourceSurface/useResourceSurfaceSession.ts:1089` rejects a candidate whose original key differs from the recovering surface.

impact: a body shared by surfaces a/b can be discoverable through b but rejected on recovery. this is source-only; no actual retained recovery failure is claimed.

prerequisite and fix: qualify shared-body versus surface-operation ownership, then let the recovery owner admit the body through the current member without adopting unrelated original-owner operations.

acceptance: recover the shared retained body through b while unrelated a operations remain untouched, preserving retained bytes and native save identity.
