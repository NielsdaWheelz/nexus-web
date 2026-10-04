# library governance keeps an unreachable route reset

status: deferred · origin: 2026-10-04 source audit · area: library governance / web

`apps/web/src/lib/libraries/useLibraryMembers.ts:276–286` resets its state when `libraryId` changes and `governanceState.ts` carries a route epoch. the sole hook caller is `app/(authenticated)/libraries/[id]/LibraryPaneBody.tsx:190`; `lib/panes/paneRenderRegistry.tsx:19` mounts that body, while its next page returns null. the library route uses in-place query navigation (`lib/panes/paneRouteModel.ts:142–151`), but `components/workspace/WorkspaceHost.tsx:385–394` keys the body by visit, route and pathname. changing the library id remounts the controller, so its cross-library reset path has no supported caller. this is source-qualified duplication, not an observed user defect.

before deleting the reset and route-epoch machinery, confirm the full caller and unmount closure. keep cancellation of in-flight reads and search, and ignore late nonabortable command completion after unmount. acceptance: mounted navigation and return behavior, busy feedback and command settlement remain equivalent without a reused-hook cross-route state path.
