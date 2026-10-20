# intermittent navigation hydration warning

status: open, generated-id disagreement reproduced; cause unassigned
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

2026-10-19 filter-toolbar qualification on `4d6d6f85d`: standalone firefox 158
with a dedicated extension-free profile reproduced the attribute-only warning
on authenticated `/notes?sort=title&direction=asc`. the development overlay
points to `apps/web/src/components/appnav/AppNav.tsx:217`, the account trigger,
through `ActionMenu.tsx:364`, `AccountMenu.tsx:109` and `AppNav.tsx:210`.
the account button's `id` differs: client `_R_3pd8ld9knelb_`, server
`_R_7iqhaqjknelb_`. the pane switcher's `aria-describedby` also differs: client
`_R_9l8ld9knelb_`, server `_R_jahaqjknelb_`; other generated menu/header ids differ.
native page zoom and toolbar geometry passed; that does not resolve this warning.
cause and relation to earlier observations remain unestablished. do not suppress
it or claim the full authenticated load was warning-free.

the same firefox/profile/cookies and route on parent `7aa93a960` reproduced the
identical account `id` and pane `aria-describedby` mismatch on its first cold
load. this establishes that this specific warning predates the toolbar change;
it does not identify its cause. the temporary baseline server/worktree was removed.

independent resource-metadata qualification reproduced the same account id
mismatch on a fresh isolated `/notes` load before zoom, without resource fixtures,
and on detached parent `5cf2cc05ce6c1d99c790614acc920f3a64aae0dd` with a fresh
firefox login/device. chromium direct/reload was clear; firefox had no `pageerror`.
uncapped console and the opened issue panel distinguished this attribute warning
from the separate tree-replacement error. these observations establish that it
also predates the metadata change; transient diagnostics were removed at cleanup.
