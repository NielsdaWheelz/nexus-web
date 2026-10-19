# local account bind fails the native host ownership precondition

the existing mac `codex-personal` account bind is unreadable by the documented
container user. this prevents a fresh local generation host from starting.

2026-10-19: mounting the enrolled directory at `/account` showed directory/file
owner 0 and modes 0700/0600 inside docker; the default uid 10001 host raised
`PermissionError` reading `auth.json`. the required ownership is documented in
[the host runbook](../runbooks/codex-personal-agent-host.md) and
[the release preflight](codex-egress-compose-release.md).

search verification used a disposable uid-0 host/socket override with the real
account bind; it did not qualify the default permissions or change runtime code.
no enrolled credential was copied or its permissions relaxed.

resolve the local bind mapping or enroll into a correctly owned account volume.
prove that the default container user can read/refresh the account and serve the
catalog after restart. keep credential contents private; do not ship a root-user
runtime workaround.
