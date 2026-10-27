# initial action menu geometry retirement

a newly opened library menu has retired before its first command while restored
panes finish rendering. the shared-controls lab focused `Delete Library`, then
`Library settings…`; enter announced “actions changed. reopen to see current
options.” no command ran. the changing rectangle was not isolated.

android hosted pdf also refused `Download for offline` with that warning in
run `20261022-171732-f4a5245e1f3d`, source `93f116efb`. fonts, surrounding layout
and initial focus remain unproved candidates for these historical observations.

an independently measured mobile-sheet animation mismatch was fixed in
`379006891`: layout offsets replace subtraction of compositor transform samples.
the installed epub/account journey now accepts its first downloads command.
this does not establish the cause or resolution of the historical cases above.

firefox mixed-reading run `20261026-201242-60e320bbbefa` at `a51f805d4` retired both
permitted passage-menu activations before text resizing, after the actor kept
g1 offline and the server published g2. the same annotation group, trigger,
opening id, highlight/note binding and literal attached note survived both
retirements. evidence: `artifacts/cross-device-localfirst/checks.json`,
`failure-firefox.txt` and `failure-firefox.png`; error state is
`kind: retired` with the same announcement. the source case hash was
`d3dcba3af03b6dedef603fc72eb7c8aca7bb6216d41955e1d90bf94ce08a24e3`.
no resize was admitted. this establishes repeated webdriver observation, not
a natural-pointer product cause: published/current meaning and rectangles were
not captured, and webdriver element-click or the menu's own focus may scroll.
text and pdf resizing are both supported; removing text coverage or granting
more retries does not resolve this observation.

chromium debug run `20261026-203306-98ddb8350c84` reproduced passage-menu
retirement with an already-visible center pointer press, without webdriver
element-click scrolling. the actual invalidator's resize-observer stack recorded
unchanged meaning, subject, viewport and menu/row rectangles; only its trigger
changed from 31.4891px square to 31.7139px square. evidence:
`artifacts/playwright/passage-menu-diagnostic-de-5975f-fter-offline-G1-and-real-G2/passage-menu-diagnostic.json`.
the shared desktop passage composer contains that trigger inside
`FloatingActionSurface`'s translating/scaling entrance. button pressed state
changes colors only. the ancestor animation explains the measured scale;
its computed transform was not recorded, so that attribution is source-backed
inference rather than a captured style sample.

source repair: the shared surface now uses its existing opacity-only entrance;
the moving keyframe and its offset variables are removed. caret, placement,
scrolling and the action menu's frozen-geometry guard are unchanged. live
verification is pending: require the original immediate pointer resize without
diagnostic instrumentation, then the firefox/composed reading journey. this
does not establish resolution of the historical library/pdf cases above.

reproduce the library case with restored panes: open a new empty library's
header menu, arrow-up twice, then enter. measure publication and activation
rectangles. resolved when these historical first-command cases pass without
relaxing meaning or geometry guards.
