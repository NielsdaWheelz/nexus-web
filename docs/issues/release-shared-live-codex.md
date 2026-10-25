# shared live codex local rollout

production `c5cf4bc27` now uses
`NEXUS_CODEX_ENDPOINT=unix:///tmp/codex-daemon-10001/app-server.sock` and
`NEXUS_CODEX_CWD_ROOT=/tmp/codex-daemon-10001/cwds` in the api and both workers.
the retired `NEXUS_CODEX_NATIVE_SOCKET` is absent from their environments and the
operator configuration. the encrypted production account bind is unchanged.
[#805](https://github.com/NielsdaWheelz/nexus-web/pull/805) owns the paired release proof.

production activation does not establish every local operator checkout.
remaining operator action is to inventory active local unix compositions and
enroll their dedicated volume if they still use `NEXUS_LOCAL_CODEX_ACCOUNT_DIR`.
the new `nexus_codex_account` volume is owned by uid/gid 10001; existing bound
account state stays untouched. follow [local enrollment](../runbooks/codex-personal-agent-host.md#local-enrollment).

live labs use `--live-codex`. an unenrolled installation needs
`./scripts/lab-codex enroll`, then `up` and `status` before its first lab. ordinary
attachment reuses its compatible enrolled host. a later pin upgrade requires
drained labs, explicit `down`, then `up` from the qualified checkout; account-state
migration needs its own qualification. endpoint, transport-token and cwd contracts
remain in [the host runbook](../runbooks/codex-personal-agent-host.md).

deployed generation acceptance remains in
[codex host acceptance](codex-egress-compose-release.md); real token refresh stays
in [its own issue](codex-auth-refresh-not-qualified.md).

delete this rollout record once the active local compositions are accounted for
and any required dedicated enrollment is complete.
