# stage filter puts source processing after metadata

origin: 2026-11-01 import survey at `61562d1`
status: carried open; imports-pane redesign remains deferred

at `aed29154`, `apps/web/src/lib/imports/query.ts:53` derives `IMPORT_STAGES` from `STAGE_COPY` insertion order. `copy.ts:362` places source processing after index and metadata, and `components/imports/ImportsToolbar.tsx:51` renders that order. the owning pipeline order is upload, validate, extract, finalize, source processing, index, metadata (`python/nexus/schemas/import_history.py:22`).

impact: the filter order contradicts the pipeline it names. resolve when the existing filter owner follows the declared pipeline order without a second competing order. no new runtime check was run for this source-only carry.
