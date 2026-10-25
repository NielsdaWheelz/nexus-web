# local authored storage needs one commit owner

target qualification gap: browser tabs and android document replacement must
share one durable command sequence and distinguish commit from reply delivery.

evidence: current writing owners in `apps/web/src/lib/notes/writes.ts` are
tab-local memory; `docs/modules/device-startup.md` owns document-scoped native
replies. neither establishes the new cross-tab database contract. per-build
hashed shared-worker urls can create multiple workers against the same database.

resolved when the specified stable worker identity, store revision, source
sequence and native commit/status protocol pass two tabs, shell refresh,
incoming-update races, lost commit reply and document replacement. one commit
atomically publishes state, indexes and pending bytes; replay never creates a
fresh causal touch. see [specification](../local-first-writing-spec.md).
