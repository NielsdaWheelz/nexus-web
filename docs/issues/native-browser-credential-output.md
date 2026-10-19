# credential page printed during production browser qualification

status: open · origin: 2026-10-14 x-title release session · area: operator credentials / browser control

the delegated product reviewer used a broad `mcp__cua_repl` accessibility output
while locating its separate firefox window. native mac control followed the
user's foreground window instead. the output included a cloudflare token-created
page with an api token and an s3-compatible access-key/secret-key pair. this proves
those values appeared in the internal tool transcript; their permissions, expiry,
retained-result audience and any access outside that transcript are unknown.

no values are reproduced here. the reviewer did not use the credentials, submit
them to an endpoint, or copy them into the proof archive. later output was limited
to navigation controls; native interaction is paused while the user is active.
this incident does not establish third-party access or credential misuse.

prerequisite: the credential owner assesses the retained transcript's access and
retention boundary. confirm containment or revoke/replace the affected credentials
through their existing owner, preserving legitimate consumers. do not copy the
raw transcript into public issues. browser qualification must verify the task
window and restrict emitted state; do not inspect another active window broadly.

acceptance: the owner records containment or completed scoped recovery, and
qualification no longer emits unrelated foreground-page content.
