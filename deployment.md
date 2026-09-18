# Production deployment

This is the sole production runbook. Nexus uses a planned no-use window and one
human-triggered release protocol. Do not mutate production Compose services,
release state, or Vercel aliases outside the owners named here.

## Production shape

| Capability | Production owner |
|---|---|
| Frontend and BFF | Vercel project `nexus-web` |
| API, interactive worker, background worker | Hetzner Compose project `nexus` |
| Product database | Hetzner Postgres with pgvector |
| Object storage | Cloudflare R2 |
| Authentication | Supabase Auth only |
| API TLS | Caddy on the Hetzner host |

authentication configuration remains a deployment invariant. before release
mutation, `deploy/supabase/verify-auth-config.sh` checks hosted refresh rotation
and its ten-second reuse interval. synthetic auth smoke and capacity canaries
are removed; release admission retains runtime health, readiness, identity,
resource limits, and migration backup checks.

Current public hosts are `nexus.nielseriknandal.com` and
`api.nexus.nielseriknandal.com`. The VPS is `nexus-api-worker` at
`5.78.194.235`.

The release identity is one full lowercase Git `source_sha`. It binds the web
deployment, API image digest, worker image digest, expected Alembic revision,
expected Oracle manifest digest, task contract, and captured VPS config.

## Non-negotiable rules

- `deploy/hetzner/deploy.sh <source-sha> [--no-database-backup]` is the only
  application release entrypoint. Rerun it unchanged to resume.
- new candidates require a clean checkout where `HEAD == origin/main == source-sha`
  and the exact sha's immutable backend bundle exists. replay requires clean
  `HEAD == source-sha` and the installed immutable bundle.
- The post-merge publisher builds each backend target once. Production pulls
  manifest-selected GHCR digests and never builds an application image.
- Vercel produces a `READY` production-target candidate with no production or
  custom-domain alias. Vercel-generated `.vercel.app` aliases are expected;
  backend activation and proof precede promotion of that exact deployment ID.
  The controller explicitly assigns the committed custom domain to that exact
  deployment and proves the binding through Vercel's alias resource plus the
  public no-store `/version` contract.
- application activation owns `api`, `worker-interactive`, `worker-background`,
  `codex-egress-policy`, and `nexus-codex-agent-host`. it does not recreate
  postgres or caddy.
- Config publication and Oracle reconcile are explicit operations. Application
  release neither performs nor waits for them.
- Never edit an attempt, record, pointer, backup, bundle, or content-addressed
  config. Never manually select another Vercel candidate during resume.
- There is no automatic database downgrade or post-commitment rollback. After
  database mutation or backend activation begins, recovery moves forward.
- Secrets belong only in provider settings and unpublished env inputs. They
  never belong in release state, command arguments, or logs.

## Operator prerequisites

Install the repository's locked dependencies and authenticate `gh`, SSH, and
Vercel. The release protocol requires `awk`, `cmp`, `curl`, `find`, `gh`, `git`,
`grep`, `jq`, `python3`, `scp`, `sort`, `ssh`, `timeout`, and the locked Vercel
CLI under `apps/web/node_modules`.

Set only provider credentials:

```bash
export GH_TOKEN=<github-token>
export VERCEL_TOKEN=<vercel-token>
export SUPABASE_MANAGEMENT_ACCESS_TOKEN=<supabase-management-token>
```

`SUPABASE_MANAGEMENT_ACCESS_TOKEN` is required before any release mutation:
`deploy/supabase/verify-auth-config.sh` proves hosted refresh rotation with it,
and the release blocks without it. It is never read from synced runtime env
files.

Production coordinates are committed, not ambient: SSH
`nexus@5.78.194.235`, web `nexus.nielseriknandal.com`, Vercel project
`nexus-web` / `prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs`, and team
`niels-erik-nandals-projects` / `team_fKVvTyTsMBQ7qFjccFO17BJL`. Changing any
coordinate is a reviewed infrastructure change, not a release flag.

The interactive worker has a 320 MiB memory ceiling and 128 MiB reservation,
with no swap. Restored generation composition measured about 246 MiB before job
allocations; its former 256 MiB ceiling was insufficient. The extra 64 MiB is
possible worker demand within the existing server, not a server resize.
observe representative work manually when investigating memory demand.

The API image proxy retains at most 16 MiB of cached bodies and runs at most two
fetch-and-transfer operations at once; further requests wait before thread/client allocation. It
checks response headers before reading and caps each streamed image at 10 MiB.
An upstream ignoring `Accept-Encoding: identity` is rejected. Smaller caches
mean more refetching, and slow image consumers delay queued images. Each operation
keeps its slot through response transfer and sends at most 64 KiB per write, so
socket backpressure applies between chunks. These bounds do not cover every API
allocation. manually observe simultaneous reader use when investigating api
memory demand. Viewer lookup runs on the event loop; it does
not dispatch an otherwise empty worker thread for every image. Image clients
share the verified TLS trust store, while cookies and connection pools remain
per fetch. Image metadata and integrity use one explicitly closed decoder.
Chat and Dossier admission do not import the worker-owned MCP server; the two
Codex execution paths import their binding when they run in the worker.
Semantic search loads the embedding SDK without generation engines. The pinned
provider runtime constructs those engines on first generation use; this keeps
the embedding credential, retry and response contracts intact. The required
OpenAI SDK and actual query allocations still consume API memory.
Fragment search ranks metadata, then reads excerpts and full locators for the
selected page. Those selected quotes still count toward response memory.
Revision0230 adds the evidence-span full-text index without rewriting source
rows. Its32-MiB maintenance workspace belongs to Postgres, not the migration
container; observe both container budgets during the build.

The API artifact fixes glibc allocation arenas at two and the mmap/trim
thresholds at 128 KiB. Large freed buffers can return to the operating system
instead of raising the allocator's adaptive retention threshold. This trades
allocator contention and more mapping/system calls for less retained memory;
it does not bound live allocations or increase the 320 MiB container cap.
See the [glibc allocation contract](https://sourceware.org/glibc/manual/latest/html_node/Malloc-Tunable-Parameters.html).

The API healthcheck uses a direct curl process. Release HTTP proofs run on the
host against the API's inspected private address; they never start another
Python interpreter inside its cgroup. This also proves older predecessor images
without requiring curl in them. The host retains exact version/readiness JSON
checks, bounded responses and transport failures. Malformed readiness JSON is a
permanent contract failure; a valid non-ready body remains an external failure.
Optional operator identity reads use the inspected process's root filesystem
from the host instead of `docker exec`. Probe overhead counts against the same
320 MiB budget as application work; removing it does not bound reader/search
allocations.

The host contract is cgroup v2 with the memory controller, at least 1 GiB
swap, at least 512 MiB free under `/var/lib/nexus/parser-tmp`, and no running
container outside the exact `nexus` Compose project. Existing hosts must be
prepared once before this hard cutover:

```bash
sudo install -d -o 10001 -g 10001 -m 0700 /var/lib/nexus/parser-tmp
# mkswap reserves the first page for its header, so a file sized at exactly 1 GiB
# reports SwapTotal one page short of the release gate. Provision above the gate,
# and replace an existing undersized swapfile rather than keeping it.
if ! sudo test -e /swapfile || [ "$(stat -c %s /swapfile)" -le 1073741824 ]; then
  swapon --show=NAME --noheadings | grep -qx /swapfile && sudo swapoff /swapfile
  sudo rm -f /swapfile
  sudo fallocate --length 1025M /swapfile
  sudo chmod 0600 /swapfile
  sudo mkswap /swapfile
fi
swapon --show=NAME --noheadings | grep -qx /swapfile || sudo swapon /swapfile
grep -qxF '/swapfile none swap sw 0 0' /etc/fstab || \
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Remove stale test stacks only by their reviewed exact Compose project name;
never run wildcard removal or `docker system prune`.

Vercel custom-domain auto-assignment must be disabled. Vercel Authentication must
protect previews only (`ssoProtection.deploymentType=preview`) so the staged
production-target deployment URL is publicly probeable without exposing preview
deployments. A new commit may build a production-target deployment, but it must
remain staged and free of production/custom-domain aliases until the release
controller promotes it. The committed Vercel project must also keep system
environment variables exposed (`autoExposeSystemEnvs=true`) so the deployment's
source identity is available to the public `/version` proof.
`deploy/vercel/sync-env.sh` and application deploy both re-prove the project ID,
team, name, `autoAssignCustomDomains=false`,
`autoExposeSystemEnvs=true`, and `ssoProtection.deploymentType=preview`. The
controller rejects an already promoted new candidate.

## Immutable artifact lineage

Each push to `main` triggers `.github/workflows/backend-images.yml`. It builds
`docker/Dockerfile.backend` targets `api` and `worker`, verifies their baked
identity is equal, pushes public GHCR digests, and uploads
`nexus-backend-release-<source-sha>`.

The strict bundle contains the candidate manifest, production Compose file,
Caddy comparison input, host controller, its manifest decoder, the Android
player compatibility contract (`contracts/android-player-protocol.json`), and
the codex apparmor inputs.
The manifest binds repository, source SHA, both image digests, one expected database
revision, and one expected Oracle manifest digest. The resolver requires one
unexpired exact-name repository artifact whose owning workflow run records the
same `main` source SHA. It does not treat a CI run or publisher receipt as a
release gate. If publication fails, the artifact is duplicated, or it is
deleted before host installation, publish a fresh `main` SHA. GHCR creates new
packages as private: make both `nexus-api` and `nexus-worker` packages public
before relying on anonymous digest access. Once installed, the root-owned
immutable bundle is the resume and verification authority after the 90-day
Actions retention window. Schema-1 manifests already installed on hosts remain
readable; new publication writes schema 2 without workflow receipts.

## Explicit config publication

Tracked contracts live in `deploy/env/*.example`; real files beside them remain
untracked. A config-bearing release uses a new, never-published commit SHA.
Publish Vercel config before that SHA triggers its staged build:

```bash
NEXUS_SHARED_ENV=/absolute/path/to/env-prod \
NEXUS_FRONTEND_ENV=/absolute/path/to/env-prod-frontend \
  ./deploy/vercel/sync-env.sh
```

After the exact clean SHA is `origin/main`, publish the VPS config before
application release:

```bash
SOURCE_SHA="$(git rev-parse HEAD)"
NEXUS_SHARED_ENV=/absolute/path/to/env-prod \
NEXUS_BACKEND_ENV=/absolute/path/to/env-prod-backend \
NEXUS_WORKER_ENV=/absolute/path/to/env-prod-worker \
  ./deploy/hetzner/sync-env.sh "$SOURCE_SHA"
```

The VPS publisher rejects duplicate keys across its three input files, missing
or forbidden production keys, mutable Postgres/Caddy image references, and any
active application or Oracle attempt. Under the shared release lock it writes
one canonical `/etc/nexus/config/<sha256>.env`, then atomically moves
`/etc/nexus/current.env`. This prepares config; it does not restart a service.
The config snapshot is root:root `0440`, the live Caddyfile is root:root
`0444`, and release-state directories are root:root `0750`.

required migration backups use a separate private cloudflare r2 bucket. keep
both `r2.dev` access and public custom domains disabled. create credentials
scoped to object read/write access in this bucket, place them in the ignored
`deploy/env/env-prod-backup` input, then publish them before the new sha's
application release:

```bash
NEXUS_BACKUP_ENV=/absolute/path/to/env-prod-backup \
  ./deploy/hetzner/sync-backup-env.sh "$SOURCE_SHA"
```

this publisher writes one root-owned `/etc/nexus/backup-config/<sha256>.env`
and atomically moves `/etc/nexus/backup.env` under the shared release lock. it
does not restart services or expose backup credentials to application containers.
the release captures the exact backup config path and digest before stopping
writers. a missing or invalid backup config blocks a new required-backup release.
historical local backups and their attempts remain readable.

retain r2's default cleanup of incomplete multipart uploads after seven days.
do not expire completed backups automatically: retain them until an
explicit retention review permits removing individual recovery points. r2
storage and request usage can incur charges beyond the account's free allowance.
see [r2 lifecycle behavior](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
and [r2 pricing](https://developers.cloudflare.com/r2/pricing/).

The Vercel deployment ID is its durable build-config snapshot. Keep this sequence
serialized so no other production build captures the prepared values. A
code-only release may reuse the current Vercel snapshot and current
content-addressed VPS config. A config change never reuses a previously
published source SHA.

## Release

after backend publication and the staged vercel build for the exact `main` sha
are ready, announce the no-use window and close clients. run:

```bash
SOURCE_SHA="$(git rev-parse HEAD)"
./deploy/hetzner/deploy.sh "$SOURCE_SHA"
```

if an earlier candidate committed database changes and ended
`ForwardFixRequired`, keep the no-use window open and release a fresh published
sha through `deploy.sh`. never restart the old predecessor against the migrated
database. the controller checks stopped-writer recovery state, activates the
exact successor, and verifies its runtime before frontend promotion.

rerun the same command after a transient activation refusal; it resumes the
durable phase. candidate activation exposes the api and starts background
workers before release completion, so closed clients and the continuing no-use
window are operational requirements. there is no synthetic workload
qualification or expiring capacity evidence.

a permanent failure after publishing `current` but before final success has a
separate convergence limit
([oi-119](docs/tickets/failed-published-release-cannot-converge-successor.md)).
replay restores and verifies an existing `FrontendPromoted` candidate's bound
backend without regressing its phase, including after `current` publication
but before `Succeeded`. finalization checks the bound public release identity.

database backups are required by default. the controller streams a compressed
custom-format postgres dump directly to the captured private r2 bucket at
`releases/<source-sha>/database.dump`. it keeps only a small durable upload
receipt on the vps, completes the object only after `pg_dump` succeeds, then
reads the entire object back and checks its byte count, sha256, and complete
`pg_restore` traversal before admitting migration. interrupted upload completion
uses that receipt; a completed object without its receipt is never adopted.
after full verification it publishes `releases/<source-sha>/database.json`, a
recovery manifest containing the archive identity, starting revision, byte
count, and sha256. this keeps the recovery point usable if the vps is lost.
replay re-verifies the bound object before database mutation.

this avoids reserving a second database-sized local file. the tradeoffs are r2
storage/request charges, network dependence, and upload plus full readback time
inside the no-use window. the api artifact includes the postgres client for the
bounded backup container; the running api does not receive backup credentials.

an operator who accepts losing the fresh stopped-writer recovery point can
explicitly waive it:

```bash
./deploy/hetzner/deploy.sh "$SOURCE_SHA" --no-database-backup
```

The attempt records this choice before stopping writers. Every replay must use
the same choice; adding or omitting the flag later is refused. A waiver skips
database backup creation and its storage preflight. It preserves migration
preflights, stopped-writer proof, the durable mutation boundary, and release
health checks. Existing archives remain untouched and are not represented as a
fresh release backup. Database mutation still requires forward recovery;
reverting application images cannot restore deleted data.

freeze `main` from this first invocation until the attempt is durably
`Succeeded`, `RolledBack`, or `ForwardFixRequired`; settle the active sha before
landing its successor. installed resume and current-release verification require
clean `HEAD == source_sha` and use the immutable host bundle without consulting
mutable github state. settlement of an already durable `RollbackRequired` or
`ForwardFixPending` attempt also runs before any vercel dependency. this recovery
authority does not relax the operational freeze on main.

For the chat-admission hard cutover, keep the no-use window closed until the
operator has inventoried every outstanding browser `nx_chat_draft.v3:` command.
The final decoder requires a durable command origin, so every pre-cutover record
whose operation is not `Absent` is incompatible and must be settled under the
old release before deployment; only an `Absent` record may cross the cut.
Resolve any historical deleted-run command that lacks authoritative replay
evidence. Preserve open tabs and their `sessionStorage`; reload them only after
the release is healthy. Stop and prove the API and both worker lanes stopped,
retain unresolved provider/journal evidence, and let migration `0226` block on
any pre-receipt `chat_runs` row or live queue claim before it drops the obsolete
counter. Migration `0224` reset chat history; while writers remain stopped at
`0225`, delete, archive outside the live schema, or otherwise explicitly dispose
every chat run admitted under the old fingerprint. Migration `0226` never
backfills those unverifiable identities. Absence of a historical run never
authorizes a resend. There is no
counter reset, storage clear, compatibility decoder, or legacy runtime lookup.

Migration `0224` refuses every pending, running, or retryable generation job and
every unclassified dead generation job. A dead `synapse_scan` is reset only
after the separate nonterminal-`llm_calls` and `Uncertain`-journal preflights
prove that no ambiguous provider effect remains. A dead `enrich_metadata` job
is reset only when its finished, unclaimed attempt returned one frozen known
failure reason in one of the two exact historical terminal result shapes whose
error matches the queue error. The extended shape also requires exact nonempty
provider/model attempts and a matching terminal attempt; current Media metadata
and failure facts remain. Never update or delete production queue rows manually
to force migration admission.

The command performs the complete protocol:

1. validates git, bundle, manifest, and staged vercel identity before mutation;
2. installs the immutable bundle and inspects durable host state;
3. before the first hard-cut attempt, proves exact predecessor identity, host
   capacity, foreign-container absence, and current memory/PID use; when an
   existing container lacks the canonical envelope, the immutable controller
   idempotently applies it with `docker update` and immediately inspects the
   result; unsafe current use blocks before any update;
4. preflights the exact content-addressed config path and digest, Compose, Caddy
   equality, image identity, applied memory/PID limits, cgroup, memory, swap,
   PSI, parser disk and the required-backup destination, running-container ownership,
   live infra, database ancestry, and predecessor evidence without mutation;
5. stops and proves stopped the background worker first, then the interactive
   worker and API;
6. when migration is pending, proves the current database identity and ancestry,
   then creates and verifies one durable custom-format Postgres backup unless
   explicitly waived; records `DataMutationStarted` before upgrading in a
   512 MiB / 256 PID one-off container;
7. records `BackendActivationStarted`, activates app images by digest, and
   waits boundedly for Compose health before proving exact API/readiness bodies,
   workers, shared task-contract digest, schema, config, images, and unchanged
   infra;
8. promotes only the bound Vercel deployment, explicitly binds the committed
   custom domain to it, proves the provider alias and public web/API vector,
   writes one immutable record, and atomically publishes current SHA.

Resource convergence is the permanent release-owned entry to the hard-cut
envelope. It is safe to replay after process death, skips already exact
containers, and includes existing Codex runtime services without starting or
recreating them. It never recreates Postgres or Caddy; do not apply limits
manually outside this owner.

If convergence reports retained swap before an attempt exists, its prescribed
repair is an exact-container restart during a no-use window, under the release
lock. Stop background first, then interactive and API; prove all writers
stopped before restarting Postgres. Allow clean database shutdown, preserve
container IDs, images and configuration, and restore the existing services in
dependency order. Prove health and zero retained swap before rerunning the same
release. Do not recreate containers or edit release state.

success ends the no-use window. no separate migration, compose, or promotion
command is part of the normal path.

## Durable state and replay

Host state lives under `/var/lib/nexus/releases`:

```text
attempts/<source-sha>.json
oracle-attempts/<source-sha>-<manifest-digest-hex>.json
oracle-repairs/<source-sha>-<manifest-digest-hex>.json
records/<source-sha>.json
current
forward-fix
```

bundles live at `/opt/nexus/releases/<source-sha>` and application configs at
`/etc/nexus/config/<sha256>.env`. backup configs live separately at
`/etc/nexus/backup-config/<sha256>.env`. r2 backups use
`releases/<source-sha>/database.dump` and its `database.json` recovery manifest
in the captured private bucket; their small upload receipts live at
`/var/backups/nexus/r2/<source-sha>/receipt.json`.
historical local archives remain at `/var/backups/nexus/<source-sha>.dump`.
durable json and pointers are canonical, fsynced, and atomically published.
records and bundles are immutable.

new application attempts use schema `3` and record immutable `backup_policy`
(`required` or `waived`), `backup_config_path`, and `backup_config_sha256`.
required attempts bind backup config even when no migration is pending; waived
attempts bind neither. existing schema `1` and `2` attempts retain their original
json and local-backup semantics. schema `1` requires backups; schema `2` retains
its recorded policy. a waived attempt records `backup: null`; it never claims
`BackupVerified`.

Application phases are:

```text
Prepared -> WritersStopped
WritersStopped -> BackupVerified -> DataMutationStarted  # required backup
WritersStopped -> DataMutationStarted                    # explicit backup waiver
WritersStopped -> BackendActivationStarted               # no migration
DataMutationStarted -> BackendActivationStarted
BackendActivationStarted -> AwaitingFrontendPromotion
AwaitingFrontendPromotion -> FrontendPromoted -> Succeeded
Prepared/WritersStopped/BackupVerified -> RollbackRequired -> RolledBack
DataMutationStarted/BackendActivationStarted/AwaitingFrontendPromotion/
FrontendPromoted -> ForwardFixPending -> ForwardFixRequired
any failed phase of a forward-fix successor -> ForwardFixPending
                                            -> ForwardFixRequired
```

`RolledBack` and `Succeeded` are nonblocking terminal phases;
`ForwardFixRequired` is blocking. The two pending phases make settlement intent
durable before external restart/stop work. Every mutator takes the same host
lock for its invocation and rejects a conflicting nonterminal attempt. The
rollback branch applies only to an ordinary attempt that did not bind a
`forward_fix_of` pointer; a failed forward-fix successor never restarts its
failed predecessor.

## Verification

The release controller already requires these facts. The operator may repeat
the public read-only checks:

```bash
curl --fail --silent --show-error https://api.nexus.nielseriknandal.com/livez | jq
curl --fail --silent --show-error https://api.nexus.nielseriknandal.com/readyz | jq
curl --fail --silent --show-error https://api.nexus.nielseriknandal.com/version | jq
curl --fail --silent --show-error https://nexus.nielseriknandal.com/version | jq
```

`/livez` proves only the API process. `/readyz` is `200` only when Postgres is
reachable and its sole revision equals the image's baked revision. API
`/version` returns the baked SHA, expected schema, expected Oracle digest, and
task-contract digest. Web `/version` returns the Vercel source SHA. All are
no-store.

Each worker advances a lane-owned heartbeat only after a successful polling and
scheduling cycle. Container health rejects a dead PID, a heartbeat older than
20 seconds, the wrong lane or kinds, identity/task-contract drift, database
failure, or schema drift.

## Failure and recovery

Do not improvise. Diagnose the external cause, preserve state, and use this
matrix:

| Observation | Required action |
|---|---|
| Failure before `Prepared` | Fix the preflight input; rerun the same SHA. |
| Nonterminal attempt | Rerun `deploy.sh` with the same SHA. |
| `RollbackRequired` or `ForwardFixPending` | Rerun the same SHA; settlement resumes before any Vercel dependency. |
| `AwaitingFrontendPromotion` | Rerun the same SHA; it reuses only the bound Vercel ID. |
| Vercel candidate promoted but no record/current | Rerun the same SHA; public proof finalizes the durable prefix. |
| Current SHA already equals requested SHA | Rerun the same SHA; it re-proves the recorded vector and exits. |
| `RolledBack` or succeeded-but-superseded SHA | Create and publish a new `main` SHA. |
| `ForwardFixRequired` or failure after a commitment boundary | Fix forward in a new published `main` SHA and release it. |
| Any failure of a successor whose `forward_fix_of` is set, including before a commitment boundary | Settle it to `ForwardFixRequired`; release another fresh published `main` SHA. Never restart the failed predecessor. |
| Bound Vercel deployment is authoritatively deleted or terminally failed | Rerun the same SHA; direct ID inspection settles rollback or forward-fix without candidate reselection. |

That settlement first proves the committed project/team identity, then decodes
the stored deployment ID before reading the canonical Vercel alias resource.
Only a recognized 404 in that fixed scope or an identity-matching
`ERROR`/`CANCELED` response is terminal evidence. Transport errors, unknown
states, malformed JSON, or identity disagreement fail closed without changing
host state.

A crash is replay input, not permission to delete an attempt or restart a
predecessor. After either commitment boundary, predecessor code never runs.
The `forward-fix` pointer admits only the next never-published successor and is
captured immutably as that attempt's `forward_fix_of`. It is cleared only after
that exact bound successor is fully verified; verifying an older current SHA
cannot clear it.

80/20 boundary: if an installed application release controller/bundle is itself
defective while its attempt is active, stop and preserve all state for reviewed
manual disaster recovery. There is no generic controller swap, override, or
fallback. The narrow two-SHA repair authority below exists only for Oracle
reconciliation and cannot activate application code or configuration.

### database backup recovery

a verified archive is a recovery point, not an automatic rollback. restoring it
discards writes made after that point. keep the no-use window closed and review
the database, application sha, and schema together before any production restore.
the release controller never restores or downgrades a database.

first restore into an isolated disposable postgres instance on a machine with
space for both the archive and expanded database. use the captured postgres
image, including pgvector, and create the original database owner role. the
remote `database.json` recovery manifest binds the r2 endpoint, bucket, key,
expected sha256, byte count, database identity, and starting revision. the vps's
release attempt is additional evidence when available; losing it does not make
the remote recovery point unusable. r2's multipart etag is not the archive's
sha256.

configure an s3 client profile named `nexus-backups` with region `auto` and the
operator-only credentials, without putting secrets in command arguments. set
`BACKUP_ENDPOINT` and `BACKUP_BUCKET` from the retained operator config, then
download the desired release's recovery manifest with the aws cli:

```bash
umask 077
aws --profile nexus-backups --endpoint-url "$BACKUP_ENDPOINT" \
  s3api get-object --bucket "$BACKUP_BUCKET" \
  --key "releases/$SOURCE_SHA/database.json" recovery.json
jq . recovery.json
```

require manifest schema `1` and its source sha, endpoint, bucket, and archive
key to match the selected release and destination. set `BACKUP_KEY`, `BACKUP_SHA256`, and
`BACKUP_BYTE_COUNT` from its evidence, then download and check the archive:

```bash
umask 077
aws --profile nexus-backups --endpoint-url "$BACKUP_ENDPOINT" \
  s3api get-object --bucket "$BACKUP_BUCKET" --key "$BACKUP_KEY" recovery.dump
test "$(wc -c < recovery.dump | tr -d ' ')" = "$BACKUP_BYTE_COUNT"
printf '%s  %s\n' "$BACKUP_SHA256" recovery.dump | sha256sum --check
pg_restore --file=/dev/null recovery.dump
```

proceed only after all three checks succeed. in a shell configured to connect
only to the isolated recovery instance, create a new database and restore it:

```bash
createdb nexus_backup_rehearsal
pg_restore --exit-on-error --dbname=nexus_backup_rehearsal recovery.dump
psql --dbname=nexus_backup_rehearsal --no-psqlrc --tuples-only \
  --command='SELECT version_num FROM alembic_version'
```

require the recorded starting revision and inspect representative product rows
before treating the rehearsal as complete. retain its outcome with the recovery
point. a live production restore remains a separately reviewed disaster recovery
operation; do not substitute this disposable database for production or start
predecessor code against a migrated database.

## Oracle publication

Application release records the expected Oracle manifest digest but never reads
Oracle state. After the application SHA is current, reconcile explicitly:

```bash
./deploy/hetzner/reconcile-oracle.sh <current-source-sha>
```

The command binds only the current immutable release record, its captured config,
and its reviewed manifest. Exact published readiness is a read-only no-op. A
mutating run creates durable state before stopping all app writers, rejects
unsupported work/anchor/plate removals, deletes the current publication marker,
reconciles only declared support and exact jobs, proves DB/selector/R2 identity,
publishes the marker last, and restores the exact current runtime.

Oracle phases are:

```text
Prepared -> WritersStopped -> Unpublished -> SupportReconciled
         -> Published -> RuntimeRestored -> Succeeded
```

If interrupted, rerun the same command and SHA. After `Unpublished`, writers
normally remain stopped until the attempt succeeds. One allowed late crash
prefix exists: the exact publication marker may be committed and the captured
runtime started before `RuntimeRestored` is durably written. Replay loads the
attempt, re-stops those exact writer IDs, converges and re-proves the same
target, then restores the exact runtime. Do not run an application release or
publish config around it; the shared lock and attempt state reject both.

If the current target A has a nonterminal attempt and A's Oracle controller or
domain code is defective, land an exact clean-`main` repair SHA B with the same
expected database revision and Oracle digest, then run:

```bash
./deploy/hetzner/reconcile-oracle.sh A --repair-source-sha B
```

This is the sole repair authority. It installs B as an immutable controller
bundle without creating application release state or activating B, proves B's
API/worker image identities, and create-only binds A's target/schema/digest to
B's manifest, images, and image IDs under `oracle-repairs/`. B executes the
exact durable A attempt with A's captured config and Compose input; completion
restores and proves A's exact runtime and public vector. A different repair SHA,
implicit A replay after binding, state deletion/editing, config activation, and
generic override/fallback paths are invalid. After a crash, rerun the exact A+B
command; retain the binding as immutable provenance.

A `Succeeded` Oracle attempt is immutable evidence and is never reopened or
deleted. If later readiness drifts, land and application-release a fresh SHA
with corrected manifest/runtime, then reconcile that new current SHA. An
unsupported-removal preflight likewise requires an additive replacement
manifest on a new SHA, or a separate reviewed retirement operation; never edit
the attempt or manifest in place.

## Reader publication preflight

Offline reading identifies a reader document by its publication generation.
Revision `0219` creates one generation-`1` row per eligible `ready_for_reading`
document at the instant it runs; a document that becomes ready afterwards is
published by whichever application artifact is deployed, and an artifact that
predates the publication owner cannot create that row. Such a document has no
generation at all, so both offline routes fail closed forever.

Before exposing the first reading-capable APK — and, because it is idempotent,
before every later Android release — close that window explicitly:

```bash
python -m nexus.ops.reader_publication_preflight census   # read-only report
python -m nexus.ops.reader_publication_preflight rebuild  # publish the remainder
```

`rebuild` publishes only documents that still have no publication row, at
generation `1`, through the publication owner; it never reads an existing row as
stale and never bumps one. It re-reads its census within a bounded number of
passes and fails unless every eligible ready document carries a publication row.
This is an application-data operation, not a release-controller flag.

## Infrastructure operations

Postgres or Caddy image upgrades, Caddy policy changes, host replacement, R2
policy changes, and provider configuration changes are separate reviewed
operations. They are not application-release flags. Permanent R2 policy owners
are under `deploy/cloudflare/`; the Supabase Auth verifier is
`deploy/supabase/verify-auth-config.sh`.

Retain verified migration backups and immutable release records according to an
explicit operator retention decision. Garbage collection is not part of the
release controller.

## Owned files

| Concern | Owner |
|---|---|
| Pull-request check | `.github/workflows/ci.yml` |
| Backend publication | `.github/workflows/backend-images.yml` |
| Backend artifact | `docker/Dockerfile.backend` |
| Immutable bundle resolution | `deploy/hetzner/fetch-release-bundle.sh` |
| External orchestration | `deploy/hetzner/deploy.sh` |
| Durable host protocol | `deploy/hetzner/release.py` |
| Production topology | `deploy/hetzner/docker-compose.yml` |
| VPS config publication | `deploy/hetzner/sync-env.sh` |
| backup config publication | `deploy/hetzner/sync-backup-env.sh` |
| streamed database backup | `python/nexus/release_backup.py` |
| Vercel config publication | `deploy/vercel/sync-env.sh` |
| Oracle operation | `deploy/hetzner/reconcile-oracle.sh` |
| Environment contract | `deploy/env/README.md` and `deploy/env/*.example` |
