# phone pane controls appeared over the first list rows

observed twice in the toolbar lab at `8a16a039a` on 2026-11-14, chromium
390×844 at 3× scale: roughly the first 150px of list content sat under stationary
pane controls. desktop was unaffected. scroll position was not recorded;
restored scrolling and an emulation artifact were not ruled out. no handset
reproduction exists.

impact: the first rows appeared obscured. the suspected boundary is the
registered header/control offset in `apps/web/src/lib/mobileShell/viewport.tsx`
and its consumption by `PaneShell`; an offset defect is not yet established.
`692520c34` replaced the stacked controls with collation. this old observation
has not been reproduced against the current chrome.

resolved when: a library-pane reproduction at confirmed `scrollTop=0`
identifies the cause or shows the report is stale. any layout repair must
preserve normal restored scroll position and be checked on the phone before
claiming handset qualification.
