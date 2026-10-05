# pdf source retry binds before its viewport remounts

status: deferred · origin: 2026-10-04 independent source review · area: pdf / web

the source-error render branch removes the viewer viewport. successful retry bootstrap tries to bind the document before clearing that error, while viewer initialization requires the mounted container. a failed-source-to-ready transition can therefore throw a viewer lifecycle defect while the error branch still owns the dom.

source-only evidence at `464098c1144d18a5a074f0a113268abb84d3cbbd`: `apps/web/src/components/PdfReader.tsx:3923` renders the error branch; retry bootstrap at `:3193` binds before clearing error; initialization at `:2079` requires the container. no hosted retry failure is claimed. this is distinct from the existing superseded signed-url binding ticket.

resolved when: a real hosted source failure followed by successful retry restores a mounted viewer and its callbacks without a lifecycle defect. repair and qualify the pdf owner separately; the active note-editor rewrite does not alter it.
