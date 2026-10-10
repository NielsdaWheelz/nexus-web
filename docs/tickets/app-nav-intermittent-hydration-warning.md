# intermittent navigation hydration warning

status: open, reproduction unqualified
origin: 2026-10-09 media-row integration on `167773ac1`
area: web / app navigation

one initial authenticated library reload reported `A tree hydrated but some
attributes ... didn't match the client properties`. the captured tree reached
`AppNav` → `NavRail(activeId=libraries, collapsed=false)`
(`apps/web/src/components/appnav/NavRail.tsx:34`). the 1000-character console
cap lost the differing attribute; the source cause and visible impact are unknown.
two subsequent library/visual reloads and two actual 200% zoom runs were clear.
the retained temporary `hydration-warning.json` rerun also recorded no errors.

reproduce with uncapped console output before changing the navigation owner;
identify and repair the server/client attribute disagreement there. acceptance:
the diagnosed reload reproduces before the fix and stays clear afterward,
without suppressing the warning or changing navigation behavior.
