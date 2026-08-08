# Immutable Production Release Hard Cutover

**Status:** APPROVED SPEC · 2026-08-06

**Open questions:** None.

**Type:** Human-triggered hard cut. No legacy path, alias, fallback, dual write,
compatibility decoder, or automatic data rollback.

## Decision and target

Use one small release protocol built from GitHub Actions, public GHCR images,
Docker Compose, Vercel staged promotion, and the existing VPS. CI builds once;
production pulls immutable digests. `deploy/hetzner/deploy.sh <source-sha>` is
the sole release entrypoint. A planned no-use window avoids zero-downtime
platform complexity.

- The release binds frontend, API, workers, schema, and captured config. It
  changes only app services; Postgres, Caddy, volumes, and infra retain identity.
- Exact successful `main` CI publishes API/worker digests plus one strict
  manifest. The VPS never builds or accepts mutable app tags.
- Every host mutator takes one shared `flock` for its invocation. Durable
  nonterminal attempt state—not a long-lived process lock—serializes the gaps
  between `apply`, frontend promotion, and `finalize`; every mutator checks it.
- Vercel promotion follows backend proof; public proof precedes one immutable
  release record and atomic current SHA. Phase evidence makes replay exact.
- Config publication and Oracle reconcile are separate explicit operations.
  Deploy records expected Oracle identity but never reads, waits for, or mutates
  Oracle.

## Scope and 80/20 boundary

In scope: exact CI/PR recovery, digest images, one release state protocol,
stopped-writer backup/migration, app-only activation, truthful health, staged
frontend promotion, content-addressed config, independent current-publication
Oracle reconcile with one narrow immutable controller-repair authority, focused
behavior tests, and deletion of superseded code.

Non-goals:

- Kubernetes/Nomad/GitOps, a release database, generic workflow engine, or UI;
- zero downtime, canaries, traffic splitting, multi-region, concurrent releases;
- database downgrade/automatic restore or rollback after migration begins;
- SLSA/SBOM enforcement, settings automation, or infrastructure upgrades;
- Oracle history, retirement/garbage collection, or a generic publication system;
- a generic application-controller repair plane: a defective installed
  controller during an active application attempt is manual disaster recovery;
  Oracle gets one narrow immutable repair binding only;
- maintenance UI or unrelated historical-doc cleanup; close clients manually.

## Preconditions

1. Disable Vercel custom-domain auto-assignment and prove the fixed project
   read-only with `autoAssignCustomDomains=false` and
   `autoExposeSystemEnvs=true`; sync, adoption admission, and deploy re-prove
   both values.
2. Prove production is beyond every completed manual migration gate and passes
   the Supabase-exit audit. Only that proof authorizes deleting those tools.
3. Resolve and pin the exact running Postgres and Caddy image digests; do not
   upgrade them. Install the live root-owned Caddyfile at
   `/etc/nexus/Caddyfile` and never source it from an app bundle.
4. Publish `/etc/nexus/current.env`; verify backup restore tooling and capacity.
5. Durably capture live container IDs plus inspect/image/config evidence before
   the first `WritersStopped`. With no trusted predecessor record, those exact
   containers may restart only before `DataMutationStarted` or
   `BackendActivationStarted`; after either boundary, recovery is forward-only.
6. Before the first attempt, create-only capture the exact READY Vercel
   deployment currently bound to the authoritative production host. It is the
   sole accepted genesis predecessor; an arbitrary deployment ID is invalid.

## Governing rules

All `docs/rules` apply. Release-specific consequences:

- Shell owns stateless GitHub/Vercel/SSH composition and performs strict exact
  `jq` decoding at those boundaries. Python owns durable host state, transitions,
  atomic records, Compose mutation, and recovery.
- Unknown states defect. Secrets never enter records/logs; GitHub/Vercel
  credentials never reach the VPS.
- Pin application and infrastructure images by digest. Infra change is a
  separate reviewed operation; app preflight requires tracked and live Caddy
  configuration to be byte-equal.
- Commands/polls are finitely bounded. Durable files use same-directory temp,
  file `fsync`, atomic rename, and parent-directory `fsync`.

## Architecture and ownership

| Capability | Sole owner |
|---|---|
| PR proof / image publication | GitHub Actions |
| API and worker artifact | `docker/Dockerfile.backend` targets |
| GitHub artifact resolution | `deploy/hetzner/fetch-release-bundle.sh` |
| Vercel, transfer, SSH | `deploy/hetzner/deploy.sh` |
| Lock, attempt, backup, migration, Compose, recovery | `deploy/hetzner/release.py` |
| First-production infrastructure adoption | `deploy/hetzner/adopt-infrastructure.py` |
| Service topology only | production Compose |
| Config publication | `deploy/hetzner/sync-env.sh` |
| Schema evolution | Alembic, one linear head |
| Oracle publication | Oracle owner via `reconcile-oracle.sh` |
| Runtime identity/readiness | API and workers |
| Human operation/recovery | `deployment.md`, sole runbook |

## Capability contracts

### First-production infrastructure adoption

`adopt-infrastructure.py adopt <source-sha>` is the sole infrastructure adoption
owner. From exact clean `HEAD == origin/main == source-sha` it stages immutable Git
bytes, then uses the shared host lock and this replay-safe state path:

```text
Prepared -> WritersStopped -> DatabaseCaptured -> BackupVerified
         -> FilesInstalled -> InfrastructureMutationStarted
         -> InfrastructureRecreated -> WritersRestored -> Succeeded
```

It binds the exact five live containers/configs, current content-addressed env,
infra digests and named volumes, stable database identity/revision, and a
stream-verified custom dump whose restore is rehearsed before infra mutation.
It recreates only Postgres and Caddy with the same images/volumes, then restores
the exact captured writers. Every durable boundary has crash/replay proof.

The canonical terminal attempt and create-only `completed.json` authorize the
first app release. The adoption source SHA is immutable provenance for the
captured infrastructure; it is not an application-candidate identity. A fresh
first release may use any never-published clean `main` SHA, but before `current`
exists it must re-prove the exact adopted bundle, config, infrastructure,
volumes, database identity, and (unless it is an explicitly bound forward-fix)
the adopted writer identities and database revision. A forward-fix successor
must additionally prove all writers stopped and may advance only its writer
images/schema under the durable forward-fix pointer. Config cannot be
republished between adoption and that first success.

### Candidate manifest

CI emits strict canonical JSON; `source_sha` is the sole release identity.

```json
{
  "schema_version": 1,
  "source_sha": "<40 lowercase hex>",
  "repository": "NielsdaWheelz/nexus-web",
  "source_ci_run_id": 123,
  "source_ci_run_attempt": 1,
  "source_ci_workflow_id": 321,
  "publisher_run_id": 456,
  "publisher_run_attempt": 1,
  "images": {
    "api": "ghcr.io/nielsdawheelz/nexus-api@sha256:<64 lowercase hex>",
    "worker": "ghcr.io/nielsdawheelz/nexus-worker@sha256:<64 lowercase hex>"
  },
  "expected_database_revision": "<single Alembic head>",
  "expected_oracle_manifest_digest": "sha256:<64 lowercase hex>"
}
```

Both images bake read-only SHA, expected DB revision, expected Oracle digest,
and matching OCI revision label. Production defects if absent/malformed; an
explicit dev/test checkout identity cannot override production.

Successful exact-`main` `CI` triggers a least-privilege publisher; each image
builds once. The earliest exact source-CI run claims the SHA. Its sole artifact
is `nexus-backend-release-<source-sha>`. The shared resolver requires exactly
one repository artifact with that case-exact name, binds its owner to the
manifest's first-attempt publisher, and independently proves the manifest's
first-attempt source CI. The publisher workflow's outer `head_sha` is never
source identity. Publisher reruns only prove the original artifact still
exists; they never rebuild or upload. A failed, deleted, or duplicate artifact
makes that SHA unreleasable and requires a new commit. Installed root-owned
bundles remain the resume authority after the 90-day Actions retention window.
GHCR creates newly published packages as private; if the first publisher fails
only because anonymous digest proof cannot read a newly created package, that
SHA is never adopted. Make both backend packages public, then use a fresh SHA.

### Release attempt and forward-fix state

After mutation-free preflight succeeds,
`/var/lib/nexus/releases/attempts/<source-sha>.json` is one strict union:

```text
Prepared -> WritersStopped
WritersStopped -> BackupVerified -> DataMutationStarted   # migration pending
WritersStopped -> BackendActivationStarted                # no migration
DataMutationStarted -> BackendActivationStarted
BackendActivationStarted -> AwaitingFrontendPromotion
AwaitingFrontendPromotion -> FrontendPromoted -> Succeeded

Prepared/WritersStopped/BackupVerified -> RollbackRequired -> RolledBack
committed phase -> ForwardFixPending -> ForwardFixRequired
any failed phase of a forward-fix successor -> ForwardFixPending
                                            -> ForwardFixRequired
```

Preflight failure creates no attempt and may retry. Phases store only established
SHA, predecessor, the immutable `forward_fix_of` pointer observed at `Prepared`,
candidate API/worker image IDs, container snapshot, config path/digest, Vercel
ID, phase proof, timestamps, and finite secret-free failure code.
`RollbackRequired` and `ForwardFixPending`
durably publish settlement intent before their external stop/start work.

`/var/lib/nexus/releases/forward-fix` is normally absent. Any exhausted failure
at or after `DataMutationStarted` or `BackendActivationStarted` points it
atomically at the failed SHA and leaves writers stopped. Only a verified
successor clears it. Any failure of a successor that bound that pointer—even
before a commitment boundary—settles to `ForwardFixRequired`, preserves the
pointer, and never restarts the failed predecessor. Its mere presence classifies
the next never-published SHA as the forward fix—no flag.

### Release record and config

`/var/lib/nexus/releases/records/<source-sha>.json` is immutable/create-only and
binds manifest hash, image digests, predecessor, captured config path/digest, DB
revision, expected Oracle digest, Vercel ID/production host, and verification
time. `/var/lib/nexus/releases/current` contains only `<source-sha>\n` and moves
atomically after public proof.

`/var/lib/nexus/releases/genesis-vercel-deployment` is an immutable create-only
deployment-ID pointer created only with empty release history. Before the first
promotion, the authoritative host must resolve to that exact ID. Later it must
resolve to the exact current record, the bound candidate, or an active-epoch
failed-public ID.

Promotion-before-record is an allowed durable prefix that replay finalizes. If
`current` moved first, `current == source_sha` completes the attempt idempotently.

Bundles at `/opt/nexus/releases/<source-sha>` are root-owned and immutable.
Rollback uses only the predecessor record's image/config path and digest, never
the current config pointer.

`sync-env.sh` takes the shared lock, validates one canonical duplicate-free env,
writes `/etc/nexus/config/<sha256>.env`, then atomically moves
`/etc/nexus/current.env`. It prepares, but does not activate, VPS config.
Vercel's deployment ID separately binds its build-environment snapshot. Any VPS
or Vercel config change requires a never-published source SHA; one SHA can become
current only once. Application deploy captures but never changes either config.

### Runtime identity API

| Endpoint | Contract |
|---|---|
| API `GET /livez` | `200 {"data":{"status":"alive"}}`; process only |
| API `GET /readyz` | `200` iff DB is reachable and sole revision equals baked expected revision; otherwise bounded `503` |
| API `GET /version` | no-cache baked SHA, expected DB revision, expected Oracle digest, task-contract digest |
| Web `GET /version` | public dynamic no-cache `{"source_sha":"<VERCEL_GIT_COMMIT_SHA>"}` |
| Worker health | recent heartbeat, live PID, baked SHA, lane/kinds/task contract, DB, schema |

Each worker's main polling/scheduler loop advances its lane-owned `/tmp`
heartbeat only after a successful cycle (at least every 5 seconds while
healthy); health rejects age over 20 seconds. Delete `/health`; all callers move
with no alias.

### Oracle publication

Oracle owns one current marker; presence means published:

```text
oracle_corpus_publications(
  corpus_key text primary key,
  manifest_digest text not null,
  embedding_provider text not null,
  embedding_model text not null
)
```

Code accepts only key `current` and validates domain values; no business `CHECK`
belongs in the database. Oracle reads/generation require marker and pure
readiness to match digest, provider/model, DB corpus/selector, and R2 size/type
sets. No fallback exists.

`reconcile-oracle.sh <source-sha>` is allowed only after a release record exists
and the SHA is current. Under the shared lock it binds the record's expected
digest and immutable VPS config path; ambient config and future/old candidates
are invalid. It loads owned attempt state first: any nonterminal attempt resumes
before status evaluation. Exact status may no-op only with no nonterminal attempt
and the recorded current runtime already healthy.

A mutating run creates
`/var/lib/nexus/releases/oracle-attempts/<source-sha>-<digest-hex>.json` before
stopping writers. It binds target SHA/digest, config path/digest, prior marker,
exact current containers, phase, and timestamps:

```text
Prepared -> WritersStopped -> Unpublished -> SupportReconciled
         -> Published -> RuntimeRestored -> Succeeded
```

A nonterminal attempt admits only same-target replay and blocks other host
mutators. The Python owner:

1. computes canonical input identity before mutation and no-ops only on exact
   read-only DB/R2 readiness; unsupported removals reject before an attempt;
2. rejects removal of any active work/anchor/plate key (80/20 manifests are
   additive/update/source-replacement only), then stops/proves-stopped API and
   both workers before deleting/committing the marker;
3. reconciles through existing plate/library/source/index owners, orders R2
   objects before DB metadata, drains only declared Oracle jobs, and never spans
   a DB transaction across HTTP, R2, or drain;
4. proves exact DB/selector/R2 readiness, inserts the marker last in one short
   transaction, then restarts/proves the exact recorded current release.

Replay converges the same target; after unpublish, writers normally remain
stopped until success. A late crash may occur after the exact marker is
published and the captured runtime starts but before `RuntimeRestored` is
durable. Replay re-stops those exact writer IDs, converges and re-proves, and
restores the exact runtime.

If target A has a nonterminal attempt but A's controller/domain code is
defective, `reconcile-oracle.sh A --repair-source-sha B` admits exactly one
clean-main/CI immutable bundle B whose expected database revision and Oracle
digest equal A. Under the same lock, installation pulls and proves B's two
images but creates no application attempt/record/current/config activation. It
then create-only records
`oracle-repairs/<A>-<digest-hex>.json`, binding A's target/schema/digest to B's
manifest hash, image refs, and image IDs. B's controller and worker image replay
the exact immutable A attempt, A Compose file, A captured config, and A runtime
snapshot. Completion restores/proves the exact A runtime and public vector. A
second B, implicit A execution after binding, state replacement/deletion,
generic override, and fallback are invalid; replay requires the exact A+B pair
and retains the binding as provenance.

Physical garbage collection is out of scope. Application release never
calls/waits for reconcile.

## System composition

### CI

Manual PR-check recovery accepts `pull_request_number`, `expected_head_sha`, and
`expected_base_sha`; requires an open same-repository PR to `main`; proves the
synthetic merge's parents; then runs the same `Deterministic PR proof` job.
SHA tags are discoverability only; production consumes manifest digests.

### Application release

1. Require clean `HEAD == requested SHA == origin/main`; resolve the exact CI
   artifact, then inspect host-owned state before selecting any frontend.
   `current == SHA` re-proves the recorded public vector and returns success. A
   same-SHA nonterminal attempt reuses only its bound Vercel ID; `RolledBack`,
   `ForwardFixRequired`, or a previously succeeded-but-superseded SHA rejects
   permanently and requires a new successful `main` SHA.
2. Prove the committed production host, Vercel project ID, team ID, project
   name, and domain policy. Resume inspects the durable exact deployment ID
   before the mutable production alias; only an identity-matching terminal
   response or recognized 404 in that fixed team scope may settle state.
   Malformed or identity-mismatched provider data changes nothing. Only for a
   new attempt, select the newest `READY`, production-target, unpromoted Vercel
   deployment for the exact project/SHA and prove candidate `/version`. Host
   `apply` acquires `flock`, rejects any conflicting operation, and validates
   config, Compose/Caddy equality, capacity, identities, rollback evidence, DB
   ancestry, and one candidate Alembic head. Reject absent, ahead, divergent,
   or multiple current DB revisions. Pull images, then durably create `Prepared`
   with the bound deployment ID.
3. Stop/prove-stopped app writers only. Never stop or
   recreate Postgres/Caddy.
4. If migration is pending, write custom-format `pg_dump` via `.partial`; prove
   nonzero and `pg_restore --list`; hash/fsync/rename; then durably record
   its path, candidate SHA, database identity, starting revision, bytes, and
   SHA-256. Record `DataMutationStarted` before `alembic upgrade head`. Reuse,
   never overwrite, an exact existing backup on replay.
5. Prove one resulting revision. Record `BackendActivationStarted`; start app
   services by digest with a bounded Compose health wait; then prove exact API
   body, both workers, shared task-contract digest, schema, and unchanged infra.
6. Before host `apply` stops writers, the local deploy runs the candidate-safe
   frontend auth smoke against the staged Vercel URL. This checks only
   origin-independent redirects, recovery rendering, cache privacy, public
   pages, and stale-cookie handling; it cannot use the production callback
   allowlist from a generated candidate URL. A failure blocks before host
   mutation.
7. Host `apply` stops at `AwaitingFrontendPromotion`. Local deploy promotes only
   the bound Vercel ID, resolves the authoritative host, and runs the full
   post-alias auth smoke. If that smoke fails, it settles the attempt with
   `post-alias-auth-smoke-failed` and stops writers for a forward fix; it never
   mislabels an auth-oracle failure as a missing Vercel deployment. On success,
   it calls host `finalize --deployment-id`. Finalize re-proves public web/API,
   workers, DB, images, and config before publishing record/current.

Rerunning `deploy.sh <sha>` is the only resume command. The root-owned installed
bundle is authoritative for replay and current verification even after the CI
artifact expires. Freeze `main` from the first invocation through `Succeeded`,
`RolledBack`, or `ForwardFixRequired`; every ordinary replay retains clean
`HEAD == origin/main == sha`. New migrations are linear, hand-written,
transactional by default, forward-only, and tested on an empty DB plus focused
data. Unavoidable autocommit must be replay-safe and have a dedicated
interruption test.

### Failure policy

- A crash is replay input, not terminal failure. Resume from durable evidence.
- Retry one exact external operation once. Retry identity is phase plus semantic
  checkpoint; different operations never consume each other's budget.
- Before both `DataMutationStarted` and `BackendActivationStarted`, an ordinary
  attempt with no `forward_fix_of` pointer may restore/prove its trusted
  predecessor and record `RolledBack`. At or after either boundary, predecessor
  code never runs: recover the same SHA or record `ForwardFixRequired`. Any
  failure of a forward-fix successor also records `ForwardFixRequired`, even
  before either boundary, because the failed predecessor must never restart.
  This covers candidate-writer and frontend side effects even when no migration
  exists.
- Post-mutation inspection may prove the candidate and continue. Never infer
  safety from an apparently old `alembic_version`; autocommit effects may exist.
- Resume never reselects Vercel. If the authoritative host serves the bound
  candidate, finalize; if it still serves the predecessor, retry promotion of
  that bound ID; any other deployment fails closed.
- `RolledBack`/`Succeeded` permit a new SHA; nonterminal attempts block one. A
  forward-fix pointer admits only a never-published successor that durably bound
  that exact pointer at `Prepared`. Only that succeeded successor clears it. The
  first release re-proves the adopted exact identity vector. A fresh SHA is
  acceptable because the adoption SHA is provenance, not candidate identity;
  a forward-fix first successor additionally requires the bound pointer and
  stopped-writer proof described above.

## File plan

Create:

- `.github/workflows/backend-images.yml`, `docker/Dockerfile.backend`;
- `deploy/hetzner/release.py`, `deploy/hetzner/reconcile-oracle.sh`,
  `deploy/hetzner/fetch-release-bundle.sh`,
  `deploy/hetzner/adopt-infrastructure.py`;
- `python/nexus/runtime_health.py`, `python/nexus/api/routes/operational.py`;
- `apps/worker/health.py`, `apps/web/src/app/version/route.ts`;
- Oracle publication migration/helper and focused behavior tests.

Modify:

- `.github/workflows/ci.yml`, `.dockerignore`, local worker Compose;
- `deploy/hetzner/{deploy.sh,docker-compose.yml,sync-env.sh}`;
- API/worker entrypoints, auth public paths, and every health consumer;
- Oracle corpus/plate services/scripts: one reconcile owner and pure status;
- `deployment.md`, architecture/provisioning/config docs, and release-risk tests;
- permanent resource-sharing WAF apply/check only; remove cutover modes.

Delete at hard cut:

- `docker/Dockerfile.api`, `docker/Dockerfile.worker`;
- old `/health`, `CUTOVER_SHA`, build/tag/rollback/rsync/`force-recreate` paths;
- both `resource-sharing-cutover.sh` files and maintenance JSON;
- `deployment_migrations.py` and gate tests after production-head proof;
- `supabase-exit-check.sh` after its audit passes;
- duplicate completed deployment instructions.

Retain historical Alembic revisions, immutable migration inputs, permanent WAF
policy, and current product behavior tests.

## Implementation order

1. Add failing state, health, migration, Oracle, and recovery behavior tests.
2. Publish immutable images/manifest; prove both targets locally.
3. Cut config, identity, health, Compose, and host control to the new contracts.
4. Prove backup plus interruption recovery at every durable boundary.
5. Add exact staged Vercel handoff/public proof.
6. Make Oracle independently reconcilable and fail closed.
7. Delete every legacy path, collapse living docs, pass the complete release-risk
   gate, then execute one reviewed maintenance-window cutover.

## Acceptance criteria

1. No VPS app build, mutable app tag, checkout rewrite, runtime SHA injection,
   implicit config sync, implicit Oracle mutation, or alternate release path.
2. One validated manifest controls API/worker digests and expected schema; both
   images prove baked identity.
3. Concurrency, crash replay, first release, terminal SHA, and forward-fix
   histories are deterministic; no predecessor runs after either commitment
   boundary. Every pending migration has a verified durable backup.
4. Health proves real process/DB/schema/identity/lane/task readiness; absent
   production identity defects.
5. Postgres and Caddy identities/config remain unchanged during app release.
6. Only the bound Vercel candidate is promoted; afterward public frontend, API,
   workers, DB, captured config, release record, and current SHA agree.
7. App release succeeds without reading Oracle. Oracle independently no-ops
   when exact, unpublishes before mutation, converges after crash, rejects
   removals, quiesces writers, and publishes only after exact readiness. A
   defective nonterminal controller resumes only through one create-only,
   identity-equivalent repair binding and restores the exact target runtime.
8. Power loss cannot partially publish local state; external-promotion prefixes
   finalize idempotently.
9. `/health`, `CUTOVER_SHA`, broad recreation, completed controllers, duplicate
    Dockerfiles, and old release paths have zero references.
10. `deployment.md` is the sole runbook and repository release-risk gates pass.
