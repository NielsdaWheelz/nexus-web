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

Current public hosts are `nexus.nielseriknandal.com` and
`api.nexus.nielseriknandal.com`. The VPS is `nexus-api-worker` at
`5.78.194.235`.

The release identity is one full lowercase Git `source_sha`. It binds the web
deployment, API image digest, worker image digest, expected Alembic revision,
expected Oracle manifest digest, task contract, and captured VPS config.

## Non-negotiable rules

- `deploy/hetzner/deploy.sh <source-sha>` is the only application release
  entrypoint. Rerun it unchanged to resume.
- Release only a clean checkout where `HEAD == origin/main == source-sha` and
  exact `main` CI succeeded.
- CI builds each backend target once. Production pulls manifest-selected GHCR
  digests and never builds an application image.
- Vercel produces a `READY` production-target candidate with no production or
  custom-domain alias. Vercel-generated `.vercel.app` aliases are expected;
  backend activation and proof precede promotion of that exact deployment ID.
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
```

Production coordinates are committed, not ambient: SSH
`nexus@5.78.194.235`, web `nexus.nielseriknandal.com`, Vercel project
`nexus-web` / `prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs`, and team
`niels-erik-nandals-projects` / `team_fKVvTyTsMBQ7qFjccFO17BJL`. Changing any
coordinate is a reviewed infrastructure change, not a release flag.

Vercel custom-domain auto-assignment must be disabled. Vercel Authentication must
protect previews only (`ssoProtection.deploymentType=preview`) so the staged
production-target deployment URL is publicly probeable without exposing preview
deployments. A new commit may build a production-target deployment, but it must
remain staged and free of production/custom-domain aliases until the release
controller promotes it. The committed Vercel project must also keep system
environment variables exposed (`autoExposeSystemEnvs=true`) so the deployment's
source identity is available to the public `/version` proof.
`deploy/vercel/sync-env.sh`, local adoption admission, and application deploy
all re-prove the project ID, team, name, `autoAssignCustomDomains=false`,
`autoExposeSystemEnvs=true`, and `ssoProtection.deploymentType=preview`. The
controller rejects an already promoted new
candidate.

## Provisioning and first adoption

Provision a new host only with the owned bootstrap:

```bash
HCLOUD_SSH_KEY=<key-name> \
HCLOUD_SSH_ALLOWED_IPS=<operator-ip>/32 \
HCLOUD_LOCATION=hil \
HCLOUD_SERVER_TYPE=cpx11 \
./deploy/hetzner/provision.sh

ssh nexus@<server-ip> cloud-init status --wait
```

Before the first immutable release, prove the supported Alembic lineage and
completed migration audits, pin the exact running Postgres and Caddy digests in
the private production config, and publish that config for the never-published
source SHA. Then run the sole infrastructure-adoption owner from that exact
clean `HEAD == origin/main` checkout. The `adopt` command first performs
mutation-free local admission: it resolves the exact backend artifact/CI/
publisher lineage, proves both digest images are anonymously fetchable, and
proves one staged READY Vercel candidate for the exact SHA plus its no-store
`/version` identity. Only after those checks pass does it make the one host SSH
adoption call:

```bash
NEXUS_SHARED_ENV=/absolute/path/to/env-prod \
NEXUS_BACKEND_ENV=/absolute/path/to/env-prod-backend \
NEXUS_WORKER_ENV=/absolute/path/to/env-prod-worker \
./deploy/hetzner/sync-env.sh <source-sha>

python3 -B deploy/hetzner/adopt-infrastructure.py adopt <source-sha>
```

The adoption owner fixes the production SSH coordinate and, under the shared
host lock, binds immutable Git bytes plus the exact five live containers,
images, configs, named volumes, config snapshot, and database identity. It
stops only the three writers; creates, validates, and restore-rehearses a
custom-format Postgres dump; installs the root-owned Caddyfile; recreates only
Postgres and Caddy with the same image IDs and volumes; then restores and proves
the exact captured writers and all five healthy services.

Its durable path is:

```text
Prepared -> WritersStopped -> DatabaseCaptured -> BackupVerified
         -> FilesInstalled -> InfrastructureMutationStarted
         -> InfrastructureRecreated -> WritersRestored -> Succeeded
```

After interruption, rerun only the exact same command and SHA. Every phase is
replay-safe. Before `InfrastructureMutationStarted`, failure restores the exact
captured writers; at or after that boundary it retains the no-use window and
replays forward. Never substitute manual Docker, database, file-copy, or state
editing commands.

Success creates the canonical, create-only
`/var/lib/nexus/infra-adoption/completed.json` bound to its terminal attempt
and retained verified dump. A nonterminal adoption blocks every other host
mutator. Its source SHA is provenance, not a requirement that the first app
candidate use the same SHA. Before `current` exists, the first candidate must
re-prove the exact adopted bundle, config, infrastructure, volumes, database
identity, and stable writer/schema vector; a bound forward-fix successor may
advance writers/schema only while proving them stopped. Do not republish config
between adoption and that first release. Only after `Succeeded` run
`deploy/hetzner/deploy.sh <source-sha>`; that command separately captures the
authoritative READY Vercel deployment as the immutable genesis predecessor.

## Immutable artifact lineage

Successful exact-`main` `CI` triggers `.github/workflows/backend-images.yml`.
It builds `docker/Dockerfile.backend` targets `api` and `worker`, verifies their
baked identity is equal, pushes public GHCR digests, and uploads
`nexus-backend-release-<source-sha>`.

The strict bundle contains the candidate manifest, production Compose file,
Caddy comparison input, host controller, and its manifest decoder. The manifest
binds source CI run/workflow IDs and attempt `1`, publisher run ID and attempt
`1`, repository, source SHA, both image digests, one expected database revision,
and one expected Oracle manifest digest. The shared resolver requires one and
only one exact-name repository artifact, proves its immutable first-attempt
publisher owner, then independently proves the exact first-attempt source CI.
The publisher workflow's outer `head_sha` is not source identity. Publisher
reruns only prove the original artifact still exists; they never rebuild or
upload. If the first source CI, publisher, or artifact fails, is duplicated, or
is deleted before host installation, use a new SHA. GHCR creates new packages as
private: if the first publisher run fails only because anonymous digest proof
cannot read a newly created package, never adopt that SHA; make both
`nexus-api` and `nexus-worker` packages public in the provider, then use a fresh
successful SHA. Once installed, the root-owned immutable bundle is the resume
and verification authority after the 90-day Actions retention window.

## Explicit config publication

Tracked contracts live in `deploy/env/*.example`; real files beside them remain
untracked. A config-bearing release uses a new, never-published commit SHA.
Publish Vercel config before that SHA triggers its staged build:

```bash
./deploy/vercel/sync-env.sh
```

After the exact clean SHA is `origin/main`, publish the VPS config before
application release:

```bash
SOURCE_SHA="$(git rev-parse HEAD)"
./deploy/hetzner/sync-env.sh "$SOURCE_SHA"
```

The VPS publisher rejects duplicate keys across its three input files, missing
or forbidden production keys, mutable Postgres/Caddy image references, and any
active application or Oracle attempt. Under the shared release lock it writes
one canonical `/etc/nexus/config/<sha256>.env`, then atomically moves
`/etc/nexus/current.env`. This prepares config; it does not restart a service.
The config snapshot is root:root `0440`, the live Caddyfile is root:root
`0444`, and release-state directories are root:root `0750`; adoption rejects
any existing state that does not satisfy those exact ownership and mode
contracts.
For first adoption, it transfers the host controller and decoder from the exact
clean `origin/main` checkout into a validated temporary directory; it neither
requires nor installs an application bundle.

The Vercel deployment ID is its durable build-config snapshot. Keep this sequence
serialized so no other production build captures the prepared values. A
code-only release may reuse the current configs. A config change never reuses a
previously published source SHA.

## Release

After exact `main` CI, backend publication, and the staged Vercel build are
green, announce the no-use window and close clients. Then run:

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

The command performs the complete protocol:

1. validates Git, CI, bundle, manifest, and staged Vercel identity;
2. installs the immutable bundle and inspects durable host state;
3. preflights config, Compose, Caddy equality, image identity, live infra,
   database ancestry, capacity, and predecessor evidence without mutation;
4. stops and proves stopped only the three app writers;
5. when migration is pending, creates and verifies one durable custom-format
   Postgres backup before recording `DataMutationStarted` and upgrading;
6. records `BackendActivationStarted`, activates app images by digest, and
   waits boundedly for Compose health before proving exact API/readiness bodies,
   workers, shared task-contract digest, schema, config, images, and unchanged
   infra;
7. promotes only the bound Vercel deployment, proves the public web/API vector,
   writes one immutable record, and atomically publishes current SHA.

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
genesis-vercel-deployment
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
| `RolledBack` or succeeded-but-superseded SHA | Create a new successful `main` SHA. |
| `ForwardFixRequired` or failure after a commitment boundary | Fix forward in a new successful `main` SHA and release it. |
| Any failure of a successor whose `forward_fix_of` is set, including before a commitment boundary | Settle it to `ForwardFixRequired`; release another fresh successful `main` SHA. Never restart the failed predecessor. |
| Bound Vercel deployment is authoritatively deleted or terminally failed | Rerun the same SHA; direct ID inspection settles rollback or forward-fix without candidate reselection. |

That settlement first proves the committed project/team identity, then decodes
the stored deployment ID before reading the mutable production alias. Only a
recognized 404 in that fixed scope or an identity-matching `ERROR`/`CANCELED`
response is terminal evidence. Transport errors, unknown states, malformed JSON,
or identity disagreement fail closed without changing host state.

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
domain code is defective, land exact clean-main/CI repair SHA B with the same
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
| CI proof | `.github/workflows/ci.yml` |
| Backend publication | `.github/workflows/backend-images.yml` |
| Backend artifact | `docker/Dockerfile.backend` |
| Immutable bundle resolution | `deploy/hetzner/fetch-release-bundle.sh` |
| First-production adoption | `deploy/hetzner/adopt-infrastructure.py` |
| External orchestration | `deploy/hetzner/deploy.sh` |
| Durable host protocol | `deploy/hetzner/release.py` |
| Production topology | `deploy/hetzner/docker-compose.yml` |
| VPS config publication | `deploy/hetzner/sync-env.sh` |
| Vercel config publication | `deploy/vercel/sync-env.sh` |
| Oracle operation | `deploy/hetzner/reconcile-oracle.sh` |
| Environment contract | `deploy/env/README.md` and `deploy/env/*.example` |
