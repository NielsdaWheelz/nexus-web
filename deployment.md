# Production deployment

This is the sole production runbook. Nexus uses a planned no-use window and one
human-triggered release. Do not mutate production Compose services, the host
`current` pointer, or Vercel aliases outside the owners named here.

## Production shape

| Capability | Production owner |
|---|---|
| Frontend and BFF | Vercel project `nexus-web` |
| API, interactive worker, background worker | Hetzner Compose project `nexus` |
| Product database | Hetzner Postgres with pgvector |
| Object storage, database backups | Cloudflare R2 |
| Authentication | Supabase Auth only |
| API TLS | Caddy on the Hetzner host |

Public hosts are `nexus.nielseriknandal.com` (frontend) and
`api.nexus.nielseriknandal.com` (API). The VPS is `nexus-api-worker` at
`5.78.194.235`.

The release identity is one full lowercase Git `source_sha`. It binds the Vercel
deployment, the API and worker image digests, the expected Alembic revision, and
the expected Oracle manifest digest.

## Non-negotiable rules

- `deploy/hetzner/deploy.sh <source-sha>` is the only application release
  entrypoint. It converges the backend and then binds the frontend.
- The release is **linear and idempotent**. There is no attempt state, no
  resume mode and no rollback settlement: after a failure, repair the named
  cause and rerun the same command. The only durable release state on the host
  is `/var/lib/nexus/releases/current`.
- A release requires a clean checkout where `HEAD == origin/main == source-sha`.
- The images deployed are the ones the **first** CI run of that exact main SHA
  built. `backend-images.yml` publishes only under `github.run_attempt == 1`,
  and the release refuses a run whose `run_attempt` is not 1. A rerun therefore
  cannot produce a deployable candidate: merge a new commit instead.
- Production pulls GHCR digests named by the candidate manifest. It never
  builds an application image.
- Config publication (`sync-env.sh`) and Oracle reconcile
  (`reconcile-oracle.sh`) are explicit, separate operations. The release
  neither performs nor waits for them.
- There is no automatic database downgrade. After the migration runs, recovery
  moves forward; the verified R2 archive is a recovery point, not a rollback.
- Secrets belong only in provider settings and unpublished env inputs. They
  never belong in command arguments or logs.

## Operator prerequisites

Install the repository's locked dependencies and authenticate `gh`, SSH and
Vercel. The release needs `curl`, `gh`, `git`, `jq`, `python3`, `scp`, `ssh`,
`timeout`, and the locked Vercel CLI under `apps/web/node_modules`.

```bash
export VERCEL_TOKEN=<vercel-token>
```

`gh` supplies GitHub credentials; SSH to `nexus@5.78.194.235` must be
non-interactive with passwordless `sudo` on the host.

Production coordinates are committed, not ambient: SSH `nexus@5.78.194.235`,
web `nexus.nielseriknandal.com`, Vercel project `nexus-web` /
`prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs`, team `niels-erik-nandals-projects` /
`team_fKVvTyTsMBQ7qFjccFO17BJL`. Changing a coordinate is a reviewed
infrastructure change, not a release flag.

**After any reboot, unlock the Codex credential volume before releasing.** The
boot guard leaves `/srv/nexus/codex-state` root-owned and mode `000` until its
LUKS2 container is opened and mounted; Docker cannot create the Codex agent
host without that bind source, so preflight refuses to proceed. See
`docs/runbooks/codex-personal-agent-host.md`.

The host contract is cgroup v2 with the memory controller, Docker Engine 28 or
newer (the Codex private bridge needs `gateway_mode_ipv4=isolated`), at least
1 GiB of swap, at least 128 MiB of available memory and 2 GiB free under `/`.
Preflight measures each of these. Vercel custom-domain auto-assignment must stay
disabled and Vercel Authentication must protect previews only, so the staged
production-target deployment is publicly probeable before promotion.

## Immutable artifact lineage

On every push to `main`, `.github/workflows/backend-images.yml` builds the API
and worker images once, pushes them to GHCR, proves each image's
`org.opencontainers.image.revision` label and baked `/app/runtime-identity.json`
agree with the source SHA, and uploads one artifact
`nexus-backend-release-<sha>` containing `candidate-manifest.json`: the two
image digests, the expected Alembic revision and the expected Oracle manifest
digest.

The release resolves that artifact through `gh`, requires exactly one unexpired
copy, and requires its workflow run to be a `push` to `main` at that exact SHA
with `conclusion == success` and `run_attempt == 1`. It then re-proves the OCI
label and runtime identity of each pulled digest on the host. The manifest, the
digest and the image content are therefore bound to one another and to one CI
run that was never re-run.

Compose, the Caddyfile, the AppArmor profile and the boot-guard unit come from
the checkout, which preflight has already pinned to `origin/main == source-sha`.

## Explicit config publication

```bash
./deploy/hetzner/sync-env.sh
```

Concatenates `deploy/env/env-prod`, `env-prod-backend` and `env-prod-worker`
into the application config, validates shape and the required keys, and installs
it as `/etc/nexus/config/<sha256>.env` with `/etc/nexus/current.env` repointed by
an atomic rename. It publishes `deploy/env/env-prod-backup` the same way to
`/etc/nexus/backup-config/<sha256>.env` and `/etc/nexus/backup.env`. The four
`R2_BACKUP_*` keys are refused in the application config: only the backup job
may hold them.

Nothing restarts. The next release picks up whatever the pointers name. See
`deploy/env/README.md`.

## Release

```bash
VERCEL_TOKEN=... ./deploy/hetzner/deploy.sh <source-sha>
```

`deploy.sh` proves the checkout, selects the single `READY` production-target
Vercel deployment CI built for that exact SHA, and proves its staged
`/version` serves the SHA and this tree's player-protocol contract with
`Cache-Control: no-store`. It then runs the backend release, and only afterwards
promotes that exact deployment, assigns the custom domain, polls the alias until
it binds, and re-proves the public `/version`.

`deploy/hetzner/release.py` is the backend release, top to bottom:

1. **preflight** — ssh reachable; clean checkout at `origin/main`; candidate
   manifest resolved from the first CI run; Docker Engine, memory, swap and
   disk within the envelope; config pointers readable; Codex state mounted.
2. **inputs** — install `docker-compose.yml`, the AppArmor profile, the
   boot-guard script, its systemd unit and the `docker.service` drop-in; reload
   AppArmor and enable the boot guard.
3. **images** — pull both digests; prove the OCI revision label and the baked
   runtime identity against the manifest.
4. **backup** — read the current Alembic revision, prove it descends from the
   candidate head, stop `api`, `worker-interactive` and `worker-background`,
   then run `nexus.release_backup create`: one pass that streams `pg_dump`
   into a private R2 multipart upload, reads the remote bytes back through
   `pg_restore`, publishes a `database.json` recovery manifest beside the
   archive and prints the verified evidence.
5. **migrate** — `alembic upgrade head`, then re-read the revision.
6. **up** — `docker compose up --detach --wait`, then require every service
   healthy.
7. **caddy** — adapt the candidate Caddyfile through the running proxy, write
   it in place (the bind mount keeps its inode), `caddy reload`, and require
   the loaded config to equal the adapted candidate.
8. **health** — the API's private `/version` and `/readyz`; every application
   container running the manifest digest; one public `https://<api-host>/version`
   fetch that must serve the SHA with `Cache-Control: no-store`.
9. **isolation** — see below.
10. **current pointer** — write the SHA to `/var/lib/nexus/releases/current`.

Steps 4 and 5 are the ordered guarantee: writers stop, the dump is verified and
off-host, and only then does the schema move.

## Codex agent host isolation

The isolation is **declared**, not re-derived:

| Property | Declared in |
|---|---|
| non-root, read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, private pid/ipc, no ports | `deploy/hetzner/docker-compose.yml` |
| `apparmor=nexus-codex-agent-host`, `seccomp=unconfined`, `systempaths=unconfined` | same, plus `deploy/hetzner/nexus-codex-agent-host.apparmor` |
| internal, gateway-less private bridge; DNS to the egress proxy only | same, `networks.codex_private` |
| tmpfs layout, ulimits, cgroup limits, 45 s stop grace, `restart: "no"` | same |
| exactly one host mount: the credential file inside the LUKS volume | same |
| the credential underlay is closed before Docker starts | `codex-state-boot-guard.sh`, `nexus-codex-state-boot-guard.service`, `docker-codex-state-guard.conf` |
| `kernel.apparmor_restrict_unprivileged_userns=1` | `deploy/hetzner/cloud-init.yml` |

After start the release asserts that the declaration took effect: the boot guard
is enabled; `/srv/nexus/codex-state` is a mountpoint with `rw,nosuid,nodev,noexec`;
`nexus_codex_private` is internal, gateway-less and has exactly the agent host
and the egress proxy on it; the container reports the AppArmor profile, a
read-only rootfs, `CapDrop == [ALL]`, no added capabilities, not privileged, and
only that one network; its only non-volume mount is the credential file; and
`apps.codex_agent.network_health` proves the sandbox cannot reach the private
bridge, Postgres or Caddy.

Compose recreates a service whose declaration changed, so a limit or option
edited in `docker-compose.yml` is applied by the next release. Nothing reapplies
limits to a running container out of band.

## Verification

```bash
PYTHONPATH=python python3 deploy/hetzner/release.py --check
```

It reads the host's `current` pointer, runs preflight against that SHA, reports
each service's health, then runs the health and isolation proofs, collecting
every problem before it reports. Pass a SHA to additionally require that the
host records it.

It mutates nothing, but it is not passive: it `docker exec`s into `api`, `caddy`
and the Codex agent host, and it resolves that SHA's CI artifact through `gh`.
Once GitHub expires the artifact ninety days after the release, `--check`
stops working for it.

## Failure and recovery

Rerun `deploy/hetzner/deploy.sh <source-sha>`. Every step is idempotent: images
are content-addressed, the backup resumes from its receipt under
`/var/backups/nexus/r2/<sha>/`, `alembic upgrade head` is a no-op at head, and
`up --wait` converges. Nothing has to be unwound first.

Recovery is forward-only. If the candidate is bad, merge a fix and release the
new SHA. A restore of the R2 archive is a separately reviewed disaster-recovery
operation.

### database backup recovery

A verified archive is a recovery point, not an automatic rollback. Restoring it
discards writes made after that point. Keep the no-use window closed and review
the database, application SHA and schema together before any production restore.

First restore into an isolated disposable Postgres instance on a machine with
space for both the archive and the expanded database. Use the captured Postgres
image, including pgvector, and create the original database owner role. The
remote `database.json` recovery manifest binds the R2 endpoint, bucket, key,
expected sha256, byte count, database identity and starting revision. R2's
multipart ETag is not the archive's sha256.

Configure an S3 client profile named `nexus-backups` with region `auto` and the
operator-only credentials, without putting secrets in command arguments. Set
`BACKUP_ENDPOINT` and `BACKUP_BUCKET` from the retained operator config, then
download the desired release's recovery manifest:

```bash
umask 077
aws --profile nexus-backups --endpoint-url "$BACKUP_ENDPOINT" \
  s3api get-object --bucket "$BACKUP_BUCKET" \
  --key "releases/$SOURCE_SHA/database.json" recovery.json
jq . recovery.json
```

Require manifest schema `1` and its source SHA, endpoint, bucket and archive key
to match the selected release and destination. Set `BACKUP_KEY`,
`BACKUP_SHA256` and `BACKUP_BYTE_COUNT` from its evidence, then download and
check the archive:

```bash
umask 077
aws --profile nexus-backups --endpoint-url "$BACKUP_ENDPOINT" \
  s3api get-object --bucket "$BACKUP_BUCKET" --key "$BACKUP_KEY" recovery.dump
test "$(wc -c < recovery.dump | tr -d ' ')" = "$BACKUP_BYTE_COUNT"
printf '%s  %s\n' "$BACKUP_SHA256" recovery.dump | sha256sum --check
pg_restore --file=/dev/null recovery.dump
```

Proceed only after all three checks succeed. In a shell configured to connect
only to the isolated recovery instance, create a new database and restore it:

```bash
createdb nexus_backup_rehearsal
pg_restore --exit-on-error --dbname=nexus_backup_rehearsal recovery.dump
psql --dbname=nexus_backup_rehearsal --no-psqlrc --tuples-only \
  --command='SELECT version_num FROM alembic_version'
```

Require the recorded starting revision and inspect representative product rows
before treating the rehearsal as complete. Do not substitute this disposable
database for production, and do not start predecessor code against a migrated
database.

## Oracle publication

The release records nothing about Oracle. After the application SHA is current,
reconcile explicitly:

```bash
./deploy/hetzner/reconcile-oracle.sh
```

It reads the expected manifest digest from the running API's `/version`, exits
early if the corpus already publishes it, otherwise stops the writers, runs
`nexus.ops.oracle_reconcile` unpublish / reconcile-support / publish inside the
background worker, restarts the stack and re-proves the publication.

## Reader publication preflight

Offline reading identifies a reader document by its publication generation.
Revision `0219` creates one generation-`1` row per eligible `ready_for_reading`
document at the instant it runs; a document that becomes ready afterwards is
published by whichever application artifact is deployed. Before exposing the
first reading-capable APK — and, because it is idempotent, before every later
Android release — close that window explicitly:

```bash
python -m nexus.ops.reader_publication_preflight census   # read-only report
python -m nexus.ops.reader_publication_preflight rebuild  # publish the remainder
```

This is an application-data operation, not a release flag.

## Infrastructure operations

Postgres or Caddy image upgrades, host replacement, R2 policy changes and
provider configuration changes are separate reviewed operations, not release
flags. Postgres and Caddy images are pinned by digest in the published config;
changing one is a config publication followed by a release. Permanent R2 policy
owners are under `deploy/cloudflare/`; Vercel environment publication is
`deploy/vercel/sync-env.sh`.

Supabase Auth configuration (hosted refresh rotation and its reuse interval) is
no longer verified by the release. Review it in the Supabase dashboard when auth
settings change.

Retain verified R2 archives according to an explicit operator retention
decision. Garbage collection is not part of the release.

### orphaned host state

The attempt/resume protocol is gone. These paths are no longer read or written
and can be deleted by hand at any time:

```
/var/lib/nexus/releases/attempts/
/var/lib/nexus/releases/records/
/var/lib/nexus/releases/oracle-attempts/
/var/lib/nexus/releases/oracle-repairs/
/var/lib/nexus/releases/caddy-activation-backups/
/var/lib/nexus/releases/caddy-activation.json
/var/lib/nexus/releases/codex-capacity/
/var/lib/nexus/releases/forward-fix
/opt/nexus/releases/            # the per-SHA immutable bundles
/var/backups/nexus/*.dump       # pre-R2 local dumps
```

`/var/lib/nexus/releases/current` stays. Everything else above is residue.

## Owned files

| Concern | Owner |
|---|---|
| Pull-request check | `.github/workflows/ci.yml` |
| Backend publication | `.github/workflows/backend-images.yml` |
| Backend artifact | `docker/Dockerfile.backend` |
| Candidate manifest contract | `python/nexus/release_artifact.py` |
| Release | `deploy/hetzner/release.py` |
| Release entrypoint and frontend binding | `deploy/hetzner/deploy.sh` |
| Production topology and isolation | `deploy/hetzner/docker-compose.yml` |
| Codex credential-state boot guard | `deploy/hetzner/codex-state-boot-guard.sh`, `nexus-codex-state-boot-guard.service`, `docker-codex-state-guard.conf` |
| Codex AppArmor profile | `deploy/hetzner/nexus-codex-agent-host.apparmor` |
| API TLS and routing | `deploy/hetzner/Caddyfile` |
| Host provisioning | `deploy/hetzner/provision.sh`, `deploy/hetzner/cloud-init.yml` |
| VPS config publication | `deploy/hetzner/sync-env.sh` |
| Streamed database backup | `python/nexus/release_backup.py` |
| Vercel config publication | `deploy/vercel/sync-env.sh` |
| Oracle operation | `deploy/hetzner/reconcile-oracle.sh` |
| Environment contract | `deploy/env/README.md` and `deploy/env/*.example` |
