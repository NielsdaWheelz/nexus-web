# downloads account-menu device qualification

gap: the repaired downloads row has not been qualified on a phone. no android
device was attached during implementation; layout, enlarged text and native
interaction remain unobserved.

the downloads branch (`apps/web/src/components/appnav/AccountMenu.tsx:215–229`)
uses the standard link descriptor, replacing the nested button/collection
anatomy introduced in `b83aae99f` (#801). `ActionMenu.tsx:720-759` under
`apps/web/src/components/ui/` owns layout, semantics and dismissal. consumed
navigation keeps the menu open. an unhandled primary click dismisses the menu
and leaves navigation to the browser.

on the next matching installed android build, check account order: reading
record, imports, downloads, settings, separator, sign out. resolve when downloads
aligns with neighboring links, enlarged text fits, and navigation preserves
unfinished writing and destination focus. check cancellation, dismissal and native
modifier behavior. the row requires the android bridge.
