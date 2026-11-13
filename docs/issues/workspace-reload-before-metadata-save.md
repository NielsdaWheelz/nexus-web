# reload before workspace metadata save

lab `20261113-061648-5bf68ae90a13` on `89b3b14ab` observed two Imports panes
(one selected, one unselected) after closing details and immediately reloading.
`merge-smoke-native.json` and `merge-smoke-chromium-failure.txt` retain the failure;
the pre-reload saved binding was not captured. separate material views are legal.

the inferred hazard is stale layout on reload before metadata acknowledgement:
`useWorkspaceSession.tsx:43-65` debounces local saves by 200ms and starts an async
pagehide flush; `model.ts:97-124` retains saved panes and appends an unmatched
incoming material view. these owners predate lit rule; causation is unproved.

resolve with a controlled save hold: compare immediate reload against reload
after actual local-binding acknowledgement, checking pane identities, selection
and collapsed details. do not replace the boundary observation with a sleep.
