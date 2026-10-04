# library invitation cancellation focuses an adjacent row

status: open. origin: 2026-10-04 mounted old/candidate controls at `4618250579cc0e4a4413c5188ff2932c7ee96ada`; area: library members surface. priority: p3.

`apps/web/src/components/libraries/LibraryMembersSurface.tsx:80-99,129-179,430-443` removes the revoke trigger while showing its inline confirmation. the saved trigger node is then disconnected; cancel falls back to the next row's focusable control. a programmatic-click old control targeting invitee 088 focused invitee 077 after cancel, and the same candidate control targeting invitee 087 focused invitee 035 while the target remained present. this establishes the mounted fallback, not a physical keyboard journey or a broad accessibility failure.

restore focus to the current row's recreated revoke trigger when cancellation leaves that row present; keep adjacent-row fallback for a removed row. prove cancel and confirmed removal with a focused trigger and mounted keyboard navigation, preserving dialog semantics.
