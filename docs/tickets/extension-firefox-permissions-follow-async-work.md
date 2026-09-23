# firefox permission requests follow asynchronous work

status: open · origin: 2026-09-23 firefox v1 review · area: extension permissions

`apps/extension/popup.js:141-152` awaits web auth before requesting the nexus
origin. `:284-290` awaits storage and tab lookup before source permissions at
`:257,268`. firefox requires `permissions.request` in a user-input handler;
awaiting a promise loses that status. connect also ignores a false permission
result before storing the token and reporting connected (`:152-154`).

evidence: [mozilla user actions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/User_actions).
call ordering is source-confirmed; no live firefox reproduction yet.

fix: resolve permission needs before an explicit click and request permission
directly from that handler; keep nexus host configuration outside the capture
form. respect denial. use active-tab access where sufficient.

acceptance: a fresh firefox profile connects and captures supported files;
denial produces an actionable state, never a connected/saved assertion or a
silent change of capture mode.
