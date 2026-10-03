# notes capture acknowledgement type erasure

status: open · origin: 2026-10-02 notes read-boundary review at dfb137d10 · area: typed wire / writing acknowledgement

`apps/web/src/lib/notes/writingSession.ts:707–714` returns fresh response data as `unknown`; operation delivery at686–704 passes it to an unknown acknowledgement callback. `apps/web/src/lib/resourceSurface/useResourceSurfaceSession.ts:543–549` therefore retains the four-field `decodeDailyCaptureResult` in `apps/web/src/lib/notes/api.ts:58–84`. this duplicates an owned server response contract. it is a simplification gap, not evidence of data loss or historical response drift: journal entries at49–76 persist submitted requests/intents, not acknowledgement payloads.

prerequisite: preserve the existing per-operation acknowledgement, exact replay and unknown-outcome contracts. carry the acknowledgement type through the existing writing mechanism without casts, parallel parsers or a new controller. retain submitted mutation/date matching, surface/page identity, captured body presence and acknowledgement semantics; rich-body and persisted-storage validation keep their owners.

acceptance: typed capture response reaches its operation owner; only duplicate structural capture decoding retires. same-command and exact-replay checks preserve identity/body projection, and acknowledgement defects still retain the submitted request as an unknown outcome. rich-body and storage domain validation remains.
