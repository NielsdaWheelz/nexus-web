# Codex Personal Agent Host Operations

This runbook owns the credential-safe deployment boundary for the private
`nexus-codex-agent-host`. It serves only Nexus metadata enrichment through the
private Unix socket `/run/nexus-codex/agent.sock`; it has no TCP listener,
Nexus application configuration, database credentials, provider API keys, data
mounts, or host-home mount.

## Prerequisites

- The candidate worker image is the immutable digest released by CI. It contains
  the pinned `codex-agent` dependency extra and bundled Codex sandbox runtime;
  the API and migration images do not.
- The deployed host has an encrypted Docker volume for
  `nexus_codex_state`. Normal backups exclude the volume's `auth.json`; account
  re-enrollment is the recovery procedure.
- Ubuntu AppArmor is installed and its host-wide unprivileged-user-namespace
  restriction stays enabled. The immutable release installs and loads the
  repository-owned `nexus-codex-agent-host` profile. Compose relaxes only the
  outer container's namespace guards so the non-root, capability-free host can
  construct Codex's stricter bwrap+seccomp child sandbox; the release blocks
  unless that real inner sandbox succeeds.
- The host is attached only to the dedicated `nexus_codex_egress` bridge. It
  can reach ChatGPT but cannot address PostgreSQL or an application service;
  the background worker reaches it only through the read-only UDS volume.
- Do not copy an existing Codex state directory or use the operator's local
  Codex profile. Do not add `OPENAI_API_KEY` or any provider key to this host.
- The existing production VPS reports at least 1,900 MiB total memory, at least
  1 GiB swap, cgroup v2 memory control, and zero full memory pressure. Do not
  resize it or reduce existing application-service limits for this cutover.

## First enrollment

Enroll before the first release that starts the hard-cut host.

On an existing Ubuntu 24.04 VM, persist the same host-wide restriction that
cloud-init provisions on a fresh VM, then verify it before enrollment:

```sh
printf '%s\n' 'kernel.apparmor_restrict_unprivileged_userns=1' \
  | sudo tee /etc/sysctl.d/60-nexus-codex-userns.conf >/dev/null
sudo chmod 0644 /etc/sysctl.d/60-nexus-codex-userns.conf
sudo chown root:root /etc/sysctl.d/60-nexus-codex-userns.conf
sudo sysctl --system
test "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1
```

1. On the VM, obtain the exact `WORKER_IMAGE` digest from the candidate's
   immutable `candidate-manifest.json`. Do not use a tag.

   ```sh
   readonly WORKER_IMAGE='ghcr.io/nielsdawheelz/nexus-worker@sha256:<candidate digest>'
   docker volume create --name nexus_nexus_codex_state
   docker volume create --name nexus_nexus_codex_run
   docker run --rm --user 0:0 --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
     --mount source=nexus_nexus_codex_state,target=/var/lib/nexus-codex \
     --mount source=nexus_nexus_codex_run,target=/run/nexus-codex \
     --entrypoint sh "$WORKER_IMAGE" -c \
     'install -d -o 10001 -g 10001 -m 0700 /var/lib/nexus-codex && install -d -o 10001 -g 10001 -m 0770 /run/nexus-codex'
   ```

2. Start the official interactive device login as uid `10001`, mounting only
   the dedicated state volume. Profile isolation comes only from `CODEX_HOME`.

   ```sh
   docker run --rm --interactive --tty --user 10001:10001 --read-only \
     --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
     --mount source=nexus_nexus_codex_state,target=/var/lib/nexus-codex \
     --env CODEX_HOME=/var/lib/nexus-codex/codex/codex-personal \
     "$WORKER_IMAGE" python -m apps.codex_agent.enroll
   ```

   Complete the browser/device handoff yourself. Never paste login output into
   a terminal recording, ticket, chat, Git file, or environment file.
   The command passes no `OPENAI_API_KEY`; the enrollment wrapper rejects one
   if it is introduced.

3. Verify metadata only; these commands never read credential contents.

   ```sh
   docker run --rm --user 0:0 --read-only \
     --mount source=nexus_nexus_codex_state,target=/var/lib/nexus-codex \
     --entrypoint sh "$WORKER_IMAGE" -c \
     'stat -c "%u:%g:%a %n" /var/lib/nexus-codex /var/lib/nexus-codex/codex/codex-personal /var/lib/nexus-codex/codex/codex-personal/auth.json'
   ```

   The state root and profile directory must be `10001:10001:700`; `auth.json`
   must be `10001:10001:600`. Do **not** display, copy, hash, or otherwise
   inspect credential-file contents.

4. Complete **Existing-VPS capacity qualification** below, then run the ordinary
   immutable release. Release and qualification never mount the credential
   state from a second container: the non-root host validates the provisioned
   ownership and modes before readiness. Readiness independently requires
   ChatGPT SDK/runtime authentication and the bundled Codex sandbox wrapper.
   Before a writer stops, the controller parses the AppArmor profile carried in
   the immutable bundle and verifies the global restriction. Before host
   activation, it atomically installs and loads that exact profile. Any failed
   check blocks promotion.

   Verify only the named host policy and global restriction; do not disable
   AppArmor or the system-wide user-namespace control:

   ```sh
   sudo apparmor_status | grep -Fx '   nexus-codex-agent-host'
   test "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1
   ```

## Existing-VPS capacity qualification

This is a mandatory one-time gate before the first 0216 promotion. Use only the
repository-owned command below. Do not approximate it with `docker stats`, an
unbounded host process, a copied local Codex profile, or a direct CLI prompt.

The command must bind the exact candidate source SHA and immutable worker digest,
mount only the dedicated state and run volumes, start the normal host under its
384 MiB memory cgroup with cgroup swap disabled, and send one cold plus two warm synthetic metadata
commands through the private UDS. It samples host capacity and cgroup counters
without reading application data. It validates every capacity and health
threshold in the
[cutover spec](../cutovers/codex-personal-metadata-hard-cutover.md#existing-vps-capacity-contract);
the operator does not interpret raw metrics.
Do not stop an application service, clear caches, or add swap to manufacture
headroom before running it.

From a clean checkout at the exact candidate SHA, after its immutable artifacts
exist, run:

```sh
./deploy/hetzner/prove-codex-capacity.sh "$(git rev-parse HEAD)"
```

Evidence contains no prompt, output, raw frame, account identifier, device code,
or credential fact. The immutable release controller stores root-owned `0444`
evidence at `/var/lib/nexus/releases/codex-capacity/<source-sha>.json`; do not
open or edit it manually. `not_run` from pre-admission headroom and
`provider_blocked` from auth/quota write no qualifying evidence; repeat the
unchanged SHA only after natural pressure recovery or documented
re-enrollment/quota recovery. Resource, service-health, policy, protocol, or
structured-output failure blocks the cutover. Do not raise the Codex limit,
lower the reserve, reduce an existing service limit, manipulate production
memory, or rerun to replace failed evidence. Remediation requires a separately
specified memory reduction or resize.

After qualification, routine turn admission remains automatic. The host reads
its cgroup and host memory pressure before HTTP acceptance. Capacity refusal
keeps metadata queued on the bounded schedule; it is not an incident unless the
wait exhausts or other service health/pressure evidence is abnormal.

## Hosted subscription canary preparation

The protected self-hosted runner has the dedicated `nexus-codex-nightly` label
and uses a separate pre-enrolled state base. It does not mount or inspect the
production volume. As the runner account, create
the persistent state base and empty cwd once. From a Nexus checkout, install
the locked environment and enroll the same fixed `codex-personal` profile
interactively. Do not set `OPENAI_API_KEY` or copy `auth.json`.

```sh
install -d -m 0700 /var/lib/nexus-codex-nightly/state
install -d -m 0700 /var/lib/nexus-codex-nightly/cwd
uv sync --all-extras --locked --directory python
env -u OPENAI_API_KEY \
  CODEX_HOME=/var/lib/nexus-codex-nightly/state/codex/codex-personal \
  ./python/.venv/bin/python -m apps.codex_agent.enroll
env -u OPENAI_API_KEY \
  ./python/.venv/bin/python -m apps.codex_agent.sandbox_health
stat -c '%u:%a %n' /var/lib/nexus-codex-nightly/state /var/lib/nexus-codex-nightly/cwd
```

The output must show the runner uid and mode `700` for both directories; do not
list or read profile files. The sandbox command must exit successfully; any
output is a defect. The workflow repeats that real sandbox probe, verifies the
empty cwd, clears the run-bound evidence path before its one turn, and accepts
evidence only when its run id matches. Re-enroll this distinct canary state with
the same command when its account credential expires.

On that Ubuntu 24.04 runner, install and load the repository-owned path-scoped
profile before running the silent sandbox check. The workflow compares the
installed bytes, owner/mode, loaded profile, OS version, and global restriction
on every run:

```sh
sudo install -o root -g root -m 0644 \
  deploy/hetzner/nexus-codex-nightly-bwrap.apparmor \
  /etc/apparmor.d/nexus-codex-nightly-bwrap
sudo apparmor_parser -Q /etc/apparmor.d/nexus-codex-nightly-bwrap
sudo apparmor_parser -r /etc/apparmor.d/nexus-codex-nightly-bwrap
```

Make this installation part of the runner's persistent host provisioning so it
survives reboot. Do not substitute `--sandbox danger-full-access`, a setuid
bwrap binary, or a global sysctl relaxation.

## Re-enrollment

When Codex authentication expires or is revoked, stop only
`nexus-codex-agent-host`. Preserve the old encrypted state volume until the
replacement enrollment has passed readiness. Create a fresh dedicated state
volume, repeat **First enrollment**, switch the Compose volume reference during
an authorized deployment, verify the release gate, then retire the old volume
through the VM's approved encrypted-volume destruction procedure. Do not repair
or transfer `auth.json` between profiles or machines.

## Rollback

Application rollback restores the prior immutable API/worker image and leaves
the dedicated Codex state volume untouched. If the candidate host fails
readiness, the release controller blocks promotion; do not bypass its health or
sandbox checks. If a previously working host must be restored, roll back to its
known-good immutable release record and retain the current state volume. Only
an explicit account-compromise response authorizes state-volume replacement.

## Incident boundaries

- A quota/auth/runtime/sandbox failure is terminal for that metadata turn; do
  not add provider/API fallback or automatic account probing.
- A pre-accept capacity refusal is an expected bounded queue wait. A
  post-accept disconnect is uncertain and must never be treated as capacity or
  redispatched automatically.
- The only operator-visible diagnostics are redacted service status and release
  evidence. Credential values, `auth.json`, raw SDK frames, and enrolled-device
  codes are never diagnostic artifacts.
- The host is not a general Codex endpoint: do not expose its UDS through TCP,
  reverse proxies, App Server/WebSocket ports, or arbitrary container exec.
