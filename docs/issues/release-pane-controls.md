# pane controls: remaining device observations

problem: the shared controls have qualification limits outside the available
headless browser/emulator inputs at `2f8e81d6e`. do not describe these branches
as observed.

- no supported physical hybrid reporting both `(pointer: fine)` and
  `(any-pointer: coarse)` was available. `Control.module.css` and
  `Selection.module.css` use the same any-coarse target policy; chromium touch
  emulation is not evidence of that physical combination. the owned android
  webview reported coarse primary input and a 44px download-policy label.
- native screen-reader speech and touch exploration were not exercised.
  browser-accessible names, descriptions, roles and keyboard focus are narrower
  evidence.
- local sqlite read failure was not induced. `EvidencePane.tsx` derives failed
  contributor descriptions from each existing source status; remote failure
  does not establish local failure behavior.
- skip-silence defaults were saved and reopened through the real service;
  native decoded-audio shortening was not measured. the playback engine is
  unchanged.

before claiming these observations: use an owned supported hybrid to check
whole-chip removal and 44px targets with both inputs; check tab/radio/checkbox
announcements and count descriptions with native assistive technology; induce
an actual disposable local read failure and verify available content, unknown
counts and retry; confirm skip-silence during real native podcast playback.
preserve normal runtime/storage owners; add no test seams.

this is verification debt, not an observed product defect. remove each item
when its stated observation is made. no deployment or schema step is required.
