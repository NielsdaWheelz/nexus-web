# intermittent navigation hydration warning

status: open, reproduction unqualified
origin: 2026-10-09 media-row integration on `167773ac1`
area: web / app navigation

one initial authenticated library reload reported `A tree hydrated but some
attributes ... didn't match the client properties`. the captured tree reached
`AppNav` → `NavRail(activeId=libraries, collapsed=false)` (then
`apps/web/src/components/appnav/NavRail.tsx:34`; since the 2026-10-10 reauthor
the rail is the file-private `NavRail` in `AppNav.tsx`, and its collapse comes
from a server-read cookie, so server and client render the same width). the 1000-character console
cap lost the differing attribute; the source cause and visible impact are unknown.
two subsequent library/visual reloads and two actual 200% zoom runs were clear.
the retained temporary `hydration-warning.json` rerun also recorded no errors.
the c2nv nav harness journey `N10.hydration-console` on the reauthored rail
(2026-10-10): three cold `/libraries` loads expanded and three collapsed, zero
console or page errors matching `hydrat|#418|#423|#425` in each.

reproduce with uncapped console output before changing the navigation owner;
identify and repair the server/client attribute disagreement there. acceptance:
the diagnosed reload reproduces before the fix and stays clear afterward,
without suppressing the warning or changing navigation behavior.
