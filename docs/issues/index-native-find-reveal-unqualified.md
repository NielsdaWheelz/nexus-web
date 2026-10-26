# browser findbar reveal remains unqualified

chromium renderer `window.find` selects the exact final title and row identity
of a200-row library. a plain native overflow-list control also selects without
scrolling, matching the app. the earlier viewport assertion was an invalid oracle;
it does not establish a product scrolling defect. selection/scope checks remain.

private control evidence:
`/Users/nnandal/Documents/code/nexus-web-index-proof/.nexus-local/lab/20261025-123233-0b0a0b82ceb4/artifacts/index-native-find-metrics.json`.
actual desktop browser-chrome findbar reveal and physical selection still require
owner qualification. preserve complete mounted text and native scrolling; add no
application scroll handler to compensate for the renderer api. resolve after
last-row findbar reveal and native selection in the supported desktop browsers.

firefox158.0.1 with installed geckodriver0.37.1 reached the real200-row
fixture in held run `20261025-190630-c84270b9790c`; all200 rows were mounted
and the exact final title was below the viewport. that attempt used meta+f,
which is the WRONG trigger for browser find in an active searchable pane:
`apps/web/src/components/workspace/PaneShell.tsx:301–314` owns `Pane.Search`
and calls `preventDefault()` when its pane query opens. the shortcut definition
is in `apps/web/src/lib/shortcuts.ts:11`. the attempt did not record
`defaultPrevented` or final app-input focus, so interception in that specific
execution is not independently proved; an automation capability failure is not
established either. browser findbar reveal remains NOT_RUN.

future qualification should invoke the actual browser menu's find-in-page
command rather than the page-dispatched shortcut. installed firefox browser
chrome wires `menu_find` and `appMenu-find-button2` to `cmd_find`; privileged
webdriver chrome context already exists in the isolated driver. that route has
not been run. private artifact: `index-firefox-held-font-findbar.json`. the
isolated browser, process group and private nss profile were removed; no app or
device changes were made. this is a test-trigger error, not a product defect.
