# Bounded-resource media processing hard cutover

**Status:** Implemented · awaiting immutable release and post-deploy proof ·
2026-08-07

**Type:** One-release hard cutover. No flag, dual path, fallback parser,
compatibility adapter, or legacy worker policy survives.

## Decision

Keep the current durable source lifecycle, Postgres queue, two workers,
content-index operation, and immutable release controller. Add only:

- one queue-owned `Heavy` class and global capacity lease;
- hard container/host memory budgets and release preflight;
- file-backed, aggregate-bounded PDF/EPUB extraction;
- lease-fenced source progress;
- one composed Activity read model and exact repair action.

Move `ingest_media_source` from the interactive lane to the background lane.
Classify it and `media_content_reindex_job` as `Heavy`; every other job is
`Light`. This conservatively serializes all source ingest because the current
job kind is polymorphic. Payload scoring is not warranted for one user.

This document supersedes only worker placement, parser resource behavior,
progress/repair presentation, and host-capacity requirements in
[media-pipeline-reliability-hard-cutover.md](media-pipeline-reliability-hard-cutover.md).
It does not reopen
[durable source ingest](durable-source-ingest-hard-cutover.md),
[document readiness](media-document-readiness-hard-cutover.md), or the
[immutable release](immutable-production-release-hard-cutover.md).

## Scope and 80/20 boundary

In scope:

- uploaded, captured, and remote PDF/EPUB processing;
- full media reindex admission;
- queue claim/lease/heartbeat/recovery composition;
- source progress, Activity, and source/search repair;
- production Compose limits, deploy preflight, migration containment, and
  unknown running-container detection.

Non-goals:

- Redis, Temporal, Vercel Workflow, Kubernetes, another broker, or another job
  state machine;
- a third worker, horizontal scaling, fairness, dynamic priority, or learned
  admission;
- durable page/chapter resume; a killed attempt restarts from its preserved
  original;
- OCR, parser replacement, browser/local parsing, or remote compute;
- cancellation, pause, queue reordering, ETA, or fabricated percentage;
- Prometheus, paging, a general operator dashboard, or broad host tuning;
- automatic cleanup or `docker system prune` on production;
- changing accepted-intent, media-readiness, retrieval-readiness, or index
  revision ownership.

## Rules and goals

Follow `docs/rules/*`, especially `correctness`, `operation-types`,
`concurrency`, `retries`, `boundaries`, `database`, `frontend`, `polling`,
`testing`, `cleanliness`, and `simplicity`.

- API/Postgres availability outranks batch latency and throughput.
- Admission limits concurrency; cgroups contain an admitted bad job. Both are
  mandatory.
- Capacity denial is waiting, never failure, and never consumes an attempt.
- Only queue infrastructure touches capacity state.
- Progress is monotonic within one run and exact-lease-fenced.
- Only supervisor/cgroup evidence may say OOM; otherwise say worker
  interruption.
- Database conflicts retry only the smallest existing serializable publication
  phase; parsing is not repeated for a publication-only conflict.
- Originals survive parser, worker, deploy, and index failure.
- A pathological document may fail inside the declared envelope; it cannot
  kill API, Postgres, Caddy, or the interactive worker.

## Target behavior

### Admission

1. Existing acceptance commits the media, original, source attempt, placement,
   and queue job before expensive work.
2. A claim excludes capacity-ineligible Heavy rows, then preserves existing
   priority/time order among eligible rows.
3. Heavy claim and capacity acquisition commit atomically.
4. A blocked Heavy row remains due and unchanged; eligible Light work proceeds.
5. Job heartbeat renews the matching capacity lease atomically.
6. completion, failure, reschedule, dead letter, and exact replay clear or
   replace the exact holder atomically.
7. A crash becomes reclaimable only after the database clock expires the job
   and capacity leases.
8. Expired-lease reclaim records `E_WORKER_INTERRUPTED`, never inferred OOM.

### Extraction

PDF:

- stream storage to an attempt-scoped temporary file;
- open PyMuPDF by path;
- normalize one page at a time and join normalized text once;
- retain compact spans and bounded apparatus only;
- fail terminally with `E_SOURCE_TOO_LARGE` above `10,000` pages, `32 MiB`
  aggregate normalized UTF-8 text, `2,000` retained apparatus items/edges, or
  `8 MiB` retained apparatus UTF-8 text;
- bound page blocks, links, text lines, references, native links, legal targets,
  and legal markers before committing them to the extraction plan.

LaTeX source apparatus:

- select at most `8 MiB` aggregate `.tex`/`.bib` source from the already-bounded
  source archive;
- retain at most `2,000` items, `2,000` edges, and `8 MiB` output UTF-8 text;
- surface resource-limit breaches through PDF ingest as terminal
  `E_SOURCE_TOO_LARGE`; malformed non-resource source packages remain apparatus
  diagnostics and do not invalidate an otherwise readable PDF.

EPUB:

- stream storage to an attempt-scoped temporary file and open ZIP by path;
- preserve existing archive count/size/ratio/time gates;
- sanitize/canonicalize one spine item at a time;
- upload assets with existing `put_object_stream`; `_AssetEntry` retains no
  bytes;
- retain only bounded chapter/navigation/apparatus publication data;
- fail terminally with `E_ARCHIVE_UNSAFE` above `64 MiB` aggregate sanitized
  HTML plus canonical UTF-8 text.

Both:

- all page/text/apparatus limits above plus
  `EPUB_RENDERED_TEXT_MAX_BYTES = 64 MiB`, `EPUB_APPARATUS_MAX_TARGETS = 10,000`,
  `EPUB_APPARATUS_MAX_BACKLINKS = 10,000`, and
  `EPUB_APPARATUS_MAX_RETAINED_UTF8_BYTES = 8 MiB` are committed parser
  constants, not production tuning knobs;
- every storage stream requires the persisted byte length, aborts and removes
  the partial file on overflow/underflow, and hashes while writing; source
  packages additionally match the persisted SHA-256 before archive parsing;
- `PARSER_TEMP_ROOT` is one validated absolute-path setting; production binds
  `/var/lib/nexus/parser-tmp`, local/test use an isolated temp root;
- each operation owns a UUID directory; every execution owns a distinct private
  UUID child with mode `0700`, so overlapping retries cannot delete peer work;
- apparatus extractors accept a path/seekable file, not whole-source bytes;
- each execution clears only its owned child on every terminal path; a retry
  creates a new child rather than deleting a possibly live peer;
- worker startup prunes only stale Nexus parser-temp directories after proving
  no live matching job;
- no storage/filesystem I/O occurs in a publication transaction;
- final publication keeps current source-attempt and queue-lease fences;
- content indexing remains the existing durable successor.

Document content indexing:

- retains the existing prepare/provider/publish lifecycle and canonical tables;
- streams a `420`-word window with `60`-word overlap without retaining every
  regex match or chunk;
- sends at most `64` chunk texts per embedding call, with each chunk capped at
  `256 KiB` encoded UTF-8;
- writes document-only plans to an operation-scoped closed JSONL spool capped
  at `384 MiB`; note and transcript indexing retain their existing in-memory
  plan;
- records one exact header, contiguous chunk records, and one count/digest
  trailer; publication validates owner, source, block count, model,
  dimensions, order, parts, count, and digest while reading one chunk at a
  time;
- performs provider calls and spool writes outside database transactions, then
  retains the existing single fenced atomic replacement transaction;
- reports chunk/spool envelope breaches as safe `E_SOURCE_TOO_LARGE`; malformed
  or incomplete same-system spools defect and roll back, preserving the prior
  materialization;
- removes its exact partial or complete scratch plan on success, supersession,
  resource rejection, provider failure, or publication failure; worker startup
  removes only operation roots proven to have no exact nonterminal queue work.

### Progress and recovery

- stages are `Validate`, `Extract`, `Finalize`;
- PDF counts pages every 10 pages; EPUB counts each chapter;
- progress uses a fresh session and existing media -> attempt -> queue lock
  order;
- a new run resets counted progress before extraction;
- lease-lost work cannot advance progress or publish;
- exact source/index dead letters project `NeedsAttention` and exact repair;
- repair replays only the current dead source attempt or content revision;
- dead letter does not fabricate a domain failure.

## Architecture and ownership

```text
accepted source -> ingest_media_source(Heavy)
  -> background claim + global Heavy lease
  -> file-backed bounded extraction + fenced progress
  -> fenced complete reader publication -> ready_for_reading
  -> media_content_reindex_job(Heavy)
  -> existing revision-fenced index publication

Activity = media + latest source attempt + exact jobs + content-index state
```

| Concern | Sole owner |
| --- | --- |
| resource class | `jobs/registry.py` |
| capacity acquire/renew/release | `jobs/queue.py` |
| worker composition | `jobs/worker.py` |
| source progress | `services/source_publication.py` |
| bounded parsing | existing PDF/EPUB ingest services |
| source/index lifecycle | existing source/content-index owners |
| Activity projection | new `services/media_activity.py` |
| repair capability | `services/capabilities.py` + ingest recovery |
| UX | Nexus Activity workflow + shared media presenter |
| host/release proof | production Compose + `release.py` |

## Persistence

Migration `0212_bounded_resource_media_processing.py` adds:

### `background_job_capacity_leases`

Seed exactly one row with `resource_class = 'Heavy'`.

```text
resource_class  text PK; queue owner accepts only Heavy
job_id          nullable FK background_jobs(id), no delete cascade
worker_id       nullable text
attempt_no      nullable integer
lease_expires_at nullable timestamptz
updated_at      non-null timestamptz, database clock
```

The queue owner enforces all holder fields absent or present together and a
present `attempt_no >= 1`. The row is transient queue infrastructure, not
product/domain history.

### `media_source_attempts`

```text
processing_stage    nullable text: Validate | Extract | Finalize
progress_completed non-null integer default 0
progress_total      nullable integer
progress_unit       nullable text: Page | Chapter
progress_updated_at nullable timestamptz
```

Total/unit are both absent or present. Counted shape is
`0 <= completed <= total`, `total > 0`. Existing rows become no stage, zero
completed, and absent counted progress.

Per `docs/rules/database.md`, migration `0212` adds no business `CHECK`
constraints for these owner-validated closed values or multi-column shapes;
the queue and source-publication owners reject invalid writes.

Add no media/job/index status, history table, parser-run table, progress event
table, or resource-class column on `background_jobs`.

## Queue contract

`JobDefinition` gains required
`resource_class: Literal['Light', 'Heavy']`; its value enters the task-contract
digest. Lane sets remain disjoint and exhaustive:

- remove `ingest_media_source` from interactive;
- add it to background;
- keep both deployed workers single-process/single-replica.

`claim_next_job` and `claim_job` receive registry-derived Heavy kinds. Queue
claim locks the capacity row, expires an exact stale holder, selects one
eligible row, and atomically claims job plus capacity. Domain handlers never
receive or release capacity state.

## Capability and API contract

Keep existing capabilities. Add:

- `can_repair_source` for an authorized media whose current attempt owns an
  exact dead source job;
- `can_repair_search` for an authorized media whose current revision owns an
  exact dead reindex job;
- `source_progress: Presence<SourceProgress>` to `MediaOut` and media SSE.

`SourceProgress` is closed:

```text
Stage { kind, stage, run_count, updated_at }
Counted { kind, stage=Extract, completed, total, unit, run_count, updated_at }
```

`can_retry` remains ordinary modeled source retry. Repair is never relabeled
Retry. Read and search capabilities retain independent owners.

### `GET /media/activity?limit=20`

The current contract is owned by
[`media-activity-attention-hard-cutover.md`](media-activity-attention-hard-cutover.md).
It hard-replaces the original response and presentation above while retaining
this document's source, job, progress, repair, and capability owners. Activity
now returns a strict nested `Active | NeedsAttention` union, exact
`needs_attention_count` and `active_count`, and `has_more`; complete work is
absent before ordering and limiting.

### `POST /media/{media_id}/repair`

Closed request `{ "scope": "Source" | "Search" }`. The thin route authorizes
mutation, exact-matches current dead work, calls existing recovery, and returns
`202 { media_id, scope, job_id }`. Stale, non-dead, wrong-scope, or unavailable
work returns `E_REPAIR_NOT_ALLOWED`. Internal routes reuse the same service.
`errors.py` owns the new code; it is never used for ordinary Retry.

## Product contract

Activity is a Nexus switchboard workflow, not a pane or new router destination.

- App navigation badges only current actionable failures. Active work is quiet
  and never badges; complete work is absent.
- Rows retain the factual current stage, including `Finalize`, without
  inventing percentage or ETA.
- Copy remains factual: `Waiting for capacity`, `Extracting page 84 of 712`,
  `Waiting to retry`, `Worker interrupted; recovering`, and `Needs repair`.
- A reclaimed attempt says worker interruption, never inferred OOM, satisfying
  the interruption rule in Rules and goals. Interruption is read from the exact
  queue evidence (`E_WORKER_INTERRUPTED`), never from a heuristic.
- Delete `Processing paused`.
- Show counted units, never percentage or ETA.
- Details expose safe stage/code, attempts, timestamps, and request ID; never
  raw queue errors, payloads, stack traces, or host paths.
- Poll every 5 seconds only while the last good snapshot has active work, using
  the bounded single-flight lifecycle and invalidation rules in the Activity
  attention cutover. No global SSE plane is added.

## Production resource contract

the numeric envelope and release checks below record the original cutover.
current resource limits and admission policy are owned by
[production deployment](../../deployment.md); validation is owned by the
[testing standards](../local-rules/testing-standards.md).

Use non-Swarm Compose `mem_limit`, equal `memswap_limit`, `mem_reservation`,
and `pids_limit`:

| Service | Reservation | Hard memory | PIDs |
| --- | ---: | ---: | ---: |
| Postgres | 256 MiB | 512 MiB | 256 |
| Caddy | 32 MiB | 48 MiB | 128 |
| API | 192 MiB | 320 MiB | 256 |
| interactive worker | 128 MiB | 256 MiB | 256 |
| background worker | 128 MiB | 448 MiB | 256 |
| Codex egress policy | 32 MiB | 64 MiB | 32 |
| Codex generation host | 256 MiB | 448 MiB | 64 |

Reservation sum: `1,024 MiB`; hard-cap sum: `2,096 MiB`; host reserve: at
least `320 MiB`; service swap is excluded. Hard caps are containment ceilings,
not an allocation budget: their sum deliberately exceeds host memory, while the
complete reservation sum plus the host reserve fits the committed real
`MemTotal`. Admission rejects pressure or insufficient headroom before bounded
work starts, and the Codex host has a separate candidate-bound live
qualification.

Docker's `HostConfig` is desired-state evidence, not the enforcement oracle.
For every running service the controller resolves the exact host PID's cgroup
v2 path and requires `memory.low == mem_reservation`, `memory.max == mem_limit`,
`memory.swap.max == 0`, and exact `pids.max`. It also requires
`memory.swap.current == 0`: correcting `memory.swap.max` prevents new swap but
does not evict pages retained under an older policy, so that transition needs a
planned restart of the exact container before capacity qualification.

The envelope is sized against real `MemTotal`, not the host's nominal RAM. A
nominal 2 GiB instance reports `1,919.6 MiB`. The interactive worker's measured
peak reached `223 MiB`; its former `224 MiB` limit plus the former full-runtime
health subprocess caused a production cgroup OOM. The health subprocess is now
stdlib-only, and the `256 MiB` limit leaves measured process margin while the
complete reservation envelope leaves `895.6 MiB` on that measured host before
ordinary host allocation. The background worker keeps `448 MiB` because that
is the measured bounded-parser envelope. The Codex host reserves `256 MiB`, is
contained at `448 MiB`, and must qualify below a `384 MiB` retained peak before
its first promotion.
Migration job: `512 MiB`, `256` PIDs after application writers stop.

Before merge, isolated parser-process RSS probes validate representative bounded
documents and typed pathological failures; a separate real-stack journey proves
protected services remain healthy. If a service cannot fit, change the committed
envelope or reduce batch work; never remove a hard limit silently.

Host requirements:

- cgroup v2 memory controller;
- at least `1 GiB` emergency swap;
- parser-temp is one real, non-symlink directory owned by `10001:10001`, mode
  `0700`, with at least `512 MiB` free;
- no unknown running container outside the exact Nexus project;
- preflight prints exact IDs/project labels and blocks; the operator removes a
  stale stack only through its exact Compose project. No wildcard cleanup.

## Release contract

Before a new release attempt exists, the immutable controller performs one
replay-safe resource convergence pass. It first proves exact live container
identity, project labels, mounts, host capacity/pressure/disk, absence of
foreign containers, and that every container's current memory/PID use fits the
target envelope. It may apply only the committed limit update to an unhealthy
exact predecessor with verified identity and safe current usage. It applies all
such updates, proves the kernel limits, then stops before candidate measurement
or attempt creation if any exact cgroup retains pre-contract swap. A planned,
identity-proved restart settles that one-time state; a replay then freshly
proves health. Every other failed proof mutates nothing. This is permanent
release behavior, not an operator exception.

Ordinary preflight before writer stop validates:

- exact Docker metadata and cgroup-v2 memory, zero-swap, and PID enforcement;
- `MemTotal`, `MemAvailable >= 256 MiB`, swap, temp disk, and backup disk;
- memory PSI `full avg10 == 0` and `some avg10 <= 5`;
- no unknown running container;
- current memory, restart, and OOM evidence for operator output only.

Replay refreshes these volatile facts before any remaining writer stop and
again immediately before backup or migration. Persisted attempt evidence never
stands in for current pressure, disk, memory, swap, container state, or limits.

Apply order:

1. converge exact resource limits; if an exact writer was unhealthy, stop and
   require a later replay after Docker health recovers;
2. finish ordinary preflight while the predecessor is healthy;
3. stop/prove stopped background first, preventing new Heavy claims;
4. stop/prove stopped interactive and API;
5. backup when migration is pending;
6. run bounded Alembic;
7. activate/prove API and workers with exact limits;
8. continue existing frontend promotion/proof.

Before `DataMutationStarted`, restart the exact predecessor on failure. After
it, preserve existing forward-fix-only policy. Add no database downgrade.
Migration replay accepts or removes only the exact candidate one-off: name,
project/service/one-off labels, image reference and ID, command, stopped state,
exit status, and resource limits must all match, and the Compose config-hash
label must be present and well formed. Compose derives that label from its own
internal service digest, which `docker compose config --hash` does not
reproduce, so replay proves Compose authored the container and pins the actual
execution through the immutable bundle's image ID, command, and limits rather
than by recomputing the hash.

## System composition

- Durable source ingest remains accepted-intent/retry owner.
- Media pipeline reliability remains exact source/reindex fencing; this changes
  one kind's lane.
- Document and retrieval readiness remain separate.
- Content indexing gains Heavy admission, not a lifecycle rewrite.
- Document index planning is bounded and file-backed; its canonical publication
  and read model are unchanged.
- Storage reservations own EPUB objects; parser-temp cleanup owns only exact
  host-local attempt directories.
- Media SSE and Activity share `source_progress`; Activity persists nothing.
- Immutable release remains the only production mutation entrypoint.
- Public repair is an authorized doorway over existing recovery, not a second
  implementation.

## Hard-cut gates

Delete in the same cutover:

- old interactive ingest membership and expectations;
- PDF/EPUB `b"".join(stream_object(...))` acquisition;
- byte-stream PyMuPDF and duplicate whole-PDF apparatus passes;
- `_AssetEntry.content` and EPUB asset-byte accumulation;
- unbounded raw/normalized whole-document intermediates;
- corpus-wide content-index word matches, chunk plans, texts, and embeddings;
- task-contract hashing without resource class;
- progress writes outside the fenced source owner;
- `Processing paused` and dead-job-as-Retry presentation;
- every temporary flag, alias, wrapper, fallback, dual claim path, legacy
  decoder, and test supporting a removed path.

Repository search must prove absence. Do not retain wrappers.

## Non-overlapping work boundaries

### A. Queue/schema/topology

Owns migration `0212`, `db/models.py`, `jobs/{queue,registry,worker}.py`,
`job_topology.py`, `config.py`, `apps/worker/*`, and their tests. Delivers
capacity and lane cut.

### B. Extraction/progress

Owns PDF/EPUB ingest+lifecycle, `media_source_ingest.py`,
`source_publication.py`, document `content_indexing.py` planning,
`tasks/media_content_reindex.py`, existing storage-stream use, and focused
tests. Delivers bounded parsing, indexing plans, and progress. Does not edit
queue/API/UI/deploy.

### C. Read model/API

Owns new `services/media_activity.py`, `schemas/media_activity.py`, and
`api/routes/media_activity.py`; `errors.py`; media/capability/recovery services;
media schemas/routes/SSE; router registration; and focused tests. Does not
mutate job/source policy.

### D. Product UI

Owns new `lib/media/activityClient.ts`, `lib/media/MediaActivityProvider.tsx`,
and `components/nexus/MediaActivityPage.tsx`; shell wiring;
AppNav/NavRail/MobilePaneBar; Nexus workflow; shared status copy; and
browser/component tests. It derives no backend lifecycle state.

### E. Host/release

Owns production Compose, `release.py`, env/deployment docs, and deployment
contract tests. It changes no application job semantics.

### F. Integration/cleanup

After A-E, owns cross-boundary tests, docs alignment, grep gates,
the layered resource rehearsal, and temporary-test-helper deletion. The
critical real-stack journey uses the manifest-owned 712-page PDF recipe and
the public upload protocol against per-run Postgres/MinIO/Supabase, the real
host API, both workers, and the production web build. It proves lifecycle,
Activity, completed content indexing, typed parser rejection, and interactive
`chat_run` completion during Heavy work. The isolated parser probe owns peak
RSS; Compose and the release controller own exact container limits. The local
journey does not claim Caddy or cgroup runtime containment. It redesigns no
owner.

Order: A -> B -> C -> D -> E -> F. No partial phase is production-admissible;
all application contracts ship in one immutable release/no-use window.

## Acceptance criteria

Queue/correctness:

- concurrent workers start at most one Heavy job;
- denied Heavy claims mutate nothing and do not block eligible Light work;
- every job transition preserves one exact capacity holder or none;
- stale holders cannot publish progress/artifacts;
- lane sets are disjoint/exhaustive and ingest is not interactive;
- task digest covers resource class; DB conflicts retry only publication.

Extraction/lifecycle:

- source/archive/asset bytes are streamed/file-backed, never accumulated;
- exact storage length and source-package digest are verified before parsing;
- page, text, structural, selected-source, and apparatus limits produce typed
  safe failures and remove attempt files;
- document indexing holds at most one `64`-chunk embedding batch, never
  materializes the corpus word/chunk/vector graph, enforces `256 KiB` chunks
  and a `384 MiB` closed spool, and removes scratch state on every path;
- corrupt, truncated, oversized, foreign, stale, or superseded document plans
  cannot replace the prior canonical index;
- progress is monotonic, full-snapshot, and lease-fenced;
- SIGKILL preserves original and converges through retry/exact repair;
- readable artifacts survive indexing wait/failure;
- isolated parser-process RSS for a representative 712-page PDF, low-text
  over-limit link PDF, over-limit LaTeX source apparatus, maximum-safe EPUB,
  and pathological EPUB remains below `448 MiB`;
- the real-stack 712-page PDF exposes counted progress, completes Heavy source
  and content-index work, and preserves API, authenticated-read, and a grounded
  `chat_run` completed by the Light interactive worker;
- a valid-signature truncated PDF reaches the background parser and publishes
  exact typed rejection;
- exact cgroup enforcement and Caddy survival remain release/post-deploy
  evidence, never an inference from the host-process journey.

API/product:

- Activity is viewer-filtered and composed from canonical rows;
- variants are exhaustive in backend/frontend tests;
- repair rejects stale, foreign, non-dead, superseded, and wrong-scope work;
- SSE and Activity agree; ready-with-index-wait remains readable;
- no paused copy, raw error, fake OOM, percentage, or ETA renders;
- polling is named, single-flight, and time-bounded.

Host/release:

- first-cut resource convergence is identity-proved and idempotent; an
  unhealthy exact predecessor may receive only its committed limit update,
  then no attempt/writer/DB mutation occurs until a healthy replay;
- `docker inspect` proves desired limits; host cgroup files prove enforcement
  and absence of retained service swap;
- preflight blocks pressure, missing swap/cgroup, low disk/memory, and unknown
  containers before writer stop;
- background stops before other writers;
- migration OOM cannot kill Postgres/Caddy and leaves exact recovery state;
- rollback-before-mutation, forward-fix-after-mutation, exact-SHA CI/runtime,
  resource, queue, live endpoint, and smoke proofs pass.

## Final state

Nexus accepts durably, admits expensive work once, bounds it by parser contract
and cgroup, isolates it from interactive service, publishes only complete fenced
artifacts, and explains waiting or exact repair. Large work may be slow or fail
inside the envelope; it cannot take production down.
