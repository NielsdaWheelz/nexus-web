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
- The deployed host has a root-owned, fixed 1 GiB LUKS2 container at
  `/var/lib/nexus/codex-state.luks`, opened as
  `/dev/mapper/nexus-codex-state` and mounted with
  `rw,nosuid,nodev,noexec` at `/srv/nexus/codex-state`. Compose directly binds
  that mount into the credential host; there is no Docker-managed state volume
  or local-driver mountpoint cache.
  The release-owned PostgreSQL backup neither mounts nor reads the Codex state filesystem.
  Provider snapshots and any operator backup process are outside the automated
  admission proof; review their scope separately and treat the encrypted
  container as the only admitted on-host representation.
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

Automated admission proves only the repository-owned secret locations: it
rejects `/var/lib/nexus/codex-state.key` and an `/etc/crypttab` entry naming
`nexus-codex-state` or `/var/lib/nexus/codex-state.luks`. Keeping the unlock
secret off-host and excluding it from every other operator-managed store remain
explicit operator responsibilities. Unlock is deliberately interactive after
every reboot. There is no plaintext Docker-volume fallback.

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

1. Provision the credential filesystem. On a new server, Docker must remain stopped until the mapping is unlocked. On the running production server,
   the Codex host does not exist yet, so leave unrelated application containers
   running while provisioning this new path. Do not create a Docker credential
   state volume.

   ```sh
   sudo apt-get update
   sudo apt-get install --yes --no-install-recommends cryptsetup
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
     --output SOURCE,TARGET,FSTYPE,OPTIONS
   ```

   Do not add an `/etc/crypttab` entry: unattended unlock would require a
   same-host key or a boot-time secret channel that this one-user deployment
   does not own. Before qualification, the operator must install the immutable
   systemd boot guard once using the release controller; qualification, apply,
   and resume only validate it and never repair a disabled or changed guard:

   ```sh
   readonly SOURCE_SHA='<installed candidate source SHA>'
   sudo env PYTHONDONTWRITEBYTECODE=1 \
     PYTHONPATH="/opt/nexus/releases/$SOURCE_SHA/python" \
     python3 -B "/opt/nexus/releases/$SOURCE_SHA/release.py" \
     install-codex-state-boot-guard --source-sha "$SOURCE_SHA"
   ```

   Together with `restart: "no"`, the guard restores the unmounted
   underlay to root-owned mode `000` before Docker starts, so a reboot cannot
   restart the host onto plaintext storage.

2. On the VM, obtain the exact `WORKER_IMAGE` digest from the candidate's
   immutable `candidate-manifest.json`. Do not use a tag.

   ```sh
   readonly WORKER_IMAGE='ghcr.io/nielsdawheelz/nexus-worker@sha256:<candidate digest>'
   docker volume create --name nexus_nexus_codex_run
   docker run --rm --network none --user 0:0 --read-only \
     --cap-drop ALL --cap-add CHOWN \
     --security-opt no-new-privileges:true \
     --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
     --mount source=nexus_nexus_codex_run,target=/run/nexus-codex \
     --entrypoint sh "$WORKER_IMAGE" -c \
     'install -d -o 10001 -g 10001 -m 0770 /run/nexus-codex'
   ```

   The initializer has no network and never mounts the credential filesystem.
   Its sole added capability is the `CHOWN` needed to initialize the empty
   Compose-owned run volume.

3. Start the official interactive device login as uid `10001`, mounting only
   the dedicated encrypted state mount. Profile isolation comes only from `CODEX_HOME`.

   ```sh
   (
     set -eu
     readonly ENROLLMENT_NETWORK="nexus-codex-enrollment-$$"
     cleanup_codex_enrollment_network() {
       docker network rm "$ENROLLMENT_NETWORK" >/dev/null 2>&1 || true
     }
     trap cleanup_codex_enrollment_network EXIT HUP INT TERM

     docker network create --driver bridge \
       --opt com.docker.network.bridge.enable_icc=false \
       "$ENROLLMENT_NETWORK" >/dev/null
     docker run --rm --interactive --tty --user 10001:10001 --read-only \
       --network "$ENROLLMENT_NETWORK" \
       --cap-drop ALL --security-opt no-new-privileges:true \
       --memory 384m --memory-swap 384m \
       --pids-limit 64 --cpus 1.0 \
       --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
       --mount type=bind,source=/srv/nexus/codex-state,target=/var/lib/nexus-codex \
       --env CODEX_HOME=/var/lib/nexus-codex/codex/codex-personal \
       "$WORKER_IMAGE" python -m apps.codex_agent.enroll
   )
   ```

   Complete the browser/device handoff yourself. Never paste login output into
   a terminal recording, ticket, chat, Git file, or environment file.
   The command passes no `OPENAI_API_KEY`; the enrollment wrapper rejects one
   if it is introduced. Equal memory and memory-swap limits disable swap for
   the credential-bearing enrollment process, matching the deployed host.

4. Verify metadata only; these commands never read credential contents.

   ```sh
   sudo stat -c '%u:%g:%a %n' \
     /srv/nexus/codex-state \
     /srv/nexus/codex-state/codex/codex-personal \
     /srv/nexus/codex-state/codex/codex-personal/auth.json
   ```

   The state root and profile directory must be `10001:10001:700`; `auth.json`
   must be `10001:10001:600`. Do **not** display, copy, hash, or otherwise
   inspect credential-file contents.

5. Complete **Existing-VPS capacity qualification** below, then run the ordinary
   immutable release. Release and qualification never mount the credential
   state from a second container: pre-admission proves the LUKS mapper and
   mounted `/srv` path; the post-start host inspect proves the exact direct
   bind. Readiness independently requires
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
   systemctl is-enabled --quiet nexus-codex-state-boot-guard.service
   systemctl cat nexus-codex-state-boot-guard.service
   ```

After a reboot, the application stack may start but the Codex host remains
stopped by its Docker restart contract. Interactively reopen the LUKS2
container and mount it with the exact options above. Then use the public release
controller path; do not invoke Compose directly:

```sh
readonly SOURCE_SHA="$(sudo cat /var/lib/nexus/releases/current)"
sudo env PYTHONDONTWRITEBYTECODE=1 \
  PYTHONPATH="/opt/nexus/releases/$SOURCE_SHA/python" \
  python3 -B "/opt/nexus/releases/$SOURCE_SHA/release.py" \
  resume-codex-agent-host --source-sha "$SOURCE_SHA"
```

The command admits the mapper, mount, boot guard, declared direct-bind
configuration, and at least 128 MiB of free credential-state space before
starting only `nexus-codex-agent-host` with `--no-deps --wait`. It then proves
the live bind, sandbox, auth identity, isolation, backend, and public HTTPS
contracts. Success prints one bounded `nexus-codex-agent-host-resume.v1`
receipt. Any post-start failure stops the host. Never run the host while
`/srv/nexus/codex-state` is merely the protected underlay.

If admission reports less than 128 MiB free, keep the host stopped. Preserve an
off-host copy of the encrypted container, unlock it interactively, and use only
a supported Codex cleanup operation whose exact scope you have reviewed. If no
such operation exists, provision a new exact 1 GiB encrypted container and
re-enroll; do not delete or edit credential files in place.

## Disposable-VM locked-reboot acceptance (live evidence pending)

This is a live operator acceptance procedure, not a synthetic test.
CI fakes do not satisfy this live acceptance procedure.

1. Provision a disposable Ubuntu 24.04 VM with the same release artifacts and
   a separate Codex enrollment. Never copy production credential state.
2. Install the boot guard, start and prove the host, then reboot while leaving
   the LUKS mapping locked.
3. Prove that `/dev/mapper/nexus-codex-state` and its mount are absent, the
   underlay is root-owned mode `000`, Docker is running, and the Codex host is
   stopped. Running `resume-codex-agent-host --source-sha` must fail before a
   service mutation. Capture the boot dependency and monotonic journal order:

   ```sh
   systemctl show docker.service --property=After --property=Requires
   journalctl --boot --unit=nexus-codex-state-boot-guard.service \
     --unit=docker.service --output=short-monotonic --no-pager
   ```

   `After` and `Requires` must name
   `nexus-codex-state-boot-guard.service`, and the journal must show the guard
   completed before Docker started. Treat missing or ambiguous ordering as a
   failed acceptance, not a documentation-only discrepancy.
4. Interactively unlock and mount the container, run the same resume command,
   and retain its bounded ready receipt plus content-free mapper, mount, Docker
   inspect, backend, and public-proof outputs as the live acceptance record.
5. Stop the host, unmount the filesystem, and close the disposable mapper
   before destroying the VM.

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

If a run is interrupted after the canary container starts (SSH drop, the
script's own remote timeout), the next attempt for the unchanged SHA
automatically reclaims and removes it by its
`nexus.release.codex-capacity-canary` ownership label; no manual step is
needed. If the fixed canary name is instead held by a container that does not
carry that label (a foreign or manually created container), the run blocks
with `Codex capacity canary name is held by a foreign container`. The fixed
name is not deletion authority: identify the owning deployment or operator,
inspect the exact container ID and labels, and retire that exact owner through
its own lifecycle before retrying. Never resolve this refusal with a name-only
`docker rm`.

Evidence contains no prompt, output, raw frame, account identifier, device code,
or credential fact. The immutable release controller stores root-owned `0444`
evidence at `/var/lib/nexus/releases/codex-capacity/<source-sha>.json`; do not
open or edit it manually. `not_run` from pre-admission headroom,
`provider_blocked` from auth/quota, and `transport_retriable` from pre-accept
unavailability or accepted transport loss write no qualifying evidence; repeat
the unchanged SHA only after the corresponding pressure, account, or transport
fault is resolved. Candidate resource, host policy, protocol, or
structured-output failure blocks the cutover. PostgreSQL, Caddy, API, and
worker readiness are observations of the unchanged live predecessor; their
failure writes no evidence and is retriable for the same SHA. Caddy's Compose
healthcheck uses its container-local admin GET after the next recreation, while
the first cutover probes the already-running predecessor container directly.
The ordinary release reruns that exact admin GET before resource convergence or
writer mutation and still proves the public HTTPS `/readyz` and `/version`
contracts. Do not raise the Codex limit,
lower the reserve, reduce an existing service limit, manipulate production
memory, or rerun to replace failed evidence. Remediation requires a separately
specified memory reduction or resize.

A run that measured nothing is retriable and writes no evidence. The controller
classifies the canary by the evidence it stated, never by its exit status alone:
only output that parses as the canary's own contract statement can produce
failed evidence. If the canary crashed, was OOM-killed, or was cut off before
stating that contract, the run fails with `Codex capacity canary did not state
its contract` (empty or unparseable output) or `Codex capacity canary did not
reach a terminal` (a complete statement carrying an exit status the contract
does not define); nothing was observed about the measured envelope, so rerun the
unchanged SHA. The same holds for Docker, transport, cleanup, and sampler
faults. A breach the host sampler observes during the turns is the opposite: it
is a measurement, so it writes failed evidence and ends this cutover for that
SHA exactly like a breach in the assembled evidence.

Passing evidence expires after 72 hours: promotion then blocks with `Codex
capacity qualification is stale`, because the measurement no longer describes
the host the promotion would run on. Rerun the same command for the unchanged
SHA — it replaces the expired file in place with a fresh root-owned `0444`
measurement. Nothing else is replaceable: a still-fresh pass refuses with
`Codex capacity qualification evidence already exists`, and failed evidence
refuses with `Codex capacity qualification failed evidence is immutable`.

After qualification, routine turn admission remains automatic. The host reads
its cgroup and host memory pressure before HTTP acceptance. Capacity refusal
keeps metadata queued on the bounded schedule; it is not an incident unless the
wait exhausts or other service health/pressure evidence is abnormal.

## Background-lane coupling

Compose orders `worker-background` after `nexus-codex-agent-host` with
`condition: service_started`, deliberately **not** `service_healthy`. The
ordering exists only so a metadata job cannot be claimed before the host
container and its `/run/nexus-codex` socket volume exist. Readiness is not a
dependency, because the background lane also runs ingest, podcast sync,
reindex, and media teardown: making all of that wait on Codex readiness would
let one expired ChatGPT credential stop every background job on the box. Do not
restore `service_healthy`.

The accepted consequence is that an unhealthy host degrades metadata alone. The
host probes ChatGPT authentication before it binds its socket, and Compose never
restarts it (`restart: "no"`, because the encrypted credential filesystem must
never be reopened unattended), so an expired or revoked credential makes the
host exit once and stay `Exited`; the release controller's
`resume-codex-agent-host` is the only supported way to start it again. While
the host is down:

- metadata enrichment turns take the spec's terminal
  `E_METADATA_AGENT_HOST_UNAVAILABLE` (or `E_METADATA_AGENT_AUTH_UNAVAILABLE`
  once the socket is serving but the account is rejected). These are terminal
  soft failures: they never auto-retry, so re-request enrichment for affected
  resources after remediation;
- every other background job continues normally, and the interactive lane, API,
  and Caddy are untouched.

Confirm the shape of the incident before touching anything else. A plain
`docker compose ps` omits exited containers, so list all of them and read the
exit cause from the host's own redacted log:

```sh
docker compose --project-name nexus ps --all nexus-codex-agent-host
docker compose --project-name nexus logs --tail 50 nexus-codex-agent-host
```

An `Exited` host whose log ends in an auth rejection needs **Re-enrollment**; an
`Exited` host whose log reports absent state storage needs the interactive LUKS
unlock and `resume-codex-agent-host` sequence under **First enrollment**.

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
