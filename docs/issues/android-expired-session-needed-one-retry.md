# android expired-session restoration needed one retry

status: open investigation; service restored · origin: 2026-10-14 release `665e7b3af` · area: android / hosted authentication

at 21:04:03 utc the final signed apk reopened the persisted 58c test login and
showed “we couldn't restore your session right now” with retry. one ordinary
retry restored the authenticated lectern by 21:04:58. no re-login, cookie change,
or credential injection was used. the original jwt was issued around 19:22;
production jwt expiry is 3,600 seconds. desktop's separately persisted session
restored normally against the same deployment.

impact: expired sessions may require manual retry. this is an availability
observation, not proof of a lost login or a source defect. the initial response
and dependency failure were not captured; the screen it showed
(`SessionRecovery.tsx`, deleted by #607 at `5fea2a3fe`) appeared for a fetch
typeerror or a resolve 503; its successor is `app/auth/session/unavailable`. do not assert a specific
supabase outage, status, or timeout from the screenshot alone.

private evidence: campaign `attempts/665e7b3af/phone-final/` contains
`first-open-after-expired-token.png`, `recovery-retry.xml`, and
`auth-refresh-observation.json`. final cold-reopen and sign-in results belong
in the release acceptance receipt.

next: correlate the first attempt with hosted auth logs, then observe a natural
expiry from a phone session. preserve credentials during transient dependency
failure and retain the existing retry path. change code only if that identifies
a defect at its owner.

acceptance: explain the captured failure or reproduce and fix its cause, and
observe successful natural-expiry restoration on the production phone without
misreporting a manual retry as unattended success.
