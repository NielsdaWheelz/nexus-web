# share account auth failure escapes inline feedback

status: open · origin: 2026-10-02 frontend cleanup map, base `56b889bdc` · area:
web inbound share capture

`apps/web/src/app/share/ShareCapture.tsx:89-92` reads `/api/me` before a plain
text capture. outside the authenticated shell, `useResource.ts:196-204`
retains a `401 E_UNAUTHENTICATED` as an error. `ShareCapture.tsx:339-348`
passes that error to `shareCaptureErrorContent`; its switch at `:44-56`
handles only `E_NETWORK` and throws every other code. an account auth failure
therefore escapes render instead of showing the existing sign-in guidance
used for capture-command auth failures at `:143-158`.

impact: a share whose session expires before the account read completes loses
the capture card. `app/share/page.tsx:10-13` deliberately forbids trapping a
share behind a login redirect. source control flow verifies the throw; real
browser reproduction is pending.

prerequisites: none. map the failed account read to the owned unauthenticated
capture result without starting capture or navigating to login. keep the
scope contract; do not make generic resource reads redirect outside the shell.

acceptance: open a plain text share with an initially admitted session, end it
before `/api/me` settles, and observe sign-in guidance plus Done on `/share`,
no capture mutation and no login navigation. `./scripts/test` passes.
