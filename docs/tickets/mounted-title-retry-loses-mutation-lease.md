# mounted title retry loses its mutation lease

status: deferred. origin: 2026-10-04 independent source review. area: resource surface / mounted title actions.

at `c13ddb87c9b03b1904dcd047c79617a240544829`, `lib/resourceSurface/useResourceSurfaceSession.ts:696–706` acquires the title lease only in preparation and clears it after a 4xx failure. `lib/notes/writingSession.ts:678–693,794–801` retries the frozen request without preparation. `lib/actions/mountedActionHandoff.ts:119–128` leaves a failed mounted slot in editing. paths are under `apps/web/src`.

impact: a retried title success can have no lease to settle its occupied mounted action. this is source-derived; no runtime rejection/retry failure was observed.

prerequisite and fix: qualify the actual title rejection/retry caller and repair mutation-lease ownership across frozen-request retry, preserving once-only settlement and request identity.

acceptance: an actual rejected title write followed by retry/success settles its mounted action once and admits the next action.
