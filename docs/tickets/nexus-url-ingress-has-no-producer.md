# the nexus url ingress has no producer

status: deferred (owner decision) · origin: 2026-09-28 nexus launcher rewrite (size/nexus-launcher-web), verified finding F10 · area: nexus

`consumeUrlIntent` in `apps/web/src/lib/nexus/events.ts` opens the Nexus from
`?nexus=1&intent=Root|QuickAction&action=<command id>` once, then strips the params with
`replaceState`. nothing produces such a url: no link in apps (android kotlin and the
extension included), python, node, scripts, deploy, docs or `manifest.ts`. the rewrite kept
it under a coordinator hold. the pending-intent queue and the `Nexus.OpenRequested` event in
the same file are live and separate.

impact: about 25 lines, and the reload defect in
[nexus-url-ingress-reappears-after-reload](nexus-url-ingress-reappears-after-reload.md)
exists only because this ingress does.

fix: the owner chooses. delete `consumeUrlIntent` and its layout effect (and the reload
ticket with it), or keep it as a documented deep link in `docs/modules/app-navigation.md`
and fix the reload ticket.

resolved when: the ingress is deleted, or documented with the reload defect fixed.
