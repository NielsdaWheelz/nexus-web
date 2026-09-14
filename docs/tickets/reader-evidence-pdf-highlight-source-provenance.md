status: open
origin: 2026-09-13 bounded evidence implementation audit
area: retained pdf evidence / highlight geometry

`highlight_pdf_anchors` records media id, page, geometry and optional text-match
positions, but no source generation or immutable asset identity
(`python/nexus/db/models.py`, `HighlightPdfAnchor`). unlike a text fragment id,
media membership and page bounds cannot attest that the same geometry belongs to
a retained pdf revision. current `reader_evidence.py` validates current page bounds
only. projecting that geometry onto an arbitrary selected older revision would
silently claim provenance that was never recorded.

inspect the pdf replacement/highlight lifecycle before choosing the narrow rule.
reuse existing source identity for new authored geometry if the lifecycle does not
already prove it. keep existing authored records reachable; no inferred historical
generation from timestamps, matching page counts or a display quote. known exact
source geometry must remain available for explicit locate.

acceptance: geometry from one pdf cannot paint or locate a different retained
binary; title-only publication preserves usable same-source geometry; pre-cutover
records without attestation have an explicit, preserved disposition.

the existing pdf leaf can update selected geometry through `editingHighlightId`
(`apps/web/src/components/PdfReader.tsx:2454`), but the public
`EditHighlightBounds` handler rejects pdf at
`apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx:5596`. explicit
reattachment must enable that existing intent, bind the selected generation to
the write, and refresh its detail even when the old unverified highlight is
absent from the painted page. showing an unavailable notice alone is insufficient.
