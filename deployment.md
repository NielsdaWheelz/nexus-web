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

Authentication is released as one hard contract. Before any release mutation,
`deploy/supabase/verify-auth-config.sh` proves hosted refresh rotation is
enabled with a ten-second reuse interval. After the exact production alias is
bound, `deploy/smoke/auth-smoke.sh` proves recovery, terminal clearing, BFF
unauthenticated behavior, OAuth callback identity, stale-cookie rejection, and
private no-store headers. Durable `finalize` is unreachable until that smoke
passes; failure settles the bound frontend for a forward fix.

Current public hosts are `nexus.nielseriknandal.com` and
`api.nexus.nielseriknandal.com`. The VPS is `nexus-api-worker` at
`5.78.194.235`.

The release identity is one full lowercase Git `source_sha`. It binds the web
deployment, API image digest, worker image digest, expected Alembic revision,
expected Oracle manifest digest, task contract, and captured VPS config.

## Non-negotiable rules

- `deploy/hetzner/deploy.sh <source-sha>` is the only application release
  entrypoint. Rerun it unchanged to resume.
- `deploy/hetzner/prove-codex-capacity.sh <source-sha>` is the only Codex-host
  release qualification entrypoint. It installs the exact immutable bundle and
  records measured evidence, but never applies an application release.
- A planned retained-swap maintenance restart is the sole exception to those
  two entrypoints. It is authorized only after qualification has corrected the
  exact incumbent cgroup limits, blocked before candidate startup, and reported
  a full container ID as retaining forbidden swap. It never recreates a
  container or changes release state.
- Release only a clean checkout where `HEAD == origin/main == source-sha` and
  the exact SHA's immutable backend bundle exists.
- The post-merge publisher builds each backend target once. Production pulls
  manifest-selected GHCR digests and never builds an application image.
- Vercel produces a `READY` production-target candidate with no production or
  custom-domain alias. Vercel-generated `.vercel.app` aliases are expected;
  backend activation and proof precede promotion of that exact deployment ID.
  The controller explicitly assigns the committed custom domain to that exact
  deployment and proves the binding through Vercel's alias resource plus the
  public no-store `/version` contract.
- Application release changes only `api`, `worker-interactive`, and
  `worker-background`. It does not recreate Postgres or Caddy.
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
player protocol corpus, and the Codex AppArmor and capacity entrypoint inputs.
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

The Vercel deployment ID is its durable build-config snapshot. Keep this sequence
serialized so no other production build captures the prepared values. A
code-only release may reuse the current Vercel snapshot and current
content-addressed VPS config. A config change never reuses a previously
published source SHA.

## Release

After backend publication and the staged Vercel build for the exact `main` SHA
are ready, qualify a candidate that carries the Codex agent host. The passing
candidate-bound evidence must have been measured on the production host within
the preceding 72 hours:

```bash
SOURCE_SHA="$(git rev-parse HEAD)"
./deploy/hetzner/prove-codex-capacity.sh "$SOURCE_SHA"
```

This bounded preflight runs the subscription-authenticated cold/warm canary in
the candidate worker image and measures its real production cgroup, host
headroom, pressure, swap, OOM counters, and the unchanged long-lived services.
It does not call `apply`, stop writers, migrate data, or promote Vercel. An
absent, stale, retriable, or subscription-blocked result is not release
evidence; diagnose it and rerun the unchanged qualification command. A measured
contract breach permanently disqualifies the candidate SHA.

On a host first crossing into the enforced no-service-swap contract,
qualification may instead correct every exact incumbent's kernel limits and
then block because pages swapped under the old policy remain charged. This is
infrastructure settlement, not candidate evidence. Announce a no-use window,
prove no application or Oracle attempt and no active generation job, then
restart only each full container ID reported by the controller with
`docker restart --timeout 30 <full-container-id>`. Use the order Postgres, API,
interactive worker, background worker, Caddy; wait for the restarted service's
ordinary health proof before continuing. Re-inspect the same ID and require
`memory.swap.max == 0` and `memory.swap.current == 0`. Abort on an identity,
health, or cgroup discrepancy, and rerun the unchanged qualification only after
all five incumbents are healthy. Never restart by service name, recreate a
container, clear caches, or automate this one-time database-and-writer outage
inside qualification.

After qualification passes, announce the no-use window and close clients. Then
run:

```bash
SOURCE_SHA="$(git rev-parse HEAD)"
./deploy/hetzner/deploy.sh "$SOURCE_SHA"
```

Freeze `main` from this first invocation until the attempt is durably
`Succeeded`, `RolledBack`, or `ForwardFixRequired`. Every ordinary replay
requires clean `HEAD == origin/main == source_sha`; settle the active SHA before
landing its successor. The only code-level exception is provider-free settlement
of an already durable `RollbackRequired` or `ForwardFixPending` attempt from its
installed bundle; this is recovery authority, not permission to unfreeze main.

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

1. validates Git, bundle, manifest, staged Vercel identity, and the exact
   fresh capacity qualification when the candidate carries the Codex host;
2. installs the immutable bundle and inspects durable host state;
3. before the first hard-cut attempt, proves exact predecessor identity, host
   capacity, foreign-container absence, and current memory/PID use; when an
   existing container lacks the canonical envelope, the immutable controller
   idempotently applies it with `docker update` and immediately inspects the
   result; unsafe current use blocks before any update;
4. preflights the exact content-addressed config path and digest, Compose, Caddy
   equality, image identity, applied memory/PID limits, cgroup, memory, swap,
   PSI, parser/backup disk, running-container ownership, live infra, database
   ancestry, and predecessor evidence without mutation;
5. stops and proves stopped the background worker first, then the interactive
   worker and API;
6. when migration is pending, creates and verifies one durable custom-format
   Postgres backup before recording `DataMutationStarted` and upgrading in a
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
containers, never recreates Postgres or Caddy, and has no manual or legacy
alternative.

Success ends the no-use window. No separate migration, Compose, smoke, or
promotion command is part of the normal path.

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

Bundles live at `/opt/nexus/releases/<source-sha>`, configs at
`/etc/nexus/config/<sha256>.env`, and migration backups at
`/var/backups/nexus`. Durable JSON and pointers are canonical, fsynced, and
atomically published. Records and bundles are immutable.

Application phases are:

```text
Prepared -> WritersStopped
WritersStopped -> BackupVerified -> DataMutationStarted  # migration pending
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
| Vercel config publication | `deploy/vercel/sync-env.sh` |
| Oracle operation | `deploy/hetzner/reconcile-oracle.sh` |
| Environment contract | `deploy/env/README.md` and `deploy/env/*.example` |
