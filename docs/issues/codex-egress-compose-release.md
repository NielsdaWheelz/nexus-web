# codex host deployment acceptance

status: the stock codex `0.160.0` host, nginx egress allowlist, encrypted account
bind and docker confinement already shipped in production `dc12792e0` (schema
0312, wire 14). the retired `7dc68929b` host/account/socket migration and its
old rollback instructions are obsolete. production retains its encrypted account.

the current endpoint/cwd rollout belongs to
[shared live codex](release-shared-live-codex.md). deployment and recovery belong
to [the canonical runbook](../../deployment.md); account administration belongs
to [the host runbook](../runbooks/codex-personal-agent-host.md).

the canonical check passed on `dc12792e0`, including host health and isolation.
the owner-confirmed short ai reply in #796 does not identify its provider route.
remaining acceptance: one codex chat and one codex background generation through
ordinary product paths, recording their deployed source, route and result. if
either fails, inspect the host's resolution/egress diagnostics before changing
its account.

delete this record when the remaining generation acceptance is recorded.
refresh-token qualification stays in
[its own issue](codex-auth-refresh-not-qualified.md).
