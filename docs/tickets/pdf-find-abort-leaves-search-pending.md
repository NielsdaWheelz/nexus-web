# pdf find abort leaves search pending

status: deferred · origin: 2026-10-04 independent source review · area: pdf / find

the counted-search promise removes its event listener on abort without resolving or rejecting. a canceled search can remain pending indefinitely, even though its counted event can no longer settle it.

source-only evidence at `464098c1144d18a5a074f0a113268abb84d3cbbd`: `apps/web/src/components/pdfFind.ts:131` creates the promise with only `resolve`; its abort listener at `:139` only removes `updatefindmatchescount`. no mounted abort failure is claimed. repair the pdf find owner separately from the active note-editor rewrite.

resolved when: abort rejects with `AbortError`, removes the counted and abort listeners, and a subsequent query completes normally. qualify cancellation through the actual find source.
