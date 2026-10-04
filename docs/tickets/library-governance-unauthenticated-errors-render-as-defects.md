# library governance handles expired sessions as render defects

status: open. origin: 2026-10-04 source audit at `33a1446c29698956fb86931da4a72cec05bf6614`; area: library governance web. priority: p2.

`apps/web/src/lib/libraries/useLibraryMembers.ts:686-716` catches people-search errors without calling the existing unauthenticated-api handler. `libraryGovernanceErrorMessage` has no `E_UNAUTHENTICATED` arm, so the catch classifies a 401 as a defect and the pane throws during render. command reconciliation and load-more catches likewise omit the auth handoff, unlike `ensureFresh`. search and governance adapters propagate api 401 errors; the global unhandled-rejection boundary cannot see these consumed errors. this is a source finding; an expired-session journey has not been run.

route authenticated search, load-more and command failures through the existing auth owner before governance feedback/defect classification. prove with an actual expired-session case for each path, while genuine contract faults still reach the defect boundary.
