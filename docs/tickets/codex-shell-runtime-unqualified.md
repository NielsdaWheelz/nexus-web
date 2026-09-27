# codex shell runtime unqualified

status: open · origin: 2026-09-26 owner-approved redesign · area: codex execution

## problem and evidence

the owner approved subscription-backed native shell, disposable scratch and
public internet under [the shell plan](../codex-shell-cutover-plan.md).
the former frozen-mcp-only requirement is superseded, not proved. current
code still rejects native tool-bearing work (`apps/codex_agent/host.py:1026`,
`python/nexus/services/codex_generation_contract.py:183`) and has no generation
http api, remote exec selection or separately isolated shell environment.

enabling shell inside the current sandbox would expose enrolled auth reads:
`apps/codex_agent/credential_state.py:196` links auth into native state; the host mounts it in
`deploy/hetzner/docker-compose.yml:275`. pinned 0.157.1 source
`codex-rs/protocol/src/permissions.rs:805` permits root reads under workspace
write; its linux sandbox binds root read-only.
`apps/codex_agent/sandbox_health.py:58` proves a write boundary, not credential-read
exclusion. current egress permits only openai hosts
(`apps/codex_agent/egress_policy.py:64`), not the newly approved public network.

codapt2 `4f79e5a` demonstrates remote execution and shell http on 0.153.1.
its structured projections use apis; earlier nexus mcp receipts do not prove
0.157.1 remote shell plus strict json or the new authority/teardown boundary.

## prerequisite and acceptance

implement the linked plan without local execution or metered-provider
fallback. first prove native shell and strict json together on 0.157.1, with
auth/control paths inaccessible. then qualify private api effects/replay,
account visibility, credential revocation, public/private network boundaries,
detached-process teardown, auth refresh, every required model/effort and real
nexus chat/background journeys on the final pins. keep current ineligibility
until the replacement is proved; never bypass startup validation.
