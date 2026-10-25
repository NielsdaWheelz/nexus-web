# qualify a coherent codex host upgrade

the caller-owned codex-work2 daemon reports 0.164.0, while nexus requires
0.160.0. the socket responds, but product health rejects it before startup
catalog validation. ordinary-worker acceptance remains open; the owner accepted
that limitation for search qualification on 2026-10-22.

evidence: `python/pyproject.toml:40` pins the host binary. installed
`provider_runtime/agent_runtime/codex_containment.py:16,71` pins and checks the
daemon version, raising `Codex host startup model catalog requires qualified
native version 0.160.0`; lines 85–98 additionally require the pinned catalog's
startup-flag provenance. `codex_sdk.py:653` repeats qualification before opening
a contained session. `python/nexus/services/generation/catalog.py:220` qualifies
before reading models. the observed health failure is retained privately at
`.nexus-local/search-qualification/codex133/native-health.private.log`.

upgrade the provider runtime/sdk, host binary, catalog and containment qualification
together in a separate change. target the current stable release when that change
starts, then freeze its exact version and dependency revisions for qualification.
the observed 0.164.0 daemon is a candidate, not proof of the latest stable release
or compatibility. the old pin is a qualified baseline, not a permanent product
requirement; neither a floating `latest` nor a minimum-version check replaces
qualification. preserve exact version checks, startup provenance,
disabled native tools and the existing host isolation contract. do not restart
the shared daemon or copy account credentials to bypass the mismatch. a separately
owned host also needs the account/filesystem ownership prerequisite recorded in
[local-codex-account-bind-ownership.md](local-codex-account-bind-ownership.md).

resolved when the chosen release is coherently pinned and its actual host passes
product catalog health, containment qualification and a real ordinary-worker
generation with the declared account, socket/cwd sharing and isolation. raising
the version constant alone does not establish compatibility.
