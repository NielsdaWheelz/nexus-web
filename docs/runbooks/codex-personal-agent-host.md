# codex personal agent host

`nexus-codex-agent-host` runs one stock codex `0.160.0` app-server signed into
the owner's chatgpt subscription and serves it on a unix socket. the api reads
its model catalog; workers run turns on it and execute every tool themselves.
the host holds the only copy of the account state and reaches nothing but two
openai names.

## composition

production composition is declared in `deploy/hetzner/docker-compose.yml`.
the local unix counterpart is the explicit `docker/docker-compose.codex.yml`
overlay over stores and worker definitions. disposable live labs instead attach
to the shared websocket host below.

- `python -m apps.codex_agent.main` requires `auth.json` mode `0600`, prepares
  `home/` and `tmp/` in the account directory and the explicit cwd root,
  removes a stale unix socket path, writes the startup model catalog, and starts
  codex with an explicit environment (`CODEX_HOME` is the account directory; no
  `*_API_KEY`, so subscription work never bills an api key). it exits 0 when
  stopped and 1 when codex exits on its own.
- host, api and workers run as uid/gid `10001` and share the socket volume
  `nexus_codex_run` at `/tmp/codex-daemon-10001` (mode `0700`); the api mounts
  it read-only. codex creates the socket `0600`.
- only the host mounts the account directory
  `/srv/nexus/codex-state/codex/codex-personal` (inside the luks volume) at
  `/var/lib/nexus-codex/codex/codex-personal`. codex owns `auth.json` (token
  refresh) and its private state there, including its own log `logs_2.sqlite`.
- docker's default apparmor and seccomp, read-only root, no capabilities, no
  ports, one network, 448 MiB, `nofile` 1024.
- `docker/codex-requirements.toml` (`/etc/codex/requirements.toml`) disables the
  native features nexus does not use, including remote control.

## egress

the host's only network is `codex_private` (internal, isolated gateway). its one
peer is `codex-egress-policy`: stock `nginx`, pinned by digest, a tls
passthrough proxy keyed on sni. the host's `/etc/hosts` pins `chatgpt.com` and
`auth.openai.com` to the proxy (`extra_hosts`); no other name resolves on an
internal network. the proxy forwards a listed sni, still encrypted, to that name
on `443` through its own network; any other sni goes to a closed port and is
dropped. there is no port 80 and no dns server. tls stays end-to-end.

so codex reaches exactly `chatgpt.com:443` (backend, model turns, account) and
`auth.openai.com:443` (device login, token refresh). everything else codex may
try (`api.openai.com`, the `ab.chatgpt.com` telemetry, sentry) fails to resolve.

the proxy connects to whatever the release host's dns answers for the two
names. unlike the retired python relay it does not refuse private addresses
(nginx has no upstream address filter), so a forged answer would aim the host's
streams at that address's port `443`. codex refuses a peer without a valid
certificate for the name, but a compromised host could send anything after its
clienthello. accepted: exploiting it takes both the host and that dns.

to change the allowlist, edit the proxy's `map` in `x-codex-egress-conf` and the
host's `extra_hosts` together, including their local-compose counterparts, then
qualify the affected egress before release. a mismatch fails closed. the release asserts that docker applied
the declaration (internal gateway-less network whose only members are the host
and the proxy, the host's confinement and its one bind); the harness proves the
declaration behaves.

## health, stop and restart

- health is `python -m apps.codex_agent.health`: the product's own catalog read
  through the socket. it prints `codex 0.160.0 ready: <n> models, contract <r>`
  into docker's health log. a starting codex reads the account from chatgpt.com
  before its first answer, so a host started during an openai outage stays
  unhealthy and a release that starts it fails; once up, its probes are
  answered without contacting chatgpt.com.
- stop (`compose stop`, the release): codex drains running turns; after 30 s the
  host kills it; the container exits 0 and stays stopped.
- `restart: on-failure:3`: an app-server crash or oom kill exits 1 and docker
  starts the container again, at most 3 times per release or manual start.
  docker counts restarts since the container was created or last started by
  hand, however long it ran in between, so the fourth crash since then leaves
  it down. a manual `docker kill` is not restarted.
- after a reboot docker cannot create the host until the luks volume is unlocked
  and mounted: the bind source is missing on the guarded underlay
  (`create_host_path: false`, boot guard).

## enrollment

once, or after retiring a credential. the luks volume must be unlocked and
mounted, the account directory present and private, and the host stopped:

```sh
sudo install -d -o 10001 -g 10001 -m 0700 \
  /srv/nexus/codex-state/codex /srv/nexus/codex-state/codex/codex-personal
WORKER_IMAGE=$(docker inspect -f '{{.Config.Image}}' nexus-nexus-codex-agent-host-1)
API_IMAGE=$(docker inspect -f '{{.Config.Image}}' nexus-api-1)
compose() {
  sudo env API_IMAGE="$API_IMAGE" WORKER_IMAGE="$WORKER_IMAGE" \
    NEXUS_CONFIG_FILE=/etc/nexus/current.env docker compose --project-name nexus \
    --env-file /etc/nexus/current.env --file /etc/nexus/docker-compose.yml "$@"
}
compose stop --timeout 45 nexus-codex-agent-host
compose run --rm nexus-codex-agent-host python -m apps.codex_agent.enroll
```

the one-off is the host's own service definition: same user, read-only root,
account bind and allowlisted egress. it prints a device code; complete it in any
browser. it writes `auth.json` (`0600`) and refuses when one exists. it cannot
start while the host runs (the host's address is taken). then release.

to re-enroll, stop the host, retire the old file inside the encrypted
directory, enroll, release, and delete the retired file once the host is
healthy:

```sh
sudo mv /srv/nexus/codex-state/codex/codex-personal/auth.json \
  "/srv/nexus/codex-state/codex/codex-personal/auth.json.retired-$(date -u +%Y%m%dT%H%M%SZ)"
```

never print, copy or archive `auth.json` or a device code.

## local enrollment

local workers, api and web remain useful without this overlay or an account.
without a reachable host, the generation catalog exposes Codex unreadiness and
no invented model facts; explicitly configured API providers remain available
for chat. the developer Codex seed and background policy never switch routes.
metadata research requires the overlay plus nonblank `OPENAI_API_KEY` and
`BRAVE_SEARCH_API_KEY` exported for the direct compose commands below. workers
receive explicitly declared settings, never the account directory. the host receives neither provider key nor the application `.env`.
api/web remain host-native; imports, metadata admission and metadata reads use
the shared database.

from the checkout root, after the worker build prerequisites in
[`apps/worker/README.md`](../../apps/worker/README.md#docker):

```sh
make local-runtime-identity
export NEXUS_LOCAL_SOURCE_SHA="$(git rev-parse HEAD)"
export NEXUS_LOCAL_WORKER_IMAGE="$(python/.venv/bin/python python/scripts/worker_checkout_image.py)"
export NEXUS_LOCAL_RUNTIME_IDENTITY_FILE="$PWD/.nexus-local/runtime-identity.json"
export COMPOSE_PROJECT_NAME="${LOCAL_COMPOSE_PROJECT:-nexus-local}"
export COMPOSE_FILE=docker/docker-compose.yml:docker/docker-compose.worker.yml:docker/docker-compose.codex.yml
export COMPOSE_ENV_FILES=.dev-ports
compose_local() {
  docker compose "$@"
}
compose_local build nexus-codex-agent-host
compose_local stop --timeout 45 nexus-codex-agent-host
compose_local run --rm nexus-codex-agent-host python -m apps.codex_agent.enroll
compose_local up -d --wait nexus-codex-agent-host
python/.venv/bin/python python/scripts/worker_checkout_image.py worker-interactive worker-background
compose_local up -d --no-build worker-interactive worker-background
```

complete the device login shown by the one-off; keep its credentials private.
enrollment writes `auth.json` mode `0600` and refuses to replace an existing file.
use a separate local login; never copy production account state. re-enrollment
requires stopping the host and retiring its old local file first.

the local account is the compose-owned `nexus_codex_account` native volume at
`/var/lib/nexus-codex`; the image creates its mount directory as uid/gid 10001,
mode 0700. this retires the mac account bind and its ownership mismatch. an old
bind is neither copied nor deleted: enroll the dedicated volume explicitly.
the shared socket volume and both networks belong to the compose project. the
private subnet defaults to `172.31.0.0/24`; another concurrent local stack sets
`NEXUS_LOCAL_CODEX_SUBNET_PREFIX` to a different unused /24 prefix. literal host
entries point only the two allowed names to the local proxy, whose own dns still
resolves their public upstreams. the local unix overlay publishes no port.
local services use docker's ordinary logging, not the production journald driver.

`compose_local logs nexus-codex-agent-host codex-egress-policy` explains host/proxy
startup failures. catalog health proves the socket and native protocol; worker
health proves queue progress. neither proves provider tools. qualify one isolated
metadata operation with the exact model/effort and actual search/read executions.
missing tool keys or host availability produce visible research failure; repair
that dependency, then deliberately retry the affected metadata operation.

## shared live labs

`./scripts/lab-codex enroll` prepares the immutable worker image and dedicated
native account volume, then runs device login. complete its browser sign-in;
it refuses existing credentials. it never reads personal codex state. the
separate private transport capability lives under
`${XDG_STATE_HOME:-~/.local/state}/nexus-lab/codex/`; never print or copy it.

```sh
./scripts/lab-codex enroll
./scripts/lab-codex up
./scripts/lab-codex status
./scripts/lab --live-codex -- COMMAND ARG
./scripts/lab-codex down
```

ordinary live attachment starts the enrolled compatible host when stopped and
holds shared lifecycle access through worker/session teardown. both worker lanes
stay in linux; the api reaches the authenticated native websocket through a raw
tcp listener on the existing nginx peer, published only on host loopback. nginx
passes bytes to the daemon unchanged; native codex still owns bearer authentication
and websocket protocol. workers connect directly to the daemon and share the
internal client network and cwd volume, with separate run/session directories.
only the daemon/enrollment mount `nexus-lab-codex-account` at
`/var/lib/nexus-codex`, containing `auth.json`; `nexus-lab-codex-cwds` mounts at
`/tmp/codex-daemon-10001`. both mount directories are baked uid/gid 10001,
mode 0700. the daemon receives only the transport token's sha256 verifier through
native `--ws-token-sha256`; clients receive the raw token as secret configuration.
the daemon's networks remain internal; the additional client network grants no
outbound route. the existing nginx peer carries both raw tcp ingress and the
allowlisted tls egress. Docker Desktop suppresses host port publication for a
container with only internal networks, so the peer owns the loopback publication;
the daemon has no published port. fake/core labs never attach or receive the account capability.

`NEXUS_CODEX_ENDPOINT` is `unix:///absolute/path` or `ws(s)://host:port`.
websocket clients require `NEXUS_CODEX_TRANSPORT_TOKEN`; unix clients forbid it.
`NEXUS_CODEX_CWD_ROOT` is separate from the endpoint and temporary runtime state.
live workers receive `/tmp/codex-daemon-10001/cwds/<run_id>` explicitly.
health qualifies the authenticated catalog and pinned contract without a paid
turn. setup errors stop before the driver. transport loss fails affected work
without resubmission or shared-host restart. cleanup retains a run cwd when remote
closure cannot be established; finish/recover its workers and sessions explicitly.

`down` gracefully stops the host, retaining image, stopped containers, account,
transport capability, networks and cwd volume. enrollment, stop and replacement
refuse active shared-lock holders or running workers mounting the shared cwd
volume, including workers whose runner crashed. finish/recover those labs first.

upgrades are deliberate: drain labs, run `down`, then `up` from the qualified new
checkout. ordinary attach never replaces an installation or reconciles it against
mutable checkout source. the retained service references its immutable image id;
deleting its initiating checkout leaves it usable from another checkout.
re-enrollment follows the stopped-host credential-retirement rule above, inside
the dedicated account volume. never copy production/personal auth or relax
permissions. real token refresh remains separately unqualified below.

## diagnostics

- why the host exited: `journalctl CONTAINER_NAME=nexus-nexus-codex-agent-host-1`
  (`codex app-server exited with status <n>`, `... must be mode 0600`).
- probe results and restarts: `docker inspect -f '{{json .State.Health}}
  {{.RestartCount}}' nexus-nexus-codex-agent-host-1`.
- codex's own log: table `logs` of `logs_2.sqlite` in the account directory.
  read it in place; it stays inside the encrypted volume.
- a dropped sni: `journalctl CONTAINER_NAME=nexus-codex-egress-policy-1` shows
  `connect() failed ... upstream: "127.0.0.1:1"`, without the name.

## release and repair

after a reboot, unlock, mount and release:

```sh
sudo cryptsetup open /var/lib/nexus/codex-state.luks nexus-codex-state
sudo mount -o rw,nosuid,nodev,noexec \
  /dev/mapper/nexus-codex-state /srv/nexus/codex-state
PYTHONPATH=python python3 deploy/hetzner/release.py --check
./deploy/hetzner/deploy.sh "$(git rev-parse origin/main)"
```

a host left exited (a manual kill, or its restart budget spent) is repaired by
`docker start nexus-nexus-codex-agent-host-1`, which also resets the restart
count. do it before releasing: the release refuses a host whose last exit code
is not 0 (`did not stop cleanly`). a host on a rejected credential is
re-enrolled first, then started. a worker that loses the host mid-turn fails
that turn; the user reruns it.
codex refreshes `auth.json` by rewriting it in place, not by rename
([codex-auth-json-rewritten-in-place](../issues/codex-auth-json-rewritten-in-place.md));
a real token rotation is still unqualified
([codex-auth-refresh-not-qualified](../issues/codex-auth-refresh-not-qualified.md)).
