# the ?nexus=1 url ingress reappears after a reload

status: open · origin: 2026-09-28 nexus launcher rewrite review (size/nexus-launcher-web) · area: nexus / workspace restore

`useNexusOpenRequests` (`apps/web/src/lib/nexus/events.ts`) consumes
`?nexus=1&intent=…` once and strips it with `history.replaceState`, but the workspace then
rewrites the address bar from the pane href captured during SSR, which still carries the
params. a reload reopens the Nexus. present before the rewrite (baseline xfail).

evidence: live harness 2026-09-28, launcher suite `test_url_ingress_is_consumed_once` (xfail):
after Escape the url is not `/libraries?keep=1`.

fix: the workspace's initial pane href must drop the Nexus ingress params (the owner of the
SSR pane href strips them), or the ingress must strip them before the workspace captures the href.

resolved when: opening `/libraries?nexus=1&intent=Root&keep=1`, pressing Escape and reloading
leaves the url at `/libraries?keep=1` with the Nexus closed.
