# codex subscription generation host operations

this runbook owns the credential-safe deployment boundary for
`nexus-codex-agent-host`. the host serves command v5, the authenticated model
catalog, events and health over `/run/nexus-codex/agent.sock`. a dynamic
loopback websocket serves only remote native execution inside the container.
no port is published. the host has no database credential, application data
mount or host-home mount.

## runtime boundary

- the worker image pins codex app-server and exec-server to 0.157.1. the app-server runs outside the namespace with account auth and `CODEX_EXEC_SERVER_URL=none`. each generation starts one exec-server inside a fresh bubblewrap user/pid/mount namespace. the provider library registers its dynamic loopback endpoint, verifies `environment/info`, and selects only that remote environment for thread and turn.
- the host stays non-root, capability-free, read-only, and limited to one admission slot. the private executable tmpfs holds separate account state and disposable shell scratch. the shell sees read-only system executables/libraries, ca and resolver files, scratch cwd/home, and fresh `/proc` and `/dev`; it cannot mount `/`, account auth, host sockets or product data. bubblewrap clears inherited environment and takes the generation api token through an inherited argument pipe, so the bearer is absent from the host process command line. nested user namespaces are disabled. the namespace init and `--die-with-parent` end detached descendants when the executor stops.
- the release-owned `nexus-api` skill is copied into the scratch workspace before exec-server startup. the shell receives the run-bound `NEXUS_AGENT_API_*` values and generation id. native shell activity is progress; the host holds model text until it can redact bearer values across chunks and rejects a structured final containing the bearer. account auth remains outside the namespace and refreshes only the enrolled artifact.
- the host, generation api, and `codex-egress-policy` are the only members of internal `nexus_codex_private`. the api is pinned to `172.30.0.4:8000`; public caddy denies `/agent-api`. the policy sidecar alone joins the public-egress bridge. its dns, http and tls listeners admit public hosts and connect only to globally routable addresses. private services, administration and metadata remain unreachable in both address families. tls remains end-to-end.
- the authenticated app-server, exec-server, native client and namespace are awaited before scratch is deleted and the slot released. the host refuses readiness after unproven teardown or stale scratch at restart. readiness exercises the actual namespace mounts; deployment checks the private network membership and denied destinations. the generation ledger closes api admission before accepting a terminal.
- the api and both worker lanes mount the existing private `agent.sock` volume. no account credential or shell endpoint is published there. docker engine 28 or newer is required for the isolated bridge. never set ambient `CODEX_HOME` or any `*_API_KEY` on the running host; only the one-shot enrollment command may set `CODEX_HOME`.

## execution and api boundary

codex has ordinary shell and public internet access inside disposable scratch. the generation api grants the authenticated account's visible corpus and the fixed set of additive operations. its token expires with the generation. api calls retain domain receipts, replay and supported undo; native shell/public-internet effects do not. the managed skill teaches schema discovery, exact operation calls, same-key retry and citation. the host reports credential, runtime and teardown failures by stage and code without logging native frames or bearer values.

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
assertions. The release also proves the sandbox cannot reach Postgres, Caddy, or metadata,
while the generation api remains private. the container's own healthcheck
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
- the generation api is private and bearer-bound. provider function calls retain
  their frozen authority, durable position, effect receipt, and replay checks.
