# Codex Personal Generation Host Operations

This runbook owns the credential-safe deployment boundary for
`nexus-codex-agent-host`. The host serves the private v2 generation protocol on
`/run/nexus-codex/agent.sock`; it has no TCP listener, Nexus application
configuration, database credential, provider API key, application data mount,
or host-home mount.

## Runtime boundary

- The immutable worker image contains the pinned Codex SDK/runtime and the
  repository-owned bwrap/seccomp launcher. API and migration images do not.
- The host runs as `10001:10001`, read-only, capability-free, with
  `no-new-privileges`, the named AppArmor profile, a 384 MiB cgroup, and one
  writable per-turn state root under the encrypted mount.
- The host is the sole member of `nexus_codex_egress`. It reaches ChatGPT and
  the production MCP origin as ordinary public TLS egress. It gains no Docker
  network peer for PostgreSQL, API, Caddy, or either worker.
- Both worker lanes mount `nexus_codex_run:/run/nexus-codex:ro`. Only the
  interactive worker serves MCP, on `0.0.0.0:8001` inside Compose. Caddy routes
  exactly `/internal/agent-tools/mcp` there and leaves every other route
  unchanged.
- The host receives exactly the public HTTPS MCP origin and
  `NEXUS_CODEX_CHAT_NETWORK_ATTESTED=true` from Compose. The origin must use a
  lowercase public DNS hostname and the exact path, with no userinfo, query, or
  fragment.
- Never set `CODEX_HOME`, `OPENAI_API_KEY`, or another provider key on the
  running host. `CODEX_HOME` is legal only for the one enrollment command.

## Encrypted credential state

The deployed host uses a fixed, root-owned 1 GiB LUKS2 container at
`/var/lib/nexus/codex-state.luks`, opened as
`/dev/mapper/nexus-codex-state` and mounted `rw,nosuid,nodev,noexec` at
`/srv/nexus/codex-state`. Compose directly binds that mount; there is no
Docker-managed credential-state volume or plaintext fallback.

The unlock secret stays off-host. There must be no key file and no automatic
`/etc/crypttab` entry. Unlock is interactive after every reboot. The release
controller installs a boot guard that blocks Docker until the mapping is
present, so the protected underlay is never used accidentally.

On a new host, keep Docker stopped and provision the container:

```sh
sudo apt-get update
sudo apt-get install --yes --no-install-recommends cryptsetup apparmor apparmor-utils
sudo install -d -o root -g root -m 000 /srv/nexus/codex-state
sudo fallocate --length 1G /var/lib/nexus/codex-state.luks
sudo chown root:root /var/lib/nexus/codex-state.luks
sudo chmod 0600 /var/lib/nexus/codex-state.luks
sudo cryptsetup luksFormat --type luks2 /var/lib/nexus/codex-state.luks
sudo cryptsetup open /var/lib/nexus/codex-state.luks nexus-codex-state
sudo mkfs.ext4 /dev/mapper/nexus-codex-state
sudo mount -o rw,nosuid,nodev,noexec \
  /dev/mapper/nexus-codex-state /srv/nexus/codex-state
sudo chown 10001:10001 /srv/nexus/codex-state
sudo chmod 0700 /srv/nexus/codex-state
sudo cryptsetup isLuks --type luks2 /var/lib/nexus/codex-state.luks
findmnt --mountpoint /srv/nexus/codex-state \
  --output SOURCE,FSTYPE,OPTIONS --noheadings
```

Keep the host-wide unprivileged-user-namespace restriction enabled:

```sh
printf '%s\n' 'kernel.apparmor_restrict_unprivileged_userns=1' \
  | sudo tee /etc/sysctl.d/60-nexus-codex-userns.conf >/dev/null
sudo chmod 0644 /etc/sysctl.d/60-nexus-codex-userns.conf
sudo chown root:root /etc/sysctl.d/60-nexus-codex-userns.conf
sudo sysctl --system
test "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1
```

Install the release-owned boot guard from the exact candidate, then create the
shared run volume and its non-root socket directory:

```sh
readonly SOURCE_SHA='<installed candidate source SHA>'
sudo env PYTHONDONTWRITEBYTECODE=1 \
  PYTHONPATH="/opt/nexus/releases/${SOURCE_SHA}/python" \
  python3 -B "/opt/nexus/releases/${SOURCE_SHA}/release.py" \
  install-codex-state-boot-guard --source-sha "$SOURCE_SHA"

docker volume create --name nexus_nexus_codex_run
docker run --rm --network none --user 0:0 --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --mount source=nexus_nexus_codex_run,target=/run/nexus-codex \
  alpine:3.22 \
  install -d -o 10001 -g 10001 -m 0770 /run/nexus-codex
```

## Enrollment

Enrollment is the only interactive Codex login. Use a temporary, single-member
egress network and mount only the encrypted state path:

```sh
readonly WORKER_IMAGE='ghcr.io/nielsdawheelz/nexus-worker@sha256:<candidate digest>'
readonly ENROLLMENT_NETWORK="nexus-codex-enrollment-$$"
cleanup_codex_enrollment_network() {
  docker network rm "$ENROLLMENT_NETWORK" >/dev/null 2>&1 || true
}
trap cleanup_codex_enrollment_network EXIT HUP INT TERM
docker network create "$ENROLLMENT_NETWORK" >/dev/null
docker run --rm --interactive --tty --user 10001:10001 --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --network "$ENROLLMENT_NETWORK" \
  --mount type=bind,source=/srv/nexus/codex-state,target=/var/lib/nexus-codex \
  --env CODEX_HOME=/var/lib/nexus-codex/codex/codex-personal \
  "$WORKER_IMAGE" python -m apps.codex_agent.enroll
```

Never copy a local profile or `auth.json`. Verify only ownership/mode and the
real sandbox; do not print credential files:

```sh
stat -c '%u:%g:%a %n' \
  /srv/nexus/codex-state \
  /srv/nexus/codex-state/codex/codex-personal \
  /srv/nexus/codex-state/codex/codex-personal/auth.json
```

## Release and reboot resume

Normal release admission installs and parses the exact AppArmor profile before
writers stop. It verifies the LUKS mapping/mount, boot guard, direct bind,
container environment, UDS volume, single-member egress network, inner
sandbox, and exact v2 health identity.

After reboot, unlock and mount the credential state interactively, then use the
controller. Do not invoke Compose directly:

```sh
sudo cryptsetup open /var/lib/nexus/codex-state.luks nexus-codex-state
sudo mount -o rw,nosuid,nodev,noexec \
  /dev/mapper/nexus-codex-state /srv/nexus/codex-state
readonly SOURCE_SHA="$(sudo cat /var/lib/nexus/releases/current)"
sudo env PYTHONDONTWRITEBYTECODE=1 \
  PYTHONPATH="/opt/nexus/releases/${SOURCE_SHA}/python" \
  python3 -B "/opt/nexus/releases/${SOURCE_SHA}/release.py" \
  resume-codex-agent-host --source-sha "$SOURCE_SHA"
```

Success emits one bounded `nexus-codex-agent-host-resume.v1` receipt. A missing
mapping, changed mount option, unexpected environment/mount/network peer, or
health mismatch refuses before the host is admitted.

## Locked-reboot acceptance

The accepted reboot state is: mapping absent, `/srv/nexus/codex-state`
root-owned mode `000`, boot guard enabled, Docker blocked, and Codex host
stopped. Demonstrate that `resume-codex-agent-host` refuses before unlock; then
unlock, mount, start Docker, use the controller resume command, and prove the
exact host isolation again. Store only the bounded receipt and system-service
status; never archive credential paths or SDK frames.

## Existing-VPS capacity qualification

Before the first hard-cut promotion, and whenever the prior passing evidence is
older than 72 hours, run from a clean checkout at the exact candidate SHA:

```sh
./deploy/hetzner/prove-codex-capacity.sh "$(git rev-parse HEAD)"
```

The v2 canary sends one cold and two warm Deep/ChatTools-shaped turns through
the real UDS host. It records only phase, exact operation/profile/plan/policy
identity, terminal class, usage presence, SDK/runtime versions, and tool/
permission event counts. It records no prompt, model output, grant, session
identifier, account identifier, or credential fact.

The release controller measures the 384 MiB host cgroup, host headroom,
pressure, swap, OOM counters, and unchanged long-lived service health. Passing
root-owned `0444` evidence is written under
`/var/lib/nexus/releases/codex-capacity/<source-sha>.json`. A pre-accept
capacity refusal is `not_run`; authentication/quota refusal is
`subscription_blocked`; a pre-accept loss or accepted transport loss is
`transport_retriable`. Those outcomes write no qualifying evidence. A measured
resource or exact-contract breach writes immutable failed evidence.

An interrupted run may reclaim only its own labeled canary. A foreign
same-named container is never name-only deletion authority. Do not stop other
services, clear caches, add swap, raise the host limit, or lower reserves to
manufacture a pass.

## Four-plan nightly

The protected `codex-nightly` lane performs exactly four subscription turns,
one per unique plan pair. Together they cover text, strict JSON, and one
read-only MCP call. The `nexus-hosted-codex-canary.v2` receipt contains only
plan id, model, effort, structured-output validity, usage, SDK/runtime versions,
tool/permission counts, and bounded elapsed time. Synthesis has zero tool
events; the MCP result has a bounded non-zero count; permission requests are
always zero.

The nightly runner has a distinct encrypted Codex profile, no database, no
Docker authority, and no Nexus process. Its MCP peer is the pinned official SDK
served locally with TLS and one static read-only tool. A missing credential,
runner, state root, or policy pin is `not_run`, never skipped green.

## Operator operation certification

After deployment, run the certification command against the dedicated
synthetic user. It requires one machine-produced observation per canonical
synthesis operation and one Balanced ChatTools write/undo receipt; it does not
run an operation-by-plan matrix. The command validates exact terminal,
plan/policy, usage, SDK/runtime, timing, write/undo, teardown, and closed-field
contracts before writing bounded redacted evidence.

The observation producer is the E/D integration seam: it must dispatch through
the real worker/domain owners and perform normal synthetic-user teardown. The
certifier contains no direct-provider or fixture-mode fallback and refuses a
partial or hand-shaped contract. Until that producer is landed, the strict
schema/validator is available but operator certification remains `not_run`.

Once the integration runner produces its root-owned observation file, seal it
from the clean checkout for the deployed SHA:

```sh
readonly SOURCE_SHA="$(git rev-parse HEAD)"
readonly EVIDENCE_DIR=/var/lib/nexus/releases/codex-operation-certification
sudo install -d -o root -g root -m 0755 "$EVIDENCE_DIR"
sudo env PYTHONPATH="$PWD/python" \
  "$PWD/python/.venv/bin/python" \
  deploy/hetzner/codex-operation-certification.py \
  --observations /run/nexus-certification/observations.json \
  --evidence "$EVIDENCE_DIR/${SOURCE_SHA}.json"
```

The observation path in that example is integration-runner output, not a file
the operator authors. Evidence is create-only, root-owned `0444`, bounded to
64 KiB, and contains neither prompts, output, grants, credentials, sessions,
diagnostics, nor raw frames.

## Worker coupling

Compose start-orders both `worker-interactive` and `worker-background` after
`nexus-codex-agent-host` with `condition: service_started`, never
`service_healthy`. The order ensures the socket volume exists before a
generation job can be claimed. Host readiness must not stop unrelated ingest,
podcast, reindex, teardown, or interactive work.

An unhealthy host affects generation only. Pre-accept capacity follows each
operation's bounded wait schedule; other known pre-accept unavailability is a
typed terminal or retry according to the durable owner. An accepted loss stays
`Uncertain` and is never automatically redispatched.

Inspect an incident without losing exited-container evidence:

```sh
docker compose --project-name nexus ps --all nexus-codex-agent-host
docker compose --project-name nexus logs --tail 50 nexus-codex-agent-host
```

## Re-enrollment and rollback

If authentication expires or is revoked, stop only the host, preserve the old
encrypted state until the replacement enrollment passes, enroll a fresh
dedicated state path, deploy its explicit bind change, and retire the prior
encrypted container through the approved destruction procedure. Never repair
or transfer `auth.json`.

Application rollback restores the prior immutable API/worker image and leaves
the dedicated encrypted state untouched. Do not bypass health, policy,
sandbox, environment, MCP-origin, or capacity checks.

## Incident boundaries

- Quota/auth/runtime/sandbox failure is terminal for that generation; never add
  an API-key fallback or automatic account probing.
- A pre-accept capacity refusal is known. A post-accept disconnect is uncertain
  and never capacity or redispatch authority.
- Grant values, `auth.json`, raw SDK frames, model output, prompts, and device
  codes are never diagnostic or certification artifacts.
- The host is not a public generation endpoint. Never expose the UDS through
  TCP, a reverse proxy, WebSocket/App Server, or arbitrary container exec.
- MCP is the only public tool route and is bearer-, lease-, run-, generation-,
  declaration-, and resource-scoped on every call.
