# an in-pane link to bare /daily opens the unsupported pane

status: open · origin: 2026-10-10 workspace reauthoring review · area: workspace / daily

a plain click on an in-pane `<a href="/daily">` follows in its pane to the
unsupported pane. bare `/daily` means today in the account zone, which only the
server entry resolves (`bootstrap.server.ts`); the click adapter now keeps every
path the catch-all serves inside the workspace, so the click never reaches the
server. before the review fix the click reloaded the document and the entry
resolved today (and, at 12 panes, could evict a pane).

impact: low. no product link uses bare `/daily` (Today, nexus and the keybinding
open `OpenDailyPage`); only a hand-written link in user content reaches it. pane
Back returns.

evidence: `apps/web/src/lib/panes/targetLinkActivation.ts` (`BROWSER_OWNED_PATH`
omits `/daily`); `resolvePaneRouteModel("/daily").id === "unsupported"`.

resolved when: an in-pane click on bare `/daily` lands on today's daily page
without a document load and without evicting at the cap.
