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
deployment, the API and worker image digests, and the expected Alembic revision.

## Non-negotiable rules

- `deploy/hetzner/deploy.sh <source-sha> [--model-cutover-snapshot <reviewed-json>]` is the only application release
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
`nexus-backend-release-<sha>` containing `candidate-manifest.json` (schema 3):
the two image digests and the expected Alembic revision.

The release resolves that artifact through `gh`, requires exactly one unexpired
copy, and requires its workflow run to be a `push` to `main` at that exact SHA
with `conclusion == success` and `run_attempt == 1`. It then re-proves the OCI
label and runtime identity of each pulled digest on the host. The manifest, the
digest and the image content are therefore bound to one another and to one CI
run that was never re-run.

Compose, the Caddyfile and the boot-guard unit come from
the checkout, which preflight has already pinned to `origin/main == source-sha`.

the universal-memory source repository is private; its installed python source
is included in these public images, as explicitly approved by the owner. keep
the public digest-access proof. repository privacy limits source acquisition,
not distribution of packaged runtime code.

builds fetch that repository over ssh with a read-only deploy key on it, titled
`nexus-web builds (read-only)`. a deploy key reads one repository: it cannot
push, reach any other repository or call the api. the GitHub Actions secret
`UNIVERSAL_MEMORY_DEPLOY_KEY` holds its private half. `scripts/with-memory-git`
takes the key's path in `UNIVERSAL_MEMORY_DEPLOY_KEY_FILE`, rewrites only
`https://github.com/NielsdaWheelz/universal-memory.git` to ssh through
process-scoped git configuration, and runs ssh with exactly that key against
github's host keys pinned in `scripts/github-known-hosts`. both workflows write
the secret, plus the final newline that `gh secret set` strips and OpenSSH
needs, to a 0600 file in the runner's temp directory and remove it once the
dependency install or the image builds finish. both backend build layers mount
that file as the required BuildKit secret `universal_memory_deploy_key`; it
never becomes a build argument, image layer, git or ssh configuration, cached
credential or runtime environment. local image builds pass the owner's github
ssh key instead: `--secret id=universal_memory_deploy_key,src=$HOME/.ssh/id_ed25519`.
ordinary local uv installs use authenticated git.

rotate the key by adding the new one before deleting the old:

```bash
dir="$(mktemp -d)"
ssh-keygen -q -t ed25519 -N '' -C 'nexus-web builds (read-only)' -f "$dir/key"
gh api repos/NielsdaWheelz/universal-memory/keys -f title='nexus-web builds (read-only)' \
    -f key="$(cat "$dir/key.pub")" -F read_only=true --jq .id
gh secret set UNIVERSAL_MEMORY_DEPLOY_KEY --repo NielsdaWheelz/nexus-web <"$dir/key"
rm -P "$dir/key" && rm -r "$dir"
gh api repos/NielsdaWheelz/universal-memory/keys --jq '.[] | [.id, .title, .created_at]'
gh api -X DELETE repos/NielsdaWheelz/universal-memory/keys/<old id>
```

if github rotates its ssh host keys, refresh `scripts/github-known-hosts` from
`gh api meta --jq .ssh_keys`.

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

when crossing migration 0246, supply the reviewed model-history census:

```bash
VERCEL_TOKEN=... ./deploy/hetzner/deploy.sh <source-sha> \
  --model-cutover-snapshot "/private/operator/reviewed census.json"
```

the snapshot is a readable file on the caller's machine; relative paths resolve
from the caller's working directory. the wrapper forwards only this declared
input. the backend controller parses and validates the whole reviewed input once
before any external work. it checks the actual
starting revision during release, then compares reviewed identities with a fresh
census after writers and the native host stop. a matching census does not
authorize abandoning uncertain
work or replace the verified backup and migration gates. the option is required
only when the database crosses 0246; ordinary releases retain the first command.

`deploy.sh` proves the checkout, selects the single `READY` production-target
Vercel deployment CI built for that exact SHA, and proves its staged
`/version` serves exactly `{"source_sha": <sha>}` with
`Cache-Control: no-store`. It then runs the backend release, and only afterwards
promotes that exact deployment, assigns the custom domain, polls the alias until
it binds, and re-proves the public `/version`.

`deploy/hetzner/release.py` is the backend release, top to bottom:

1. **preflight** — ssh reachable; clean checkout at `origin/main`; candidate
   manifest resolved from the first CI run; Docker Engine, memory, swap and
   disk within the envelope; config pointers readable; Codex state mounted.
2. **inputs** — install `docker-compose.yml`, the boot-guard script, its
   systemd unit and the `docker.service` drop-in; enable the boot guard.
3. **images** — pull both digests; prove the OCI revision label and the baked
   runtime identity against the manifest.
4. **backup** — read the current Alembic revision, prove it descends from the
   candidate head (crossing 0262: stop `api` first and wait, up to 20 minutes,
   until the old workers have finished every oracle job), stop `api`,
   `worker-interactive` and `worker-background`,
   then stop the codex host with at least 45 seconds of grace and require clean
   exit from every writer and host before running
   `nexus.release_backup create`: one pass that streams `pg_dump`
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

### reviewed model-history reset

crossing 0246 requires the optional input above. this is one current, strict
`ReviewedModelCutover` contract in `python/nexus/model_cutover_archive.py`.
`python -m nexus.model_cutover_preflight --snapshot` prints a read-only starting
census; it grants no disposal authority. keep the no-use window closed through
this finite operator sequence:

1. drain admissions and stop all writers and the native host cleanly. preserve
   all original unknown provider outcomes; remote calls may still bill.
2. collect a fresh exact starting census. take a fresh backup with the existing
   `nexus.release_backup create` owner for the chosen target sha, source database
   identity and actual revision. a 0230/0236 receipt cannot qualify a 0241 reset.
3. actually restore those exact bytes in an isolated postgres/pgvector copy
   and replay the whole chain to the target head under the draft input (below).
   archive traversal alone is insufficient; a preliminary live dump is not this
   final drained backup.
4. review the complete input: deployed and target source shas, source database
   identity/revision, all ordered row hashes, exact null-parent abandonment,
   exact orphan-parent acknowledgement, every frozen/metadata job retirement,
   exact acknowledgement of terminal jobs whose memo names a parent absent from
   `llm_calls` (`retire_dangling_job_ids`), reviewer, `BackupEvidence`, and the
   small actual-restore attestation bound to the backup/census/target head and
   the qualification receipt hash.
5. use the aligned release command with that input. it rejects incomplete or
   stale authority, rechecks the complete census and existing archive bytes,
   then supplies typed alembic `Config.attributes` authority. the entry hook,
   effect preservation, archival audit, queue-claim retirement and entire reset
   share the existing migration transaction. any later refusal rolls back all
   of them. the production cli has no restored-copy identity override.

the census includes settled and unknown parents, model turns, continuations,
positions, all chat runs, generation-bearing jobs of every status and every
metadata job, leases, original memos/replay grants, authorship/tool-call refs,
workspace state, affected bibliography/credits/manual author pins and reader
publication identity. originals remain in the verified backup. missing original
write ownership or unfinished write effects block; acknowledged orphan parents
receive no fabricated owner, terminal or executable authority. completed write
receipts remain inspectable and undoable after history deletion.

a terminal (`succeeded` or `dead`) job may name a parent that never reached
`llm_calls`: the 7dc68929b metadata path wrote its would-be generation id into a
`Completed` memo when it refused before dispatch (`source_changed`); #547
removed that path. each such job is acknowledged by id. an unacknowledged or
unfinished one refuses, and so does an acknowledged job whose parent exists.
read the set from the frozen database, not from an earlier census.

one `model_cutover_archives` row records the reviewed disposition and both source
and execution database identities. `restore.target_revision` is the candidate's
head; the release and the archive cli require equality. ordinary releases retain
the existing backup and plain migration path. post-reset 0256 databases gain
receipt/audit storage through 0257; 0256's metadata uncertainty barrier stays
intact.

#### restored-copy qualification

`deploy/hetzner/qualify_model_cutover.py` is step 3. it is one-time tooling:
delete it with the model-cutover code once production reads head. download and
check `database.dump` as in [database backup recovery](#database-backup-recovery),
then write the draft: the census from step 2, the four disposition lists read
from the same frozen database, `reviewer`, the `BackupEvidence`, and a `restore`
block naming the target sha and head with a placeholder
`restored_database_identity` (any text but the source identity) and
`receipt_sha256` (64 zeros). from a clean checkout at the target sha:

```bash
PYTHONPATH=python uv run --project python --frozen --no-sync python \
  deploy/hetzner/qualify_model_cutover.py recovery.dump draft.json qualification/ \
  --image "$POSTGRES_IMAGE"
```

it refuses a dump whose bytes differ from the draft's backup evidence, restores
it into a disposable container of the production postgres image (database and
owner role named as in the source identity; removed on exit), writes
`restored-census.json`, counts every table's rows, then runs `alembic upgrade
head` in one transaction through the trusted migration interface, with the
restored copy as the execution database and the draft's original census. the
entry hook proves the census and dispositions; every data-dependent guard from
0242 to head then runs on the real rows. a refusal prints the cause and leaves
the copy at its starting revision. success writes `receipt.json` (backup and
census hashes, both identities, revisions reached, unconverted browser captures,
row counts before and after per table) and `reviewed.json`: the draft with the
restored identity and the receipt hash filled in. review that file and the
receipt's losses; it is the release's `--model-cutover-snapshot` input. the
release itself still runs the browser-capture conversion and the health
checks.

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
each service's health, then runs the health and isolation proofs, collecting
every problem before it reports. Pass a SHA to additionally require that the
host records it.

It mutates nothing, but it is not passive: it `docker exec`s into `api`, `caddy`
and the Codex agent host, and it resolves that SHA's CI artifact through `gh`.
Once GitHub expires the artifact ninety days after the release, `--check`
stops working for it.

## Failure and recovery

rerun the same release command while its starting revision still crosses 0246.
after the reviewed reset commits, omit `--model-cutover-snapshot`; the audit row
records that disposition and the input no longer names the current revision.
every step is idempotent: images
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

## Oracle corpus seed

The release records nothing about the Oracle. After a release that changes
`python/nexus/services/oracle/corpus.json`, or to heal failed passage anchors,
run the seed once inside the running background worker, with the production
owner's user id:

```bash
ssh nexus@5.78.194.235 'sudo docker exec "$(sudo docker ps --quiet \
  --filter label=com.docker.compose.project=nexus \
  --filter label=com.docker.compose.service=worker-background \
  --filter label=com.docker.compose.oneoff=False)" \
  python -m nexus.services.oracle.corpus seed --owner-user <uuid>'
```

It is idempotent and safe while every writer runs: it converges the corpus
library, sources and anchors to the file and prints its counts; ordinary
workers ingest and index, and the next reading resolves the anchors. See
[docs/modules/oracle.md](docs/modules/oracle.md).

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
| API TLS and routing | `deploy/hetzner/Caddyfile` |
| Host provisioning | `deploy/hetzner/provision.sh`, `deploy/hetzner/cloud-init.yml` |
| VPS config publication | `deploy/hetzner/sync-env.sh` |
| Streamed database backup | `python/nexus/release_backup.py` |
| Restored-copy qualification of the 0246 reset (one-time) | `deploy/hetzner/qualify_model_cutover.py` |
| Vercel config publication | `deploy/vercel/sync-env.sh` |
| Oracle corpus seed | `python/nexus/services/oracle/corpus.py` (`seed`) |
| Environment contract | `deploy/env/README.md` and `deploy/env/*.example` |
