# pr-06: frontend pdf reader read path

## goal
Ship S6 PDF reading in the web app via PDF.js using authenticated signed file access, with resilient in-session file transport.

## builds on
- pr-03 (pdf processing lifecycle/readiness and `GET /media/{id}/file` signed-url contract)

## acceptance
- readable PDF media opens in an in-app PDF.js viewer (no document iframe path).
- viewer document fetch starts from the canonical authenticated file endpoint and uses short-lived signed URL handoff; the app contract does not expose long-lived/public storage URLs.
- continued reading works for multi-page/large PDFs under incremental/range-loading semantics expected by S6.
- when a signed file URL expires during an active viewer session, the client re-fetches the file endpoint and resumes PDF.js loading without forcing users to restart the session.
- PDF.js worker execution is compatible with constitution CSP (`worker-src 'self'`) via same-origin worker delivery.
- scanned/image-only PDFs remain visually readable while text-layer-dependent affordances follow S6 degrade semantics (no false-success selection/highlight path on pages without usable text layer).
- password-protected or otherwise failed PDFs surface deterministic non-success states consistent with processing outcomes, instead of ambiguous loading/empty states.
- existing non-PDF media reading behavior remains unchanged.

## non-goals
- no persistent PDF highlight create/update UX.
- no linked-items pane PDF integration.
- no quote-to-chat behavior changes.
- no redesign of backend PDF lifecycle beyond minimal transport/CSP interoperability required for this reader path.

## key decisions (if any beyond l2)
**reader gating contract**: viewer availability follows readable-file semantics, while quote/search/text-layer-dependent actions remain gated by PDF text-readiness semantics from the existing media capability model.
