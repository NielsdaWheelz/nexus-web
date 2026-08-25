# Codex Personal Generation Host Operations

This runbook owns the credential-safe deployment boundary for
`nexus-codex-agent-host`. The host serves the private v2 generation protocol on
`/run/nexus-codex/agent.sock`; it has no TCP listener, Nexus application
configuration, database credential, generation API key, application data mount,
or host-home mount.

## Runtime boundary

- The immutable worker image contains the pinned Codex SDK/runtime and the
  repository-owned bwrap/seccomp launcher. API and migration images do not.
- The host runs as `10001:10001`, read-only, capability-free, with
  `no-new-privileges`, the named AppArmor profile, a 384 MiB cgroup, and one
  exact encrypted `auth.json` bind mounted writable. Each turn creates a
  private runtime-state directory beside its empty cwd in the bounded `/tmp`
  tmpfs and links only the profile's `auth.json` to that exact bind. Pinned
  Codex OAuth refresh writes are immediately durable; session, cache, launcher,
  and every sibling write remain disposable. Both per-turn directories and
  their enclosing random root are removed after close.
- The host and `codex-egress-policy` are the only members of the internal
  `nexus_codex_private` network. The host has no public-network attachment;
  the policy sidecar is the sole member of `nexus_codex_proxy_egress` and the
  host's only network peer. It exposes private DNS plus a TLS-SNI tunnel for
  ChatGPT, `auth.openai.com`, and the exact production MCP hostname. TLS stays
  end-to-end; the sidecar receives no plaintext, grant, or credential. Neither
  container can reach PostgreSQL, API, Caddy, or either worker directly.
  Because the HTTP request is encrypted, the sidecar owns hostname/SNI
  confinement only. The host's exact `NEXUS_CODEX_MCP_ORIGIN`, release
  attestation, and Caddy's exact MCP mount jointly own the required
  `/internal/agent-tools/mcp` path.
- The API and both worker lanes mount
  `nexus_codex_run:/run/nexus-codex:ro`; this gives the request-scoped dossier
  resolver the same private client capability without any credential mount.
  Only the interactive worker serves MCP, on `0.0.0.0:8001` inside Compose.
  Caddy routes exactly `/internal/agent-tools/mcp` there and leaves every other
  route unchanged.
- Docker Engine 28 or newer is required. Release admission checks the server
  version before mutation because `gateway_mode_ipv4=isolated` is part of the
  private bridge's security contract.
- The host receives exactly the public HTTPS MCP origin and
  `NEXUS_CODEX_CHAT_NETWORK_ATTESTED=true` from Compose. The origin must use a
  lowercase public DNS hostname and the exact path, with no userinfo, query, or
  fragment.
- Never set `CODEX_HOME`, `OPENAI_API_KEY`, or another generation API key on the
  running host. The host receives only
  `NEXUS_CODEX_CREDENTIAL_FILE=/run/nexus-codex-credential/auth.json`;
  `CODEX_HOME` is legal only for the one enrollment command.

## MCP wire pin

Production ChatTools interoperation is one fixed contract:

- client: `openai-codex==0.144.4` and
  `openai-codex-cli-bin==0.144.4`;
- server: official `mcp==2.1.0`, configured with `stateless_http=True` and
  `json_response=True`;
- wire revision: MCP `2025-06-18` only;
- endpoint: HTTPS POST to exactly `/internal/agent-tools/mcp`.

Every request carries the ephemeral
`Authorization: Bearer <generation grant>`, `Content-Type: application/json`,
and `Accept: application/json, text/event-stream`. The initialize body declares
`protocolVersion: 2025-06-18`; Codex omits `MCP-Protocol-Version` on that first
request, and the mount accepts only an omitted or identical header there.
Every subsequent POST requires `MCP-Protocol-Version: 2025-06-18`. Any other
revision, a missing later header, or any client `Mcp-Session-Id` is a protocol
rejection.

Despite the `Accept` advertisement, Nexus returns JSON for requests and a
bodyless acknowledgement for notifications. It returns no session id and
configures no GET/SSE stream, DELETE-session lifecycle, event store, resume,
OAuth, protocol downgrade, or dual/fallback server. Do not “upgrade” the wire
revision independently of the pinned Codex client and its service proof.

## Encrypted credential state

The deployed host uses a fixed 1 GiB LUKS2 container, root-owned, at
`/var/lib/nexus/codex-state.luks`, opened as
`/dev/mapper/nexus-codex-state` and mounted `rw,nosuid,nodev,noexec` at
`/srv/nexus/codex-state`. Compose directly binds that mount; there is no
Docker-managed credential-state volume or plaintext fallback. Enrollment is
the only creator. Pinned Codex `0.144.4` is the only runtime writer and updates
the refresh token in that exact file. The long-lived host binds exactly
`/srv/nexus/codex-state/codex/codex-personal/auth.json` to
`/run/nexus-codex-credential/auth.json` read-write; it never mounts the
writable parent directory.

This exception is version-qualified, not a general profile mount. Rust
`v0.144.4` `FileAuthStorage::save` opens `$CODEX_HOME/auth.json` with
truncate/write/create and then performs `write_all` plus `flush`, so the
per-turn absolute link updates the mounted file in place. Any SDK/runtime
upgrade that renames/replaces the file, changes its location or credential
store, or changes refresh persistence requires a credential-boundary redesign
and new release proof first. Upstream does not use atomic replacement or
`fsync`; after runtime close, Nexus re-proves the original inode/mode/size and
`fsync`s that exact descriptor before returning the terminal or releasing a
disconnected turn's slot. A crash during upstream truncate/write can still
leave a partial artifact. Nexus deliberately adds no after-turn copy-back
window because losing a rotated refresh token is worse than failing closed on
the official write.

The unlock secret stays off-host. There must be no key file and no automatic
`/etc/crypttab` entry. Unlock is interactive after every reboot. The release
controller installs a boot guard that orders Docker after the missing-mount
underlay has been made root-owned mode `000`. It deliberately does not block
the rest of Nexus from starting while Codex is locked; `restart: "no"` keeps
the credential host stopped until the release controller admits it.

The release-owned PostgreSQL backup neither mounts nor reads the Codex state filesystem.
Automated admission proves only the repository-owned secret locations:
`/var/lib/nexus/codex-state.luks`, `/dev/mapper/nexus-codex-state`, and
`/srv/nexus/codex-state`. It also proves that `/var/lib/nexus/codex-state.key`
and an automatic crypttab entry are absent. It never inventories profile files.

On a new host, Docker must remain stopped until the mapping is unlocked and
the initial container has been provisioned:

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
  --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges:true \
  --mount source=nexus_nexus_codex_run,target=/run/nexus-codex \
  alpine:3.22 \
  install -d -o 10001 -g 10001 -m 0770 /run/nexus-codex
```

## Enrollment

Enrollment is the only interactive Codex login. The CLI writes its complete
profile into tmpfs; the enrollment owner then atomically installs only the
bounded mode-`0600` `auth.json` into the encrypted mount and refuses to replace
an existing target. Use a temporary, single-member egress network:

```sh
readonly WORKER_IMAGE='ghcr.io/nielsdawheelz/nexus-worker@sha256:<candidate digest>'
readonly ENROLLMENT_NETWORK="nexus-codex-enrollment-$$"
cleanup_codex_enrollment_network() {
  docker network rm "$ENROLLMENT_NETWORK" >/dev/null 2>&1 || true
}
trap cleanup_codex_enrollment_network EXIT HUP INT TERM
docker network create --driver bridge \
  --opt com.docker.network.bridge.enable_icc=false \
  "$ENROLLMENT_NETWORK" >/dev/null
docker run --rm --interactive --tty --user 10001:10001 --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 384m --memory-swap 384m --pids-limit 64 --cpus 1.0 \
  --network "$ENROLLMENT_NETWORK" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=10001,gid=10001 \
  --mount type=bind,source=/srv/nexus/codex-state,target=/var/lib/nexus-codex \
  --env CODEX_HOME=/tmp/nexus-codex-enrollment \
  --env NEXUS_CODEX_ENROLLMENT_AUTH_FILE=/var/lib/nexus-codex/codex/codex-personal/auth.json \
  "$WORKER_IMAGE" python -m apps.codex_agent.enroll
```

Never copy a local profile or `auth.json`. Verify only ownership/mode and the
real sandbox; do not print credential files:

```sh
sudo stat -c '%u:%g:%a %n' \
  /srv/nexus/codex-state \
  /srv/nexus/codex-state/codex/codex-personal \
  /srv/nexus/codex-state/codex/codex-personal/auth.json
```

## One-time Caddy route activation

Before the first Codex cutover, load the candidate Caddyfile without replacing
the bind-mounted file's inode. Caddy keeps its prior in-memory config if this
procedure is interrupted; release admission then fails before writer mutation.

```sh
readonly SOURCE_SHA='<installed candidate source SHA>'
readonly CANDIDATE_ROOT="/opt/nexus/releases/${SOURCE_SHA}"
sudo env PYTHONDONTWRITEBYTECODE=1 \
  PYTHONPATH="${CANDIDATE_ROOT}/python" \
  python3 -B "${CANDIDATE_ROOT}/release.py" \
  activate-caddy-config --source-sha "${SOURCE_SHA}"
```

The controller supplies the candidate's pinned Compose inputs, validates both
old and new configurations, preserves and rechecks the live bind inode and
container identity, reloads in place, proves the admin API loaded the exact
adapted candidate, and rolls back in place on failure. Do not use `install`,
`mv`, direct Compose, or container recreation for this update. Release admission
repeats the loaded-config proof before it stops writers. Activation proves the
currently published release before and after the reload; the later release apply
proves that the new public TLS MCP route returns the exact bodyless unauthenticated
401 before the backend phase can advance.

## Release and reboot resume

Normal release admission installs and parses the exact AppArmor profile before
writers stop. It verifies the LUKS mapping/mount, boot guard, enrolled-file
metadata, exact writable file bind,
container environment, UDS volume, two-network egress topology, fixed private
addresses and DNS, sidecar isolation, inner sandbox, and exact v2 health
identity.

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
mapping, changed mount option, unexpected environment/mount/network peer,
sidecar-policy mismatch, or health mismatch refuses before the host is
admitted.

## Locked-reboot acceptance

The accepted reboot state is: mapping absent, `/srv/nexus/codex-state`
root-owned mode `000`, boot guard enabled, the rest of Nexus allowed to run,
and the Codex host stopped. `resume-codex-agent-host` is the only supported way
to start it again. Demonstrate that it refuses before unlock; then unlock,
mount, use the controller resume command, and prove the exact host isolation
again. Store only the bounded receipt and system-service status; never archive
credential paths or SDK frames.

### Disposable-VM locked-reboot acceptance (live evidence pending)

CI fakes do not satisfy this live acceptance procedure. On a disposable host,
reboot with the mapping locked, then record only these bounded facts:

```sh
sudo systemctl show docker.service --property=After --property=Requires
sudo stat -c '%u:%g:%a %n' /srv/nexus/codex-state
sudo docker compose --project-name nexus ps --all nexus-codex-agent-host
```

Prove the application services can start, the Codex host cannot be admitted,
and the protected underlay remains empty and inaccessible. Then unlock, mount,
run the controller resume command, and prove exact isolation again.

## Existing-VPS capacity qualification

Before the first hard-cut promotion, and whenever the prior passing evidence is
older than 72 hours, run from a clean checkout at the exact candidate SHA:

```sh
./deploy/hetzner/prove-codex-capacity.sh "$(git rev-parse HEAD)"
```

The v3 canary sends one cold and two warm `dossier_library` turns through the
real UDS host at the `thorough` plan (`Terra/high`, `Synthesis`, no tools). This
is the bounded release-capacity sample; the four-plan nightly owns Deep/Sol and
MCP coverage. The enclosing immutable qualification remains
`nexus-codex-capacity.v2`. It records only phase, operation/plan/policy/
capability identity, terminal class, usage presence, SDK/runtime versions, and
tool/permission event counts. It records no prompt, model output, grant,
session identifier, account identifier, or credential fact.

The release controller measures the 384 MiB host cgroup, host headroom,
pressure, swap, OOM counters, and unchanged long-lived service health. Passing
root-owned `0444` evidence is written under
`/var/lib/nexus/releases/codex-capacity/<source-sha>.json`. The run refuses
when the encrypted credential state has less than 128 MiB free. A pre-accept
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
read-only MCP call. The `nexus-hosted-codex-canary.v3` receipt binds the source
SHA and exact policy/runtime pins, declares the narrow
`model_effort_runtime_wire` scope and four exact qualified plan ids, then
records only plan id, model, effort, structured-output validity, usage,
SDK/runtime versions, tool/permission counts, and bounded elapsed time per
case. It is not evidence that four representative turns evaluated every
domain operation. Synthesis has zero tool events; the MCP result has a bounded
non-zero count; permission requests are always zero.

The nightly runner has a distinct encrypted Codex profile, no database, no
Docker authority, and no Nexus process. Its MCP peer is the same
`mcp==2.1.0` stateless JSON server on wire revision `2025-06-18`, served locally
with TLS and one static read-only tool. A missing credential, runner, state
root, or policy pin is `not_run`, never skipped green.

## Operation smoke boundary

Do not create production fixtures or a synthetic account to replay every
operation. Nexus has no account-deletion lifecycle, and Dawn is intentionally a
population sweep. The closed static catalog owns operation composition and
policy; representative real-owner service proofs own publication and replay;
the four-plan nightly owns the unique model/effort, JSON, and MCP boundary; the
capacity proof owns the shipped host envelope.

After deployment, exercise desired operations through their ordinary product
entrypoints. Use the generation ledger only as passive evidence that the
deployed policy and route were used; never edit it or fabricate missing
coverage. Missing naturally exercised operations are simply not observed, not
green.

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

Online operator rotation and dual-profile cutover are intentionally not
implemented. Normal runtime token refresh mutates only the exact enrolled
artifact in place. If startup reports a rejected, empty, partial, expired, or
revoked artifact, keep the host stopped and treat generation as unavailable.
Without reading or copying it, atomically rename `auth.json` to a unique
`auth.json.retired-<UTC timestamp>` inside the still-encrypted profile, run the
same one-shot enrollment command to create a new `auth.json`, and resume only
through `resume-codex-agent-host`. Retain the retired artifact encrypted until
the new host passes release admission, then unlink it. Never edit, print,
restore, or copy credential contents, and never re-enroll while the host runs.

Application rollback is permitted only before database mutation starts. After
the 0222 migration begins, recovery is forward-fix only. The dedicated encrypted
state remains untouched in either case. Do not bypass health, policy, sandbox,
environment, MCP-origin, or capacity checks.

## Incident boundaries

- Quota/auth/runtime/sandbox failure is terminal for that generation; never add
  API-based generation fallback or automatic re-enrollment. Startup performs
  only the required authentication-status probe; the pinned client may refresh
  the exact durable artifact during that probe.
- A pre-accept capacity refusal is known. A post-accept disconnect is uncertain
  and never capacity or redispatch authority.
- Grant values, `auth.json`, raw SDK frames, model output, prompts, and device
  codes are never diagnostic or certification artifacts.
- The host is not a public generation endpoint. Never expose the UDS through
  TCP, a reverse proxy, WebSocket/App Server, or arbitrary container exec.
- MCP is the only public tool route and is bearer-, lease-, run-, generation-,
  declaration-, and resource-scoped on every call.
