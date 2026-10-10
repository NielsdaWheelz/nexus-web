# Back to Libraries refetches after a dwell on a library

status: open · origin: 2026-10-09 workspace harness baseline (J5.back-uses-retained-list-data, about half of runs) · area: libraries / visit data

after reading a library for ≥ 0.3 s, Back renders the Libraries list only
after its refetch: the visit's retained rows were dropped. with no dwell they
are used. suspect: the library pane calls `useClearAllPaneVisitData` on a
placement-revision change or revalidation shortly after load
(`apps/web/src/lib/libraries/useLibraryEntries.ts`, `clearVisitData`;
`apps/web/src/app/(authenticated)/libraries/LibrariesPaneBody.tsx:267-289`),
which drops every other visit's data.

resolved when: harness J5.back-uses-retained-list-data passes repeatedly with
its xfail removed, or the clear is shown to follow a real mutation.
