# pdf mobile fit keeps seeded semantic zoom

status: deferred · origin: 2026-10-04 independent source review · area: pdf / viewport

initial mobile page-width fit updates the vendor viewer scale while the semantic capture and toolbar retain the seeded zoom. when fitted scale differs from that seed, saved/reopened position can describe a different zoom from the displayed document.

source-only evidence at `464098c1144d18a5a074f0a113268abb84d3cbbd`: `apps/web/src/components/PdfReader.tsx:2408` selects `page-width`; pages-loaded at `:2171` applies it to the viewer. semantic capture at `:1372` reads `zoomRef.current`. all assignments to that ref and `setZoom` were inspected: initialization, explicit zoom/resume/navigation and return update them, while page-width application and page-render reporting do not. no physical mobile or reopen failure is claimed. repair the pdf viewport owner separately from the active note-editor rewrite.

resolved when: actual mobile page-width fit, toolbar zoom, semantic capture and reopened zoom agree with `viewer.currentScale`, including a document whose fitted scale differs from the initial seed.
