# live reading progress dismisses the account menu

after the 9b2d8e0b1 deployment, the user reports that firefox's account menu
repeatedly closes while reading preparation advances. `SyncStatus.tsx` renders
changing counts in an intrinsically sized row; `ActionMenu.tsx` correctly
invalidates an open menu when its published row or panel geometry changes.

the account presentation now reserves a bounded width and four-line scrollable
viewport for live progress. stable detail-slot identity preserves scroll position
across count updates. errors retain natural height; the generic geometry guard
and reduced-motion behavior remain unchanged. no sync/storage contract changes.

resolve after the installed desktop menu stays open through advancing counts and
wrap changes, with its actions reachable and overflow text readable. the phone's
static icon is consistent with the user's confirmed reduced-motion setting;
firefox's current-shell motion observation remains pending.
