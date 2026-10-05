# daily root entry bypasses server redirect

status: deferred. origin: 2026-10-05 simplify-05 original browser controls at `5bc79139d1a0681eddcc7cafbdfc10895577bb12`; area: authenticated workspace entry. live reproduced; excluded from the profile transport cut.

an authenticated hard entry to `/daily` remains there and renders “This route is not yet supported in side-by-side pane mode: `/daily`”. the intended account-zone redirect in `apps/web/src/app/(authenticated)/daily/page.tsx:6–13` does not establish the actual entry behavior. protected receipt `browser-profile-original-1791177432583.json`, source `d1898f453176d9ba3610b47873401936e0be7426b4d4b04ea47b68e7eefd668a`, records six earlier profile/context/reload checks passing and zero page errors; the same-visit today action correctly reaches its account-local dated route.

`(authenticated)/layout.tsx:28–38` accepts no children and renders only `WorkspaceBootstrapGate`. that gate renders `AuthenticatedShell` at `14–24`; the shell mounts `WorkspaceHost`, which owns the visible route. `lib/panes/paneRouteModel.ts:346–352` admits only `/daily/:localDate`, falls through to unsupported at `654–663`, and `components/workspace/WorkspaceHost.tsx:182–190` prints the observed message. the daily page's declared redirect is therefore a hidden server path, not evidence that authenticated `/daily` is supported.

prerequisite: choose the workspace entry owner for account-local “today”, without adding a second router. route bare `/daily` through that owner, using the authenticated account time zone, or remove the unused redirect in the same coherent cut.

acceptance: an actual authenticated hard entry to `/daily` reaches the correct dated daily pane; the ordinary today action and dated deep links still work. qualify a zone whose local date differs from the browser date. source-only redirect code is insufficient.
