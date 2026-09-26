# Codex Personal Generation Host Operations

This runbook owns the credential-safe deployment boundary for
`nexus-codex-agent-host`. The host serves the private v3 event and health protocol,
including command v3 and the authenticated account model catalog, on
`/run/nexus-codex/agent.sock`; it has no TCP listener, Nexus application
configuration, database credential, generation API key, application data mount,
or host-home mount.

## Runtime boundary

- The immutable worker image contains the pinned `openai-codex-cli-bin==0.157.1`
  executable. The host launches its absolute bundled path directly; Codex owns
  its native sandbox, while the container owns the outer AppArmor/seccomp
  boundary. API and migration images do not launch Codex.
- The host runs as `10001:10001`, read-only, capability-free, with
  `no-new-privileges`, the named AppArmor profile, a 448 MiB cgroup, and one
  exact encrypted `auth.json` bind mounted writable. Each turn creates private
  `state/`, empty `workspace/`, and `tmp/` directories under one random root in
  the bounded, mode-`0700` `/run/nexus-codex-turns` tmpfs and links only the
  profile's `auth.json` to that exact bind. The private tmpfs is executable for
  native sandbox work; general `/tmp` remains a separate `noexec` tmpfs. Host
  startup rejects any other mount shape, then starts a pinned app-server over
  WebSocket/UDS and verifies its `initialize` version during the authenticated
  catalog probe. Each catalog read and generation owns its own foreground
  native process group. After the probe closes the client, stops and awaits
  that group, validates the credential inode, power-syncs any refresh, and
  removes its whole root, the entrypoint `exec`s a fresh Python serving phase.
  Docker readiness uses one bounded
  standard-library HTTP-over-UDS exchange and validates the complete exact
  health identity; it never imports a second FastAPI, Pydantic, Nexus, or
  provider-runtime graph into the measured cgroup. The serving process builds
  frozen MCP publication plans from the same canonical binding metadata as the
  application, but imports no executable Nexus/DB dispatch owner; the MCP
  service remains the sole tool executor. Nexus passes
  the public typed `CodexSandboxControls` contract to every `AgentRuntime` path;
  it sets `TMPDIR` to that turn's `tmp/` and fixes
  Codex workspace-write policy to exclude bare `/tmp` while retaining only
  `TMPDIR`. The native socket may be an alias into the private
  `/tmp/codex-daemon-<uid>` directory; the host proves the target identity and
  removes its owned alias and socket after process-group exit, including a
  forced stop. Pinned Codex OAuth refresh writes reach the enrolled file;
  after process exit the host validates and syncs that inode. Session, cache,
  socket, temporary files, and sibling writes remain disposable. The host
  removes the per-turn root only after teardown is proven.
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
- The egress policy runs behind Docker's init process so `SIGTERM` reaches a
  non-PID-1 Python process and child transports are reaped. Expected peer-reset
  errors during TLS close are absorbed at the transport owner; they never
  escape as unhandled server tasks.
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
  `NEXUS_CODEX_MODEL_TOOL_NETWORK_ATTESTED=true` from Compose. The origin must use a
  lowercase public DNS hostname and the exact path, with no userinfo, query, or
  fragment.
- Never set `CODEX_HOME` or any `*_API_KEY` on the running host. Startup rejects
  even a blank inherited API-key variable. The host receives only
  `NEXUS_CODEX_CREDENTIAL_FILE=/run/nexus-codex-credential/auth.json`;
  `CODEX_HOME` is legal only for the one enrollment command.

## MCP wire pin

Production model-tool interoperation is one fixed contract:

- client: `openai-codex-cli-bin==0.157.1` through the provider-runtime
  WebSocket/UDS app-server adapter;
- server: official `mcp==2.1.0`, configured with `stateless_http=True` and
  `json_response=True`;
- wire revision: MCP `2025-06-18` only;
- endpoint: HTTPS POST to exactly `/internal/agent-tools/mcp`.

Every request carries the ephemeral
`Authorization: Bearer <generation grant>`, `Content-Type: application/json`,
and `Accept: text/event-stream, application/json`. The initialize body declares
`protocolVersion: 2025-06-18`; Codex omits `MCP-Protocol-Version` on that first
request, and the mount accepts only an omitted or identical header there.
Every subsequent POST requires `MCP-Protocol-Version: 2025-06-18`. Any other
revision, a missing later header, or any client `Mcp-Session-Id` is a protocol
rejection.

Each tool-bearing command carries the exact frozen model-tool plan admitted by
the generation owner. The host publishes only that plan through llm-calling's
MCP lowering: canonical dotted ids use a mechanical dot-to-double-underscore
wire alias (for example, `web.search` becomes `web__search`), and observed tool
events must reverse to an admitted canonical id. Unknown aliases fail the turn
as a policy violation. The target keeps Codex built-in tools and native web
search disabled and routes all model tools, for Chat and background operations
alike, through this same bearer-scoped MCP boundary.

For the exact 0.157.1 pin, the provider requests empty environments on new
threads and every turn, and verifies the new-thread echo; this removes native shell and
patch before effects. It disables delegation, native web/apps and sleep,
keeps the code-mode host, excludes core helper namespaces from its isolated
bridge, and approves only the frozen MCP tool names while global approval
remains `never`. The per-generation bearer enters only the native MCP HTTP
headers, never the child environment. Unexpected native tool or user-question
events fail the turn before Nexus publishes them. Bearer-backed turns emit
only the selected, redacted final text after completion: incremental Codex
answer text is unavailable because earlier native items may be superseded.
Local authenticated text and strict-JSON tool turns passed; Linux containment,
the 15 browser-to-worker cells and credential-refresh proof remain release
gates in the linked cutover tickets. Do not infer release readiness from the
catalog capability alone.

Despite the `Accept` advertisement, Nexus returns JSON for requests and a
bodyless acknowledgement for notifications. It returns no session id and
configures no GET/SSE stream, DELETE-session lifecycle, event store, resume,
OAuth, protocol downgrade, or dual/fallback server. Do not “upgrade” the wire
revision independently of the pinned codex client and its runtime contract.

## Encrypted credential state

The deployed host uses a fixed 1 GiB LUKS2 container, root-owned, at
`/var/lib/nexus/codex-state.luks`, opened as
`/dev/mapper/nexus-codex-state` and mounted `rw,nosuid,nodev,noexec` at
`/srv/nexus/codex-state`. Compose directly binds that mount; there is no
Docker-managed credential-state volume or plaintext fallback. Enrollment is
the only creator. Only pinned Codex `0.157.1` may write the enrolled auth file.
The long-lived host binds exactly
`/srv/nexus/codex-state/codex/codex-personal/auth.json` to
`/run/nexus-codex-credential/auth.json` read-write; it never mounts the
writable parent directory.

This exception is version-qualified, not a general profile mount. Rust
`v0.157.1` `FileAuthStorage::save` opens `$CODEX_HOME/auth.json` with
truncate/write/create and then performs `write_all` plus `flush`; a refresh
using that path would update the mounted file in place. Actual native
refresh on this mounted file has not yet been witnessed; the source-derived
write contract remains a release qualification gate. Any native runtime
upgrade that renames/replaces the file, changes its location or credential
store, or changes refresh persistence requires a credential-boundary redesign
and manual verification of the changed boundary first. Upstream does not use atomic replacement or
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
Automated admission proves only that `/dev/mapper/nexus-codex-state` is mounted
`rw,nosuid,nodev,noexec` at `/srv/nexus/codex-state`; it never inventories
profile files. The absent key file and crypttab entry above are provisioning
facts, not release-time declarations, and no release checks them.

For the approved model-history reset, first stop admission and every native
process group. Inventory the generation-owned private roots, socket aliases,
socket targets, and continuation files; remove only those owned artifacts
after process exit. Preserve this credential mount and its enrolled auth file.

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

Every release installs the boot guard from `deploy/hetzner/`
(`codex-state-boot-guard.sh`, `nexus-codex-state-boot-guard.service`, and the
`docker-codex-state-guard.conf` drop-in) and enables the unit, so a release is
all that is needed here. Create the shared run volume and its non-root socket
directory once:

```sh
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
  --memory 448m --memory-swap 448m --pids-limit 64 --cpus 1.0 \
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

## Caddy route activation

The release writes `deploy/hetzner/Caddyfile` into `/etc/nexus/Caddyfile` with
`tee`, so the bind-mounted inode never changes, and it adapts the candidate
bytes through the running proxy *before* overwriting the file. It then reloads
and requires the admin API's loaded config to equal the adapted candidate. Do
not use `install`, `mv`, direct Compose, or container recreation for this file.

## Release and reboot resume

The isolation contract is declared in `deploy/hetzner/docker-compose.yml`, the
AppArmor profile, and the boot-guard unit; a release installs those, then
asserts that Docker and the kernel applied them — see
[deployment.md](../../deployment.md#codex-agent-host-isolation) for the exact
assertions. The release also proves the sandbox cannot reach the private bridge,
Postgres, or Caddy, and the container's own healthcheck
(`apps.codex_agent.health`) is what `up --wait` waits for.

After reboot, unlock and mount the credential state interactively, then run a
release (or `--check` first). Do not invoke Compose directly:

```sh
sudo cryptsetup open /var/lib/nexus/codex-state.luks nexus-codex-state
sudo mount -o rw,nosuid,nodev,noexec \
  /dev/mapper/nexus-codex-state /srv/nexus/codex-state
PYTHONPATH=python python3 deploy/hetzner/release.py --check
./deploy/hetzner/deploy.sh "$(git rev-parse origin/main)"
```

Until the volume is mounted, release preflight refuses: Docker cannot create the
Codex host without its credential bind source.

## Locked-reboot acceptance

The accepted reboot state is: mapping absent, `/srv/nexus/codex-state`
root-owned mode `000`, boot guard enabled, the rest of Nexus allowed to run,
and the Codex host stopped. Unlocking the volume and running a release is the
only supported way to start it again. Demonstrate that release preflight refuses
before unlock; then unlock, mount, release, and prove the exact host isolation
again with `release.py --check`. Store only the bounded receipt and system-service status; never archive
credential paths or native protocol frames.

### Disposable-VM locked-reboot acceptance (live evidence pending)

this remains a manual host check. on a disposable host,
reboot with the mapping locked, then record only these bounded facts:

```sh
sudo systemctl show docker.service --property=After --property=Requires
sudo stat -c '%u:%g:%a %n' /srv/nexus/codex-state
sudo docker compose --project-name nexus ps --all nexus-codex-agent-host
```

Prove the application services can start, the Codex host cannot be admitted,
and the protected underlay remains empty and inaccessible. Then unlock, mount,
run the controller resume command, and prove exact isolation again.

## runtime verification

synthetic capacity canaries and their release qualification are removed.
container memory, pid, no-swap, sandbox, credential-state, and identity contracts
still apply. the deployment controller checks the actual runtime's readiness
and release identity; these checks do not establish successful generation or
sustained memory margin.

after deployment, manually exercise affected generation operations through
ordinary product entrypoints when the change warrants it. use the generation
ledger as passive evidence of the deployed policy and route. investigate
memory demand with the actual affected workload; no synthetic account,
production fixtures, or replacement qualification harness is required.

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
through a release. Retain the retired artifact encrypted until the new host
passes a release, then unlink it. Never edit, print,
restore, or copy credential contents, and never re-enroll while the host runs.

the release is idempotent and forward-only: repair the named cause and rerun
it, under the
[canonical release recovery contract](../../deployment.md#failure-and-recovery).
the dedicated encrypted state remains untouched in either case. do not bypass
health, policy, sandbox, environment, or resource-limit checks.

## Incident boundaries

- Quota/auth/runtime/sandbox failure is terminal for that generation; never add
  API-based fallback inside the Codex route or automatic re-enrollment. Startup
  performs the required authenticated model-catalog probe; the pinned client may
  refresh the exact durable artifact during that probe.
- A pre-accept capacity refusal is known. A post-accept disconnect is uncertain
  and never capacity or redispatch authority.
- Grant values, `auth.json`, raw app-server frames, model output, prompts, and device
  codes are never diagnostic or certification artifacts.
- The host is not a public generation endpoint. Never expose the UDS through
  TCP, a reverse proxy, WebSocket/App Server, or arbitrary container exec.
- MCP is the only public tool route and is bearer-, lease-, run-, generation-,
  declaration-, and resource-scoped on every call.
