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
| api tls and public ingress | cloudflare edge and named outbound tunnel; private caddy http |

Public hosts are `nexus.nielseriknandal.com` (frontend) and
`nexus-api.nielseriknandal.com` (api). the vps is `nexus-api-worker`, administered
as `nexus@nexus-prod` over tailscale. its public address is transport only;
provider and host firewalls admit only tailscale's encrypted udp transport.

`deploy/cloudflare/tunnel-config.json` owns the public route and
`deploy/cloudflare/api-rules.json` owns api-only waf/cache behavior. visitors use
the public website normally. the shared fleet grants policy belongs to
`dev-server`; production receives operator ssh but no peer application access.

The release identity is one full lowercase Git `source_sha`. It binds the Vercel
deployment, the API and worker image digests, and the expected Alembic revision.

## Non-negotiable rules

- `deploy/hetzner/deploy.sh <source-sha>` is the only application release
  entrypoint. It converges the backend and then binds the frontend.
- The release is **linear and idempotent**. There is no attempt state, no
  resume mode and no rollback settlement: after a failure, repair the named
  cause and rerun the same command. The only durable release state on the host
  is `/var/lib/nexus/releases/current`.
- a release requires a clean checkout where `HEAD == source-sha`, with that
  commit an ancestor of the freshly fetched `origin/main`.
- the images deployed come from attempt **1** of a `main` or `release/` branch
  push for that exact SHA. `backend-images.yml` publishes only under `github.run_attempt == 1`,
  and the release refuses a run whose `run_attempt` is not 1. A rerun therefore
  cannot produce a deployable candidate: merge a new commit instead.
- a push that changes only `docs/**` or the top-level markdown files builds no
  images, so that commit cannot be released: release the newest commit that has them.
- Production pulls GHCR digests named by the candidate manifest. It never
  builds an application image.
- Config publication (`sync-env.sh`) and the Oracle corpus seed are explicit,
  separate operations. The release neither performs nor waits for them.
- There is no automatic database downgrade. After the migration runs, recovery
  moves forward; the verified R2 archive is a recovery point, not a rollback.
- Secrets belong only in provider settings and unpublished env inputs. They
  never belong in command arguments or logs.

## Operator prerequisites

Install the repository's locked dependencies and authenticate `gh`, SSH and
Vercel. the release needs `curl`, `gh`, `git`, `jq`, `python3`, `scp`, `ssh`,
`timeout`, `uv`, the installed locked backend environment at `python/.venv`,
and the locked vercel cli under `apps/web/node_modules`. the controller uses
`uv run --frozen --no-sync`; a release never creates or updates dependencies.

```bash
export VERCEL_TOKEN=<vercel-token>
```

`gh` supplies GitHub credentials; ssh to `nexus@nexus-prod` must be
non-interactive with passwordless `sudo` on the host.

production coordinates are committed, not ambient: ssh `nexus@nexus-prod`,
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
1900 MiB of physical memory, 1 GiB of swap, 256 MiB of available memory and
2 GiB free under `/`.
preflight measures each of these; after application and connector image pulls, the release
requires the same 2 gib disk reserve again before stopping writers.
Vercel custom-domain auto-assignment must stay
disabled and Vercel Authentication must protect previews only, so the staged
production-target deployment is publicly probeable before promotion.

the api has a 384 MiB memory ceiling with container swap disabled. the eight
service ceilings total 2352 MiB; these are independent limits, not reserved
host ram. the 2 GiB host must be qualified against the actual concurrent working
set, cache reclaim, memory pressure and request completion. summing separate
historical peaks does not establish that workload's demand; a passing preflight
does not establish its capacity. swap does not count toward physical memory or
the available-memory floor.

the eight long-lived services belong to `system-nexus.slice` under
`system.slice`. its persistent `MemorySwapMax=0` enforces no-swap for their
whole subtree, including when a runtime reload resets a container's leaf limit
to `max`. each container keeps its own declared memory ceiling; the slice adds
no aggregate memory cap or cpu/i/o weight. grouping them creates one sibling
in the host's resource hierarchy, so capacity qualification still uses the
actual workload. backup and migration one-offs retain their separate compose
limits and are outside this eight-service proof.

postgres has a 512 MiB ceiling with container swap disabled. its startup command
sets `shared_buffers=64MB`, budgeting 64 MiB of shared database cache within that
ceiling alongside backend processes, shared-memory bookkeeping and file cache.
shared buffers become resident as queries fill them and cannot be reclaimed
without swap. the smaller cache can increase database i/o; qualification must
verify concurrent requests complete within their existing deadlines on the
2 GiB host.

## Immutable artifact lineage

on a qualifying push to `main` or `release/**`, `.github/workflows/backend-images.yml`
builds postgres, api and worker images once and pushes them to ghcr. it proves
all three `org.opencontainers.image.revision` labels and both application
`/app/runtime-identity.json` files agree with the source sha, and uploads one artifact
`nexus-backend-release-<sha>` containing `candidate-manifest.json` (schema 3):
the two application image digests and the expected Alembic revision. beside
that unchanged manifest, `postgres-image.txt` records the postgres digest and
`postgres-runtime-proof.txt` records its pg15/package/control checks and binary
hashes. review that digest, set the existing `POSTGRES_IMAGE` input, and publish
it through `sync-env.sh` before release; publishing does not restart postgres.

the first postgres publication waits at most 300 seconds for anonymous digest
access. if the new package is private, its owner must make it public at the
workflow's printed package settings url. failure preserves the first-attempt
rule: repair visibility and publish a fresh source commit, never rerun it.

backend publication uses a fresh github-hosted `ubuntu-24.04` linux/x64 vm
per job. devbox labs, rehearsal data and retained images cannot consume its
build capacity. hosted-runner availability and quota govern scheduling; local
build cache does not survive the job. pr static checks remain self-hosted.

before creating a builder, publication requires at
least 8 gib free at the actual docker data root and runner temp directory. this
floor follows the historical api/worker observation of 3.5 gb build state,
2.05 gb of runtime images and roughly 3 gb of additional scratch and runner
output. those measurements exclude the added postgres build and are lower
bounds; the floor does not guarantee the three-image publication's peak.
after both builds, the workflow removes only its own
builder and cache before pulling the published images. build summaries and
local build-record export are disabled; image provenance and sboms remain.
insufficient space refuses publication without host-wide pruning. qualify hosted
capacity against the actual publication; a failed run still requires a fresh
source commit under the same first-attempt rule.

The release resolves that artifact through `gh`, requires exactly one unexpired
copy, and requires its workflow run to be a `push` to `main` or a `release/`
branch at that exact SHA
with `conclusion == success` and `run_attempt == 1`. It then re-proves the OCI
label and runtime identity of each pulled digest on the host. The manifest, the
digest and the image content are therefore bound to one another and to one CI
run that was never re-run.

Compose, the Caddyfile, the resource slice, the boot-guard unit and the nightly
backup units come from the checkout, which preflight pins to
`HEAD == source-sha` and proves is in `origin/main` history.

the universal-memory source repository is public. dependency installation in
ci and backend images fetches its locked revision over https without credentials.
its installed python source is included in the public images; keep the anonymous
digest-access proof. dependency acquisition is separate from the optional private
runtime memory-client declaration.

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

for owner-chat shared memory, pass the central private nexus `client.json` as
`NEXUS_MEMORY_CLIENT_CONFIG` to that publisher. it validates and publishes a
content-addressed private json file before capturing its path in the application
env. omission publishes the closed absent declaration. only the api and
interactive worker receive the read-only mount; the configured viewer and
complete processor chain still govern every send, rerun and regenerate. this
publication neither admits native capture lanes nor captures nexus chats.

## Release

```bash
VERCEL_TOKEN=... ./deploy/hetzner/deploy.sh <source-sha>
```

`deploy.sh` proves the checkout, selects the single `READY` production-target
Vercel deployment CI built for that exact SHA, and proves its staged
`/version` serves exactly `{"source_sha": <sha>}` with
`Cache-Control: no-store`. It then runs the backend release, and only afterwards
promotes that exact deployment, assigns the custom domain, polls the alias until
it binds, and re-proves the public `/version`.

`deploy/hetzner/release.py` is the backend release, top to bottom. it holds the
host backup lock from before preflight until it exits (see
[database backups](#database-backups)):

1. **preflight** — ssh reachable; clean checkout at the requested commit in `origin/main` history; candidate
   manifest resolved from one first-attempt push; Docker Engine, memory, swap and
   disk within the envelope; config pointers readable; Codex state mounted.
2. **inputs** — install `docker-compose.yml`, `system-nexus.slice`, the boot-guard
   script, its systemd unit, the `docker.service` drop-in and the nightly backup
   script, service and timer; give the backup one-off (uid 10001) the receipt
   root `/var/backups/nexus/r2`; reload systemd, enable the boot guard, enable
   and start the nightly timer and start the resource slice.
3. **images** — pull both application digests; prove the oci revision label and
   baked runtime identity against the manifest. pull the configured immutable
   postgres image and pinned connector, prove
   its non-root credential access, and require 2 gib free under `/` again.
   validate/install private caddy configuration before service recreation.
4. **backup** — read the current Alembic revision, prove it descends from the
   candidate head, stop `api`, `worker-interactive` and `worker-background`,
   then stop the codex host with at least 45 seconds of grace and require exit 0
   from every writer and host before running
   `nexus.release_backup create --backup-key releases/<candidate-sha>/database.dump`:
   one pass that streams `pg_dump`
   into a private R2 multipart upload, reads the remote bytes back through
   `pg_restore`, publishes a `database.json` recovery manifest beside the
   archive and prints the verified evidence.
5. **postgres** — with writers still stopped and the backup verified, converge
   only postgres from the configured immutable image using `up --no-deps --wait`.
   require that exact image, pg15, preloaded `pg_search` and available version
   `0.26.2`; require unchanged database identity and current revision across
   recreation. a rerun compares the live revision, not its older backup receipt.
   the extension catalog may be absent until migration creates it. retain the
   existing volume and require the actual 512 mib/no-swap ceiling, 64 mib shared
   buffers and 128 mib shared memory before migration.
6. **migrate** — `alembic upgrade head`, then re-read the revision. migration
   0317 checks the exact extension catalog and binary versions.
7. **up** — `docker compose up --detach --wait`, then require every service
   healthy. prove the persistent parent unit/property and kernel swap max/current
   are zero, all eight actual process cgroups descend from it, and each actual
   memory cap matches compose with zero swap usage. report the leaf swap limit
   separately; a leaf `max` does not override the parent's zero.
8. **caddy** — reload the already installed candidate and require the loaded
   config to equal the adapted candidate.
9. **health** — the API's private `/version` and `/readyz`; every application
   container running the manifest digest; one public `https://<api-host>/version`
   fetch that must serve the SHA with `Cache-Control: no-store`.
10. **isolation** — see below.
11. **current pointer** — write the SHA to `/var/lib/nexus/releases/current`,
    then, if step 4 took a backup, prune expired archives. a failed release
    prunes nothing; a failed prune is reported and leaves the release standing.

steps 4–6 are the ordered guarantee: writers stop, the dump is verified and
off-host, postgres prerequisites converge, and only then does the schema move.

## Database backups

an archive is any `<prefix>/database.dump` in the private backup bucket, with
its `database.json` recovery manifest beside it: `releases/<sha>/` from step 4,
`nightly/<utc date>/` from the nightly job, `maintenance/...` from an operator.
all take `nexus.release_backup create`'s one path (stream, read back, publish
the manifest). loss on host failure is bounded by a day, not by the last release.

**nightly.** `nexus-nightly-backup.timer` fires at 11:00 utc, the owner's night (`Persistent=true`
catches up after downtime) and runs `deploy/hetzner/nightly-backup.sh` as
`/usr/local/sbin/nexus-nightly-backup`. it requires the running api image's
revision label to equal `/var/lib/nexus/releases/current`, then runs that
image's `backup` one-off as `nexus.release_backup nightly` with writers up:
`pg_dump` reads one snapshot. the key is the utc date, so a same-day rerun
resumes or verifies the recorded archive. it refuses while a failed release
leaves another image running; finish that release.

**lock.** a `pg_dump` during a migration blocks its ddl or fails, so the
nightly and the release share `/run/lock/nexus-backup.lock`. the release holds
it in one ssh session for its whole run, waiting up to 45 minutes for a
nightly (systemd bounds one at 40). a nightly that finds it held logs
`a release holds ...; skipping this backup` and exits 0. an operator
maintenance backup should hold it too.

**retention.** age is r2's `LastModified` of the `.dump`. after its own backup
verifies, each caller keeps every archive younger than seven days plus the
newest one at least seven days old, and deletes the rest: receipt, then
manifest, then `.dump`, so an interrupted prune finishes next time. a stray
`database.json` stays; maintenance archives age out like any other. keeping
the young archives is what refreshes the aged one, so nightly backups hold it
at seven to eight days with about eight archives (~10 gb). a count rule would
let a burst of releases evict the week-old copy that catches late-noticed
damage; this one spends a week of storage instead. the backup credentials
cannot manage r2 lifecycle rules, so retention is code.

**receipts.** under `/var/backups/nexus/r2`, owned by the backup one-off:
`<sha>/` for `releases/<sha>`, `nightly/<date>/` for `nightly/<date>`. a rerun
resumes from its receipt, so a prune removes only the receipts of archives it
deletes. maintenance receipts, and receipts of archives deleted by hand, stay.

**freshness.** `release.py --check` reports the newest archive's key and age;
once the timer is enabled it fails past 36 hours. nothing else monitors backups.

```bash
systemctl list-timers nexus-nightly-backup.timer
journalctl -u nexus-nightly-backup.service --since -2days
sudo systemctl start nexus-nightly-backup.service   # run now
```

## Codex agent host isolation

The isolation is **declared**, not re-derived:

| Property | Declared in |
|---|---|
| non-root, read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, private pid/ipc, no ports | `deploy/hetzner/docker-compose.yml` |
| default docker apparmor/seccomp confinement | same |
| internal, gateway-less private bridge whose only other member is the egress proxy | same, `networks.codex_private` |
| egress allowlist `chatgpt.com:443`, `auth.openai.com:443`: names pinned with `extra_hosts`; stock nginx forwards only those SNIs | same, `x-codex-egress-conf`, `codex-egress-policy` |
| tmpfs layout, ulimits, cgroup limits, 45 s stop grace, `restart: on-failure:3` | same |
| exactly one host bind: the private account directory inside the LUKS volume | same |
| uid/gid 10001; shared native socket volume `0700`, socket `0600`; workers receive no account state | same; `docker/Dockerfile.backend` |
| the credential underlay is closed before Docker starts | `codex-state-boot-guard.sh`, `nexus-codex-state-boot-guard.service`, `docker-codex-state-guard.conf` |
| `kernel.apparmor_restrict_unprivileged_userns=1` | `deploy/hetzner/cloud-init.yml` |

After start the release asserts that the declaration took effect: the boot guard
is enabled; `/srv/nexus/codex-state` is a mountpoint with `rw,nosuid,nodev,noexec`;
`nexus_codex_private` is internal, gateway-less and has exactly the agent host
and the egress proxy on it; the container reports default docker apparmor, a
read-only rootfs, `CapDrop == [ALL]`, no added capabilities, not privileged, and
only that one network; and its only host bind is the account directory. the
host's only network peer is the proxy, so what it can reach is the proxy's
declared policy; the release does not probe it, the codex host harness proves
it behaves (allowlisted names reachable; other names, private addresses and the
proxy's other ports not). native portable callbacks run in the worker; the host
has no application-service authority.

Compose recreates a service whose declaration changed, so a limit or option
edited in `docker-compose.yml` is applied by the next release. Nothing reapplies
limits to a running container out of band.

## Verification

```bash
PYTHONPATH=python uv run --project python --frozen --no-sync python deploy/hetzner/release.py --check
```

It reads the host's `current` pointer, runs preflight against that SHA, reports
each service's health, then runs the health, resource-limit and isolation proofs, collecting
every problem before it reports. Pass a SHA to additionally require that the
host records it.

It mutates nothing, but it is not passive: it `docker exec`s into `api`, `caddy`
and the Codex agent host, runs one `backup` one-off that lists the backup
bucket, and it resolves that SHA's CI artifact through `gh`.
Once GitHub expires the artifact ninety days after the release, `--check`
stops working for it.

## Failure and recovery

every step is idempotent: images
are content-addressed, the backup resumes from its receipt under
`/var/backups/nexus/r2/<sha>/`, `alembic upgrade head` is a no-op at head, and
`up --wait` converges. Nothing has to be unwound first.

Recovery is forward-only. If the candidate is bad, merge a fix and release the
new SHA. A restore of the R2 archive is a separately reviewed disaster-recovery
operation.

### fresh maintenance backups

`nexus.release_backup create` and `verify` require `--backup-key`: a literal
relative object key, at most 1024 ascii bytes, with nonempty safe path segments
and the exact final `/database.dump`. dot and dot-dot segments, leading slash,
backslash and control characters are refused. the recovery manifest is the
adjacent `database.json`; the existing evidence key identifies the backup.
`--source-sha` records the associated release: the canonical controller keeps
its candidate sha, including for a pre-migration backup of an older runtime.
this maintenance snapshot uses the accepted deployed sha.

a new snapshot requires both a new archive key under `maintenance/` and a fresh
local state directory. reusing a receipt resumes/verifies its original archive,
even after database changes. a different key with that receipt, or a completed
archive without its receipt, refuses. never write a release or nightly key; do
not invent a source sha or repeat the release controller to take a later backup.
retention prunes maintenance archives by the same rule as the others.

use the existing backup container capability and resource limits. a reviewed
operator-only correction can run as `python /maintenance/release_backup.py`
with that exact public file mounted read-only in the unchanged api dependency
image. bind its commit/file hash, image digest and actual database identity and
revision separately; do not replace installed modules or change application
source metadata. the operator still needs the private backup and postgres
inputs, an explicit writer disposition and execution admission. archive
verification does not claim an actual restore.

the isolated qualification used the exact public operator file (`20267776`) in
the unchanged fdd api image: two rehearsal snapshots at one associated source
restored the expected different fixture rows; replay and three refusal cases
left the original archives/manifests unchanged. retained actual receipt:
`c-sources/fresh-maintenance-backup-proof-v1/green-v1/completion-receipt.json`
(`8e003e40`), independently reviewed by `5621496e`. this establishes the
bounded mechanism, not a production backup
or a full nexus restore.

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
operator-only credentials, without putting secrets in command arguments. set
`BACKUP_ENDPOINT` and `BACKUP_BUCKET` from the retained operator config and
`BACKUP_KEY` from the chosen backup receipt. download its adjacent manifest:

```bash
umask 077
aws --profile nexus-backups --endpoint-url "$BACKUP_ENDPOINT" \
  s3api get-object --bucket "$BACKUP_BUCKET" \
  --key "${BACKUP_KEY%/database.dump}/database.json" recovery.json
jq . recovery.json
```

Require manifest schema `1` and its source SHA, endpoint, bucket and archive key
to match the selected associated release and backup destination. set `BACKUP_SHA256`
and `BACKUP_BYTE_COUNT` from its evidence, then download and
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

## Oracle corpus seed

The release records nothing about the Oracle. After a release that changes
`python/nexus/services/oracle/corpus.json`, or to heal failed passage anchors,
run the seed once inside the running background worker, with the production
owner's user id:

```bash
ssh nexus@nexus-prod 'sudo docker exec "$(sudo docker ps --quiet \
  --filter label=com.docker.compose.project=nexus \
  --filter label=com.docker.compose.service=worker-background \
  --filter label=com.docker.compose.oneoff=False)" \
  python -m nexus.services.oracle.corpus seed --owner-user <uuid>'
```

It is idempotent and safe while every writer runs: it converges the corpus
library, sources and anchors to the file and prints its counts; ordinary
workers ingest and index, and the next reading resolves the anchors. See
[docs/modules/oracle.md](docs/modules/oracle.md).

## Gutenberg catalog sync

The Project Gutenberg catalog mirror is refreshed on demand, never by a worker.
Run it in a one-off `migration` container (the API image, 512 MiB, its own
cgroup), not inside `worker-background`, whose 448 MiB belongs to its job child:

```bash
ssh nexus@nexus-prod 'sudo env API_IMAGE=<deployed api digest> \
  WORKER_IMAGE=<deployed worker digest> NEXUS_CONFIG_FILE=/etc/nexus/current.env \
  docker compose --project-name nexus --env-file /etc/nexus/current.env \
  --file /etc/nexus/docker-compose.yml --profile release \
  run --rm --no-deps --no-TTY migration nexus sync-gutenberg-catalog'
```

It downloads the feed, reconciles the mirror in one transaction, and prints its
result (`row_count`, `source_url`); it is safe while every writer runs.

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

R2 archive retention is the rule in [database backups](#database-backups);
deleting archives outside it is a reviewed operator decision.

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
| Nightly backup | `deploy/hetzner/nightly-backup.sh`, `nexus-nightly-backup.service`, `nexus-nightly-backup.timer` |
| api public tls, routing and waf/cache | `deploy/cloudflare/tunnel-config.json`, `deploy/cloudflare/api-rules.json` |
| private api proxy | `deploy/hetzner/Caddyfile` |
| Host provisioning | `deploy/hetzner/provision.sh`, `deploy/hetzner/cloud-init.yml` |
| VPS config publication | `deploy/hetzner/sync-env.sh` |
| Streamed database backup and retention | `python/nexus/release_backup.py` |
| Vercel config publication | `deploy/vercel/sync-env.sh` |
| Oracle corpus seed | `python/nexus/services/oracle/corpus.py` (`seed`) |
| Environment contract | `deploy/env/README.md` and `deploy/env/*.example` |
