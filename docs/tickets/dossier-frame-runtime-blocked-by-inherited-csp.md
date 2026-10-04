# dossier frame runtime blocked by inherited csp

status: open · origin: 2026-10-04 one-find slice, isolated find harness (branch `cleanup/one-pane-find`) · area: dossier / artifact pane

the dossier document's in-frame runtime never runs, in any environment. the
`srcdoc` iframe inherits the embedding document's csp (policy container
inheritance), and the app policy admits only the app's per-request nonce
(`apps/web/src/lib/security/csp.ts:26`, the same `script-src` in every
environment; dev adds `'unsafe-eval'`). the frame's inline `<script>` carries
the frame's own random nonce, which the inherited policy rejects
(`apps/web/src/components/dossier/DossierDocumentFrame.tsx:108` `FRAME_CSP`,
`:134` `randomToken`, `:169` the srcdoc, `:212` the per-generation nonce,
`:247-248` `sandbox="allow-scripts"` / `srcDoc`).

evidence (harness console, every dossier open on the isolated stack):
`about:srcdoc:47 Executing inline script violates the following Content
Security Policy directive 'script-src 'nonce-<app nonce>' 'strict-dynamic'
'unsafe-eval''`. with playwright `bypassCSP` the old in-frame find journeys all
passed, so csp was the only blocker.

impact: everything the runtime does is dead: citation clicks (`Citation`
messages) never reach the pane, and the in-frame find never worked. the
one-find slice deleted dossier find instead of porting it; the artifact pane
publishes no find, so cmd/ctrl+f falls through to the browser's own find.

proposed fix: render the sanitized dossier without any in-frame script. either
sandbox without `allow-scripts` and with `allow-same-origin`, so the parent
drives the frame's dom (citation clicks, and find as the plain dom case:
`buildDomTextCursor` + the shared matcher + `highlightPainter` against the
frame document), or render into the parent under the nonce csp. then re-add
dossier find as a `FindSource` like conversation find.

acceptance: on a live stack with the production csp, a dossier citation click
opens its source, and cmd/ctrl+f in the artifact pane opens find, counts,
paints, steps and returns.
