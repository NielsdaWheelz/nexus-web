# codex native callback host

`nexus-codex-agent-host` supervises one stock codex `0.160.0` app-server.
workers run the shared kernel and the existing portable tool executor directly.
there is no generation http relay, exec-server, native shell, copied skill,
generation bearer, callback relay, or worker account mount.

## composition

- host and workers run as uid/gid `10001:10001`.
- they share the existing socket volume at `/tmp/codex-daemon-10001`, private
  mode `0700`. the configured endpoint is `app-server.sock`; its resolved
  native socket must remain inside that same mount and is mode `0660`.
- workers create separate empty read-only cwds under that volume's `cwds/`.
  provider state roots remain private and credentialless. each worker can close
  its client/session; it cannot stop the shared process.
- the api mounts the socket volume read-only for authenticated public catalog
  access. workers mount it writable for their private cwd lifecycle.
- only the host receives `/srv/nexus/codex-state/codex/codex-personal`, mounted
  at `/var/lib/nexus-codex/codex/codex-personal`. that mode-`0700` directory
  contains mode-`0600` `auth.json` and native private state. native codex owns
  token refresh and may atomically replace the file. no inode pinning, auth
  link, after-turn synchronization, or copy-back exists.
- the host uses docker's default confinement, a read-only root filesystem,
  no capabilities, and no published ports. the existing internal egress network
  contains only the host and its public egress policy peer. the api is no
  longer a peer; all application tools execute in the worker.

`NEXUS_CODEX_NATIVE_SOCKET` configures the endpoint. only the host receives
`NEXUS_CODEX_CREDENTIAL_FILE`. both belong to composition, never the shared
runtime env file. neither ambient `CODEX_HOME` nor `*_API_KEY` is accepted by
the host. subscription credentials never overflow onto api billing.

`python -m apps.codex_agent.health` uses public `AgentRuntime` catalog access
and verifies subscription availability and the current source contract. it
performs no inference. start ordering is `service_started`, so expired account
state cannot stop unrelated ingest or reader work. the catalog reports typed
unavailability; native uncertainty blocks redispatch.

## encrypted state and enrollment

the existing encrypted filesystem remains `/dev/mapper/nexus-codex-state`,
mounted `rw,nosuid,nodev,noexec` at `/srv/nexus/codex-state`. the unlock secret
stays off-host. there is no automatic crypttab entry or plaintext fallback.
the existing boot guard protects the locked underlay as root-owned mode `000`.
the host retains `restart: "no"`; unlocking and the release controller own
its startup. database backups never mount or read this state.

enrollment remains the one-shot device-auth entrypoint. it writes into a private
temporary profile, atomically installs only the bounded opaque auth artifact,
and refuses to replace existing enrollment:

```sh
docker run --rm --interactive --tty --user 10001:10001 --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=0700,uid=10001,gid=10001 \
  --mount type=bind,source=/srv/nexus/codex-state,target=/var/lib/nexus-codex \
  --env CODEX_HOME=/tmp/nexus-codex-enrollment \
  --env NEXUS_CODEX_ENROLLMENT_AUTH_FILE=/var/lib/nexus-codex/codex/codex-personal/auth.json \
  "$WORKER_IMAGE" python -m apps.codex_agent.enroll
```

`WORKER_IMAGE` is the release's immutable digest. first enrollment requires an
unlocked private process-owned state root and an allowed public-egress network.
inspect ownership/mode only; never print auth contents or device codes.

an old socket volume needs its directory changed to the new boundary before
starting the candidate host. stop its old host first, remove only that host's
exited native sockets, then initialize the existing volume once:

```sh
docker run --rm --network none --user 0:0 --read-only \
  --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges:true \
  --mount source=nexus_nexus_codex_run,target=/tmp/codex-daemon-10001 \
  alpine:3.22 \
  install -d -o 10001 -g 10001 -m 0700 /tmp/codex-daemon-10001
```

the requested symlink and its actual target are removed only after the owned
native process group exits. an occupied startup path fails; the host never
takes over another daemon. one host crash can affect several jobs, whose
provider submissions remain unresolved until authoritative reconciliation.

## release and repair

the deployment controller preserves encrypted-mount and boot-guard admission,
checks default docker confinement and the host-only account directory mount,
and proves no native host route to the application api, database, caddy, or
metadata. its declared topology is `deploy/hetzner/docker-compose.yml`.
runtime health is not research or model qualification.

after reboot, unlock, mount, and run the existing release controller:

```sh
sudo cryptsetup open /var/lib/nexus/codex-state.luks nexus-codex-state
sudo mount -o rw,nosuid,nodev,noexec \
  /dev/mapper/nexus-codex-state /srv/nexus/codex-state
PYTHONPATH=python python3 deploy/hetzner/release.py --check
./deploy/hetzner/deploy.sh "$(git rev-parse origin/main)"
```

keep the host stopped on a rejected or corrupt auth artifact. re-enrollment is
an explicit operator operation performed while stopped; retire the old file
inside the encrypted profile and use the same enrollment entrypoint. preserve
unresolved generation/action evidence. never bypass it by resending an action.

## qualification

the isolated linux uid/gid-10001 proof used actual stock codex `0.160.0`, the
new host entrypoint, public provider/kernel sources, and credentialless workers.
the requested socket resolved into the shared mount with `0700`/`0660` modes.
two actual `gpt-6-luna` / `xhigh` callbacks were pending simultaneously:
interrupting job-a retained native cancelled evidence, while job-b kept its own
callback and completed strict json after its reply. the shared host stayed live.
receipts: `/private/tmp/nexus-native-topology-zcDlUE/job-a.json` and `job-b.json`.
these are source-overlay native topology proofs, not app research receipts,
production deployment proof, or actual token-refresh qualification.

real refresh remains tracked in
[codex-auth-refresh-not-qualified.md](../tickets/codex-auth-refresh-not-qualified.md).
forcing refresh on a copy of a shared account could rotate its remote token;
qualify expiry with an independent disposable credential. no replacement
native research tools or controlled peers satisfy the separate app search/read
acceptance.
