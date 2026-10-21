# a workspace change made within the save debounce is lost to a reload

status: open
origin: 2026-10-19 chat harness (as a lost chat draft); 2026-10-21 pane chrome
review (as a lost workspace change)
area: web / workspace session

the save runs 1 s after the last change (`useWorkspaceSession.ts`); a reload
inside that second has only the outgoing document's pagehide flush to carry
the change. the next document's server entry read (`loadWorkspaceBootstrap` in
`bootstrap.server.ts`) races that flush and can read the older row, and the
next document then saves its initial state, which always counts as unsaved,
over whatever the flush wrote (`put_workspace_session` overwrites without an
expected version). the change is gone from the screen and from the row.

this is the mechanism behind the deleted `pane-draft-lost-on-early-reload`:
#709 made drafts memory with a reload prompt, which superseded that file's
draft symptom, not the race.

impact: any change the address does not carry (a close, minimize, reorder,
resize, inspector) made in the second before a reload comes back undone. a change of the active pane's
address survives through the reloaded url.

evidence: pane chrome review probe (2026-10-21, tip 096f2e1e3, repeated on the
fix branch): three panes, close the inactive Libraries, reload 150 ms later →
3 of 3 restored ["Libraries","Notes","Chats"] and the row kept all three
hrefs. the harness's `quiet()` (journeys/lib.mjs) waits out the save loop
before every cold load to avoid this race.

proposed fix: saves carry the version they were read at (conventions:
expected versions), so the reloaded document's initial save of an older state
conflicts instead of overwriting, and the entry read prefers the newer flush;
or the server entry waits briefly on an in-flight flush from the same device.

resolved when: closing an inactive pane and reloading within 200 ms restores
the workspace without it, and the row holds the closed state, 5 of 5.
