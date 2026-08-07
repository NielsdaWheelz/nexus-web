# Media pipeline reliability hard cutover

Status: IMPLEMENTED · FOCUSED LOCAL PROOF COMPLETE · PRODUCTION CUTOVER AND
VERIFICATION PENDING — 2026-07-24. The additive schema release and behavioral
deployment have not been performed.

## Review verdict

The incident and reliability gaps are real. The original proposal was
directionally correct but was not implementation-ready. Repository and
production validation found eight material corrections now incorporated here:

1. teardown needs seven measured referencing-side foreign-key indexes, not four;
2. EPUB, PDF, web, and X do not currently fail in the same way when indexing
   fails, so their attribution and cutover requirements must remain distinct;
3. `updated_at` is not a durable generation or worker-attempt fence;
4. retry exhaustion is a suspended dead-letter operation, not a modeled
   retrieval failure;
5. source retry/dead-letter semantics require exact lease fencing at every
   authoritative source publication, not only at reindex publication;
6. the two worker lanes must partition the declared production-enabled set,
   without silently enabling maintenance-only registry kinds;
7. concurrent migration steps must be exactly resumable after any partially
   committed prefix;
8. the Oracle corpus seed and Hetzner/local worker entry points are part of the
   cutover blast radius.

With the requirements below, the proposal is proportionate for a one-user,
frontier prototype: it keeps the existing Postgres queue and data model, repairs
the ownership boundaries that caused the incident, and adds only one durable
job, one monotonic revision column, and the indexes demonstrated by production
query plans. It deliberately avoids a workflow engine, general scheduler, or
parallel indexing system.

## Validated production evidence

The following is a read-only production snapshot from 2026-07-24. It validates
the problems; it is not a permanent capacity target:

- production was at Alembic head `0192` on PostgreSQL 15.17;
- `content_blocks` held 239,606 rows (556 MB),
  `content_chunk_parts` 242,890 rows, `content_chunks` 33,408 rows,
  `content_embeddings` 33,408 rows, and `evidence_spans` 33,408 rows;
- exact representative lookups for seven unindexed referencing foreign-key
  columns used sequential or parallel sequential scans;
- six completed `media_teardown` jobs took approximately 2.5, 32, and 59
  minutes, with four of the approximately 32-minute runs executing
  concurrently;
- the sole production worker had an unbounded database statement timeout and
  the ingest reconciler schedule was disabled;
- 61 document content-index rows had remained `pending` since 2026-06-08;
- three web fragments with headings lacked the source-owned Nexus heading
  anchors; all three belonged to the pending backlog;
- failed source attempts included 13 generic `E_INGEST_FAILED` results, eight
  raw `HTTP error: 403` messages, six `E_INVALID_FILE_TYPE` results, two Unicode
  XML-declaration failures, and two EPUB `E_LLM_BAD_REQUEST` failures.

The PostgreSQL behavior is expected: a foreign key does not automatically index
the referencing columns, and deletion of a referenced row may scan the
referencing table. See the
[PostgreSQL foreign-key documentation](https://www.postgresql.org/docs/current/ddl-constraints.html).

## Decision

Keep the existing Postgres job queue and Hetzner deployment. Add only:

- seven measured foreign-key lookup indexes;
- `content_index_states.revision`, a monotonic content-index intent identity;
- one durable `media_content_reindex_job`;
- exact claim fencing for every authoritative source and reindex mutation;
- two fixed worker lanes, `interactive` and `background`;
- periodic, enqueue-only reconciliation;
- strict source-adapter and shared HTML-parser result contracts;
- one capability-driven frontend error presenter.

Assumptions:

- one process and one replica per worker lane are sufficient;
- readable documents must remain usable when retrieval indexing is pending,
  suspended, or has a legacy modeled failure;
- blocked or ambiguous URLs fail with useful guidance, not an automatic browser
  fallback;
- automatic repair is the normal path, while a narrow internal operation
  replays an exact dead job;
- index planning may be repeated after a crash; no durable paid-call checkpoint
  or index-run ledger is warranted in this cutover.

## Problem statement and attribution

The observed failures are related but have different owners.

### 1. Teardown performs unindexed referential checks

`media_teardown` explicitly deletes the content graph, as required by the
resource-lifecycle rules. Production plans show unindexed referencing-side
lookups on:

| Referencing column | Referenced column |
| --- | --- |
| `content_blocks.parent_block_id` | `content_blocks.id` |
| `content_chunk_parts.block_id` | `content_blocks.id` |
| `evidence_spans.start_block_id` | `content_blocks.id` |
| `evidence_spans.end_block_id` | `content_blocks.id` |
| `content_chunks.primary_evidence_span_id` | `evidence_spans.id` |
| `content_embeddings.chunk_id` | `content_chunks.id` |
| `media_claims.evidence_span_id` | `evidence_spans.id` |

The explicit deletion design is correct. Missing lookup indexes and unbounded
statements made its implementation unsafe at the current data volume.

### 2. Source extraction and retrieval indexing have inconsistent boundaries

The current failure modes are not identical:

- EPUB invokes indexing before its extraction transaction commits. An
  unexpected embedding failure propagates through the source attempt and can
  roll back otherwise-readable artifacts. Production contains two such EPUB
  failures.
- PDF calls indexing from its lifecycle wrapper. Its exception path rolls back
  the current session before recording retrieval failure, so uncommitted
  extraction artifacts can be lost even though the materializer returns from
  the source path.
- web commits its source attempt before its post-success indexing call, and the
  indexing wrapper converts failures into retrieval state. Source truth is
  preserved, but indexing remains expensive, inline worker work without a
  durable recovery identity.
- X commits artifacts before invoking the web-article indexing wrapper. Source
  truth is likewise preserved, but indexing still shares the source worker call
  stack and lacks durable recovery ownership.

The common defect is therefore not “embedding failure fails every source.” It is
that retrieval work is not owned by one durable operation after source success,
and two source paths can still lose or fail readable work.

### 3. Repair exists but is disabled and performs provider work inline

`reconcile_stale_ingest_media_job` currently calls
`repair_ready_media_content_index_now` directly. Production has its periodic
schedule set to zero and has 61 long-lived `pending` rows. Enabling the current
implementation would move embedding and index rebuild work into the reconciler,
which is not an acceptable repair boundary.

### 4. Expected source/parser failures lose their structure

- the Node article process emits errors such as `HTTP error: 403`, while Python
  maps its coarse exit status to generic `E_INGEST_FAILED`;
- Gutenberg `.epub3`, `.epub3.images`, and `.epub3.noimages` URLs are not
  recognized by the explicit remote-file classifier;
- multiple production HTML paths pass already-decoded Unicode containing an XML
  encoding declaration to lxml, which lxml rejects by design; see the
  [lxml parsing documentation](https://lxml.de/parsing.html).

Queue-level `succeeded` with domain-level source `failed` remains intentional
only for a modeled source result. Unexpected protocol, invariant, database,
storage, or provider faults must raise so queue retry/dead-letter ownership is
not bypassed. That change is safe only after every authoritative source
publication validates and locks the exact current job claim.

### 5. Source publication is not fenced to the claimed worker attempt

The registry receives `JobExecutionContext` for `ingest_media_source` but does
not pass it into the task. `run_source_attempt` and source-specific materializers
commit running state, artifacts, observations, failures, and terminal state
across multiple transactions without checking the exact queue claimant,
attempt number, or lease. A stalled worker can therefore resume after its job is
reclaimed and publish over the newer worker.

The current catch-all source failure behavior does not make those commits safe.
Changing unexpected failures to queue retry/dead-letter makes exact publication
fencing an explicit prerequisite, not an optional follow-up.

### 6. One production worker creates avoidable head-of-line blocking

The registry contains 20 kinds, but the safe production allowlist intentionally
enables 15. Five maintenance-controlled kinds are excluded. Those 15 enabled
kinds still compete in one production worker, so teardown can delay
user-facing ingest and chat. This cutover adds reindex and intentionally enables
reconciliation, producing a declared production set of 17 kinds. The other four
maintenance kinds remain excluded.

Separating the 17 production-enabled kinds into user-facing and background
lanes removes queue-claim head-of-line blocking between those classes. It does
not eliminate shared database, network, provider, or host contention, and this
document does not claim that it does.

## Governing rules

Follow `docs/rules/*`, especially:

- one owner and one path per capability;
- durable jobs for work that must happen after a transaction;
- no provider, network, filesystem, or object-storage I/O inside a database
  transaction;
- `retry_serializable` for database retry: one session per retry boundary,
  rollback between attempts, and a complete state reload inside every attempt;
- schema constraints/indexes encode storage shape or measured access paths,
  never lifecycle/coalescing policy;
- bounded retries, leases, and database statements;
- typed expected failures and loud unexpected defects;
- dead letter means suspended execution and exact-operation replay;
- explicit deletion, with no cascade-based lifecycle cleanup;
- thin routes, service-owned policy, capability-driven UI;
- `Presence` for semantic absence at API and durable-payload boundaries;
- delete legacy paths, flags, shims, imports, tests, and docs in the same
  cutover.

## Goals

- User-initiated ingest and chat cannot wait behind teardown or maintenance
  queue claims.
- Source success means readable artifacts are durable, independent of retrieval
  indexing.
- A reclaimed source or reindex worker cannot publish after losing its exact
  queue claim.
- Every current eligible content revision converges to `ready`, `no_text`, or
  `ocr_required`, or remains visibly suspended behind its exact dead job.
- A newer source revision cannot be overwritten by an older job or a reclaimed
  attempt.
- Expected source failures have stable codes, retry policy, enforcement, and
  useful copy.
- Teardown uses indexed referential checks and fails within a bounded statement
  budget if a new query regression appears.
- Existing queue, lifecycle, capability, retry, lease, and recovery primitives
  remain the substrate.

## Non-goals

- No Temporal, workflow DSL, broker, queue migration, general priority
  scheduler, or per-user fairness system.
- No new public endpoint, persisted media/content-index state, capability,
  index-state table, index-run table, or retrieval column on `media`. The
  existing `processing_status` and `retrieval_status` read projections gain
  `suspended`.
- No public manual-reindex button or public reindex API.
- No universal content sniffing or automatic headless-browser fallback.
- No OCR implementation, X provider-credit repair, or attempt to make an
  inaccessible third-party site accessible.
- No horizontal worker scaling or provider-work concurrency inside one job in
  this cutover.
- No compatibility aliases, dual dispatch, legacy task wrappers, or old result
  fields.

## Final architecture

```text
public ingest command
  -> source service records durable source intent + source attempt
  -> interactive worker runs source adapter
  -> every authoritative source transaction:
       locks media + source attempt + exact queue claim
       stale/reclaimed worker publishes nothing
  -> final fenced source-success transaction:
       readable normalized artifacts are durable
       media = ready_for_reading
       source attempt = succeeded
       content-index revision += 1 and state = pending
       exactly one waiting reindex successor exists

background worker claims media_content_reindex_job(revision)
  -> prepare transaction: validate and snapshot immutable index input
  -> plan chunks + call embedding provider with no DB transaction open
  -> publish transaction:
       lock and validate the exact queue lease
       lock and compare the content revision
       replace the complete materialization
       state = ready | no_text | ocr_required

periodic reconciler
  -> discover bounded stale/retryable domain rows
  -> ensure canonical jobs only
  -> never call an embedding provider or rebuild an index

media deletion
  -> background worker
  -> indexed explicit child deletion
```

### Ownership

| Concern | Sole owner |
| --- | --- |
| Accepted source and attempt state | `media_source_ingest.py` + `media_source_attempts` |
| Source publication fencing | source service + queue-owned exact-claim lock |
| Same-source terminal policy | one predicate in `capabilities.py` |
| Readable document state | media processing service + `media.processing_status` |
| Content revision, state, and materialization | `content_indexing.py` + `content_index_states` |
| Reindex job coalescing and queue-row mutation | `jobs/queue.py` through a content-index service doorway |
| Queue retry, lease, dead letter, and exact replay | job registry/worker/queue |
| Repair discovery | stale-ingest reconciler |
| Source-specific fetch/extraction | source adapters |
| HTML document parsing | `html_tree.py` |
| Error-to-action presentation | one frontend media-error presenter |
| Worker topology | `config.py` lane constants + deployment entry points |

## Capability contract

Existing public fields remain authoritative:

- `processing_status`: source/document lifecycle plus current source-job
  suspension projection;
- `retrieval_status` and `retrieval_status_reason`: retrieval lifecycle plus
  current queue-suspension projection;
- `can_read` and `can_quote`: readable-artifact capabilities;
- `can_search`: the active retrieval index is ready;
- `can_retry` and `can_refresh_source`: source lifecycle actions.

Required behavior:

- a dead job for the current source attempt projects
  `processing_status = suspended` at read time while persisted source/media
  state remains unchanged;
- `ready_for_reading` with retrieval `pending`, `indexing`, or legacy `failed`
  remains readable and quotable when artifacts permit;
- a dead job for the current revision projects `retrieval_status = suspended`
  at read time while persisted content-index state remains unchanged;
- suspended queue work does not fabricate a domain `failed` transition or
  expose raw queue errors;
- retrieval work never changes a successful source attempt or media processing
  status;
- no `can_retry_index` capability is added; normal repair is automatic and dead
  repair is internal;
- one same-source terminal predicate controls both capability projection and
  source-command enforcement;
- current source-job suspension suppresses `can_retry`/`can_refresh_source`, and
  source-command enforcement queries the same queue-owned suspension fact;
- frontend code presents backend capabilities and does not reconstruct
  lifecycle or retry policy.

## Persistence

### Existing tables

Reuse:

- `media`;
- `media_source_attempts`;
- `content_index_states`;
- `background_jobs`.

Do not add a workflow table, retrieval attempt table, outbox, source fingerprint
column, or retrieval columns to `media`.

### Content revision

Add:

```text
content_index_states.revision BIGINT NOT NULL DEFAULT 0
```

Do not add a `CHECK` constraint. The content-index service validates that the
loaded value is a non-negative application revision and defects on malformed
state, as required by `docs/rules/database.md`.

This cutover uses `revision` only when `owner_kind = 'media'`. Existing and new
`note_block` rows retain the storage default and the note-indexing contract does
not read, increment, compare, or project this field. A future note revision
design requires its own contract; this cutover does not silently generalize it.
Media rows created before the behavioral cutover retain revision zero as their
valid baseline intent, so the historical pending backlog does not require a
fabricated source revision.

`revision` is the identity of the current index intent:

- only a semantic request for a new index increments it;
- source-success increments it in the same transaction that marks the source
  successful and ensures a waiting job;
- the reconciler merely ensures that the already-current revision has a job;
- job preparation and publication never increment it;
- `updated_at` remains observation metadata and is never an identity or fencing
  token.

No schema constraint may pretend `revision` alone fences a worker attempt. Final
publication also validates the exact queue job ID, claimant, attempt number, and
unexpired lease.

### Foreign-key indexes

Migration `0193`, if `0192` remains head, creates exactly these seven indexes:

| Name | Table and columns |
| --- | --- |
| `ix_content_blocks_parent_block_id` | `content_blocks(parent_block_id)` |
| `ix_content_chunk_parts_block_id` | `content_chunk_parts(block_id)` |
| `ix_evidence_spans_start_block_id` | `evidence_spans(start_block_id)` |
| `ix_evidence_spans_end_block_id` | `evidence_spans(end_block_id)` |
| `ix_content_chunks_primary_evidence_span_id` | `content_chunks(primary_evidence_span_id)` |
| `ix_content_embeddings_chunk_id` | `content_embeddings(chunk_id)` |
| `ix_media_claims_evidence_span_id` | `media_claims(evidence_span_id)` |

Do not add `ON DELETE CASCADE`.

Do not add a partial unique job index or any other schema constraint for
coalescing. Waiting/running/dead are application lifecycle states, so
`content_index_states` owner-row locking plus serializable application logic
owns that invariant.

### Exactly resumable migration

The revision column and seven concurrent indexes can partially commit before
Alembic records `0193`. The migration therefore implements an exact state
machine for every object instead of assuming a clean first run.

For `content_index_states.revision`:

- absent -> add `BIGINT NOT NULL DEFAULT 0`;
- present with that exact storage shape -> no-op;
- present with any other type, nullability, or default -> defect.

For each named FK index:

- absent -> create concurrently;
- present with the exact table, ordered key columns, non-unique shape, no
  expression/predicate, and `indisvalid = true` -> no-op;
- present with that exact definition but `indisvalid = false` -> drop
  concurrently and recreate;
- present under the expected name with any other definition -> defect without
  dropping it.

After every create, query the catalog again and require the exact valid
definition. Downgrade uses the inverse exact/absent checks and defects on a
same-named wrong definition. Tests inject failure after each possible committed
prefix and prove the next upgrade converges without duplicate or destructive
DDL.

Use the repository Alembic `autocommit_block` plus
`postgresql_concurrently=True` pattern. PostgreSQL concurrent index creation
cannot run inside a transaction and can leave an `INVALID` index after failure;
see [PostgreSQL `CREATE INDEX`](https://www.postgresql.org/docs/15/sql-createindex.html).

## Durable reindex contract

### Payload

`media_content_reindex_job` has one closed, validated payload:

```json
{
  "media_id": "<uuid>",
  "revision": 7,
  "reason": "source_success | reconciliation | operator_repair | oracle_corpus_seed",
  "request_id": {"kind": "Present", "value": "<string>"}
}
```

`request_id` uses the repository `Presence[str]` shape; semantic absence is
`{"kind": "Absent"}`, never `null`, a missing key, or an empty-string sentinel.
`revision` is a non-negative integer matching the intended
`content_index_states.revision`.

Eligible media kinds are `web_article`, `epub`, and `pdf`; X content uses the
canonical `web_article` representation.

### Registry policy

- `max_attempts = 3`;
- retry delays `(60, 300)` seconds;
- lease `900` seconds;
- `never_prune_dead = True`;
- unexpected provider, protocol, invariant, or infrastructure failures raise;
- there is no dead-letter handler that converts exhaustion into
  `content_index_states.failed`.

The worker increments `attempts` on claim. With three maximum attempts only the
delays after attempts one and two are reachable; a third delay would be dead
configuration.

`justify-retry-schedule`: define this schedule once in the central job registry.
The 60-second retry covers a short provider/network interruption or worker
restart without an immediate repeat burst; the 300-second retry gives the same
required operation one final bounded recovery window. Three total attempts keep
the maximum autonomous retry horizon to minutes rather than hiding a persistent
defect. The 900-second lease exceeds the bounded single-attempt work budget and
the existing worker heartbeat retains it while healthy.

Normal terminal results are `ready`, `no_text`, and `ocr_required`.
Missing/deleted media or an obsolete revision returns queue success with
`superseded`. An existing ineligible kind is an invariant failure.

### Three execution phases

Each database phase opens one session for the whole `retry_serializable`
boundary. The helper reuses that session, rolls it back between attempts, and
the operation reloads every ORM/query value inside each attempt. Close the
session after the boundary. No session or transaction crosses the provider
call.

1. **Prepare transaction**
   - validate the payload and media eligibility;
   - lock media, then the content-index state, then the exact queue job;
   - require exact `(job_id, claimed_by, attempt_no, unexpired lease)` and
     renew that lease for the bounded mutation window;
   - require the payload revision to equal the current revision;
   - snapshot all immutable input required by the block builder;
   - mark the current state `indexing`;
   - commit and close the session.
2. **Plan and embed**
   - build blocks/chunks from the snapshot;
   - use the existing bounded embedding batching;
   - perform provider work with no database transaction open;
   - do not mutate source artifacts.
3. **Publish transaction**
   - lock media, content-index state, and the queue job in that same order;
   - use one queue-owned primitive to require exact
     `(job_id, claimed_by, attempt_no, unexpired lease)` and renew it for the
     bounded mutation window;
   - require the payload revision still to be current;
   - explicitly replace materialized blocks, chunks, spans, embeddings, claims,
     and owned edges while retaining the state row and revision;
   - write exactly one normal terminal state;
   - dispatch the existing `media_unit_build` intent atomically on `ready`;
   - commit before the worker completes the queue row.

If the queue lease or revision is stale, prepare/publication writes nothing and
returns `superseded`. A preflight boolean check such as
`running_job_claim_is_current` is insufficient because the lease can be
reclaimed between the check and a mutation; every authoritative transaction
must hold the queue-row lock through commit.

The queue primitive uses the database's current clock, not transaction-start
time, and extends the lease beyond the bounded transaction/statement budget
before mutation. The row lock prevents claim/reclaim while the transaction is
open. A transaction that exceeds that budget rolls back rather than committing
after its fence window.

Split whole-owner deletion from materialization replacement. Media teardown
still deletes the state row; reindex publication never does. Move web heading
anchor normalization exclusively into source artifact preparation, before
source success. New source preparation already follows that shape; remove the
indexer's residual defensive rewrite. An index job asserts normalized input and
must not rewrite `fragments.html_sanitized`.

Before activating the new indexer, run a one-time bounded data-normalization
command for legacy web fragments:

- select only web fragments containing headings but no Nexus heading anchor,
  in stable batches with row locking;
- apply the existing deterministic `add_heading_anchors`;
- assert `generate_canonical_text(normalized_html)` equals the stored
  `canonical_text` before updating only `html_sanitized`;
- perform no provider, network, filesystem, or object-storage I/O;
- verify the production count is zero, then delete the temporary command in the
  behavioral hard cut.

This is source-data migration, not an indexing responsibility or permanent
compatibility path.

## Content-index intent and coalescing

Expose two semantically distinct content-index service transitions. Do not
merge them into a boolean-heavy helper.

### Request a new revision

```text
request_media_content_reindex(
  db, media_id, reason, request_id
) -> {revision, background_job_id}
```

Used by source success and Oracle corpus seeding. In the caller-owned
transaction it:

1. locks the media row, then selects the media-owned content-index state
   `FOR UPDATE`, inserting it explicitly when absent;
2. increments `revision`;
3. writes `pending` and clears obsolete failure observation;
4. selects the media's nonterminal reindex jobs `FOR UPDATE` in stable ID order;
5. explicitly updates or inserts the waiting job for the new revision;
6. asserts the complete postcondition before commit.

The outer mutation operation runs inside `retry_serializable`. This doorway
participates in that transaction and never starts a nested retry boundary. The
retry closure reloads the media, state, and queue rows after every rollback. The existing
`uq_content_index_states_owner` is a true schema-owned one-to-one key; first-row
creation is protected by the media lock and normal serializable retry, not a new
job uniqueness constraint.

If a waiting row for the current intent exists, the queue-owned coalescing
primitive updates its closed payload to the newest revision/reason, resets its
attempts and error/result fields, returns it to `pending`, clears claim/lease
fields, makes it available now, and returns that same row. This is a genuinely
new intent with a fresh retry budget. Obsolete unclaimed waiting jobs are
explicitly completed as `superseded` through the queue owner. If only an older
running job exists, insert one waiting successor.

Before commit, reload/assert:

- exactly one waiting job carries the new current revision;
- no second waiting job carries that revision;
- every unclaimed waiting job for an older revision is terminal
  `superseded`;
- any older running or dead job remains untouched and cannot publish the new
  revision.

Violation is a defect. Every code path that creates a media reindex job must
hold the same owner lock, so the assertion—not a lifecycle index—is the
invariant backstop.

### Ensure the current revision has a job

```text
ensure_media_content_reindex_job(
  db, media_id, reason, request_id
) -> {revision, background_job_id}
```

Used by reconciliation. It does not increment revision and does not reset a
waiting job's attempts, backoff, error, or availability. Under the same
media/state/job lock order and serializable boundary, it inserts only when the
current `pending` or stale `indexing` revision has neither a waiting nor running
job. A dead job for that same revision is reported as suspended and is not
bypassed. A dead job for an obsolete revision remains audit history and does
not block a genuinely newer source revision. It asserts at most one waiting job
for the current revision before commit.

No source adapter, seed script, reconciler, route, or domain service writes raw
`background_jobs` fields. Queue-owned primitives own the status transition,
claim fields, attempt budget, supersession, and exact row-count assertions.

## Source-success contract

The source dead-letter redesign remains in scope, so source publication receives
the same exact-claim protection as reindex publication.

### Source execution identity and lock order

Thread the required `JobExecutionContext` unchanged through:

```text
registry handler
  -> tasks/ingest_media_source.py
  -> run_source_attempt
  -> every source-specific publication helper
```

The registry may not accept and discard `context`.
`services/source_publication.py` owns one internal `SourcePublicationFence`
carrying `attempt_id`, `job_id`, `worker_id`, and `attempt_no`, plus the common
fenced mutation boundary.

Every authoritative source database transaction locks in this order:

1. affected media rows in sorted ID order when there is more than one;
2. the exact `media_source_attempts` row;
3. the exact `background_jobs` row through the queue owner.

It then requires:

- `media_source_attempts.job_id == context.job_id`;
- the attempt is still the current publishable attempt for that media;
- the queue row is `running`, claimed by `worker_id`, has
  `attempts == attempt_no`, and has an unexpired lease.

The queue owner validates with the database's current clock and renews the lease
beyond the bounded mutation/statement budget. The transaction holds all locks
through commit; the queue row cannot be reclaimed while locked. A boolean
preflight is forbidden. Lost claim, reclaimed attempt, superseded source
attempt, deleted media, or mismatched job identity rolls back the entire
mutation and stops that worker without publishing.

This fence applies to every database-visible authoritative source mutation,
including:

- the initial transition to attempt `running`;
- fragment/file/transcript/artifact replacement;
- media/source deduplication and supersession;
- reader apparatus, document-embed targets, and author-observation
  publication;
- modeled source-failure publication;
- ready/succeeded terminal publication and atomic reindex intent.

Source adapters may acquire or transform immutable input outside a transaction.
Object-store writes use their existing staging/reservation/cleanup ownership;
an unfenced object write is not made authoritative until a fenced database
publication references it. Remove or refactor every adapter-local `db.commit()`
that can publish source state without the common fence.

Each fenced database mutation uses one session for its `retry_serializable`
boundary, reloads all state inside every retry attempt, and closes the session
after the boundary. Provider, network, filesystem, and object-storage I/O never
runs inside that boundary.

### Terminal success

Each source lifecycle converges on one `run_source_attempt` success doorway.
Its final fenced database transaction:

1. confirms that canonical readable artifacts are durable and normalized;
2. applies modeled source observations such as
   `E_PDF_TEXT_UNAVAILABLE`;
3. marks media `ready_for_reading`;
4. marks the source attempt `succeeded`;
5. requests a new content-index revision through the canonical helper;
6. commits.

Metadata enrichment dispatch remains separate. Its failure cannot undo source
success.

Delete every direct retrieval-index call from EPUB, PDF, web, and X source
execution. Delete source-specific `index_content`, `post_success_index`, and
equivalent flags/result fields. Acquisition adapters return immutable source
inputs and typed observations; source materializers persist artifacts only
through the common fenced mutation doorway.

The source-attempt boundary catches and persists only explicitly modeled
adapter/source outcomes. An unknown Node result tag, malformed owned protocol,
database/storage fault, invariant failure, or other unexpected exception raises
to the `ingest_media_source` queue policy. Keep three attempts and its
300-second heartbeat-backed lease, remove the unreachable third retry delay so
the schedule is `(60, 300)`, and set `never_prune_dead=True`. Its exact dead
operation remains visible for repair instead of becoming generic
`E_INGEST_FAILED`. Because every authoritative write is fenced, a stalled
worker that resumes after lease reclamation cannot overwrite the retried
attempt.

## Reconciliation

Enable `reconcile_stale_ingest_media_job` every 600 seconds with a batch limit of
25 per owned category.

The reconciler may inspect and transition domain state, but it must not call an
embedding provider, source provider, or index builder. It:

- retains bounded abandoned-upload teardown dispatch;
- for stale source attempts, inspects the attempt's canonical queue owner:
  - pending, failed, running, or dead jobs are not duplicated;
  - an expired running lease remains queue-owned and is reclaimable;
  - only a missing legacy job is recreated and attached to the same attempt;
  - dead jobs are counted as suspended, never auto-replayed;
- ensures `media_content_reindex_job` for eligible document states that are
  `pending` or stale `indexing`;
- enqueues the existing `podcast_reindex_semantic_job` for transcript semantic
  candidates;
- reports scanned, enqueued, deduplicated, suspended, skipped, and oldest-age
  counts.

Repeated runs are safe because each canonical enqueue path owns deduplication.
The reconciler never changes a document revision merely because time passed.

## Worker topology

Run exactly two single-process, single-replica services over the same queue.

### `worker-interactive`

```text
ingest_media_source
chat_run
dossier_build
podcast_sync_subscription_job
oracle_reading_generate
```

### `worker-background`

```text
media_content_reindex_job
enrich_metadata
media_unit_build
note_reindex_job
podcast_reindex_semantic_job
synapse_scan
dawn_write_job
atlas_project_job
media_teardown
storage_object_cleanup
storage_orphan_sweep
reconcile_stale_ingest_media_job
```

These five interactive kinds plus twelve background kinds are the complete
17-kind production-enabled set.

### Maintenance-only registry kinds

Do not enable these in either deployed service:

```text
podcast_active_subscription_poll_job
sync_gutenberg_catalog_job
prune_background_jobs_job
purge_expired_auth_handoff_codes
```

They remain registered for explicit, bounded maintenance execution. Their
configurable schedules remain zero in the normal production environment; auth
handoff purge is likewise harmlessly unscheduled because no deployed lane may
claim or schedule its kind.

Rules:

- define `PRODUCTION_ENABLED_JOB_KINDS`, both lane lists, and
  `MAINTENANCE_JOB_KINDS` once as typed constants in `config.py`;
- the deployed lane sets are non-empty, disjoint, and their union equals
  `PRODUCTION_ENABLED_JOB_KINDS` exactly;
- production-enabled and maintenance sets are disjoint, are subsets of the
  registry, and together equal the registry after adding reindex;
- a contract test fails on any omission, overlap, or unknown kind;
- normal deployed workers require `WORKER_LANE=interactive|background` and
  derive the allowlist from those constants;
- reject a missing or unknown lane at startup;
- remove the raw `WORKER_ALLOWED_JOB_KINDS` override from normal deployed
  services and remove the old undifferentiated `worker` service;
- preserve an explicit maintenance-only invocation that requires the existing
  `WORKER_LANE=maintenance`, the
  `NEXUS_ALLOW_WORKER_MAINTENANCE=1` gate, and an exact
  `WORKER_ALLOWED_JOB_KINDS` subset of `MAINTENANCE_JOB_KINDS`; do not deploy a
  continuously running maintenance service;
- only the background worker registers production periodic schedules, including
  reconciliation; a gated maintenance invocation registers only its exact
  allowed maintenance kinds;
- set `DATABASE_STATEMENT_TIMEOUT_MS=300000` for both workers; zero is forbidden
  by configuration validation in deployed environments;
- add a process-liveness healthcheck to each worker and log lane plus the sorted
  effective allowlist at startup;
- keep one replica per lane in this cutover.

Apply the topology in Hetzner compose and deployment verification, the root
`Makefile`, `docker/docker-compose.worker.yml`, `apps/worker/README.md`, and
architecture/job documentation. Update every normal `compose run worker` deploy
command to an intentional production lane or shared-image invocation, while
retaining the explicit maintenance gate.

FIFO head-of-line blocking within a lane is accepted for the one-user target.

## Strict source and parser contracts

### Direct file URLs

`remote_file_kind_from_url` recognizes the current explicit PDF/EPUB suffixes
plus Gutenberg `.epub3`, `.epub3.images`, and `.epub3.noimages`, after normal
URL-path normalization and without treating query text as a suffix.
Remote-file acquisition still validates response bytes before accepting them.

Do not implement generic extension inference. An ambiguous URL remains a web
source. A URL advertised as a supported file but returning invalid bytes fails
`E_INVALID_FILE_TYPE`.

### Node article result union

The Node/Python boundary returns one closed, versioned success-or-failure union.
Failure variants are:

```text
http(status)
timeout
network
too_large
readability
```

Python decodes the union exhaustively:

| Variant | API error | HTTP status | Same-source action |
| --- | --- | --- | --- |
| `http(401|403)` | new `E_SOURCE_ACCESS_DENIED` | 422 | terminal |
| `http(other)` | `E_SOURCE_FETCH_FAILED` | 502 | retryable as policy permits |
| `timeout` | `E_INGEST_TIMEOUT` | 504 | retryable as policy permits |
| `network` | `E_SOURCE_FETCH_FAILED` | 502 | retryable as policy permits |
| `too_large` | `E_SOURCE_TOO_LARGE` | 413 | terminal |
| `readability` | new `E_SOURCE_NOT_READABLE` | 422 | terminal |

Malformed JSON, an unknown tag/version, an impossible status, or a
success/failure shape violation is an owned-protocol defect and raises. It is
never collapsed into a generic source failure. There is no server-side browser
fallback.

Extend the sole same-source terminal predicate in `capabilities.py` to cover
access denied, invalid file, too large, and not readable. Both capability
projection and command enforcement call it. Suppress `can_retry` and
`can_refresh_source` when the exact same source cannot change the result; a new
upload or different URL remains a separate source command. Delete the duplicate
terminal-error set from `media_source_ingest.py`.

### Shared HTML document parser

Add one `parse_html_document(str | bytes)` helper to `html_tree.py`:

- preserve byte input so the parser may honor its declared encoding;
- for already-decoded `str`, remove only a leading XML declaration that
  contains an encoding declaration;
- return the canonical lxml document shape or raise the existing modeled parse
  result;
- do not use per-call regex patches.

Route all production `lxml.html.document_fromstring` calls through it, including
sanitization, reader apparatus, document embed extraction, and EPUB paths.
Focused tests cover whitespace/BOM handling, bytes, an encoding declaration,
an XML declaration without encoding, ordinary HTML, malformed input, and all
production callers.

## Product and UX

Add one pure presenter in a frontend file whose error helper follows the
required `*ErrorMessage` naming convention. It maps `last_error_code` plus
backend capabilities to title, explanation, and available action. The media
detail pane consumes it. Add-flow and collection rows may retain terse status
text because their current contracts do not carry detailed errors.

Required behavior:

| State | Presentation |
| --- | --- |
| retrieval pending/indexing | “Search and AI are still preparing.” Reader remains open. |
| legacy retrieval failed | “This document is readable, but search and AI are unavailable.” |
| suspended retrieval job | “Search and AI stopped and need repair.” Reader remains open; no public repair action. |
| suspended source job | “Import stopped; repair required.” No source actions; reader remains capability-derived. |
| source access denied | Explain the block; direct the user to open the original page and use Nexus Capture. |
| invalid/oversized remote file | Ask for a valid direct download link or upload; do not offer same-source Retry. |
| unreadable web page | Ask for a different source or browser capture from the original page. |
| retryable source failure | Show Retry only when `can_retry` is true. |

Do not render a “Capture” button on a Nexus media detail page: the browser
extension captures the page currently open in the browser, not the original
third-party page from inside Nexus. Show an existing safe “Open source” action
only when the backend already exposes that capability/URL.

Raw error codes and retrieval reasons may appear in diagnostics, never as
primary user copy.

## Internal API, repair, and health

Public media routes and response field structure do not change. The existing
string-valued projections add:

- `processing_status = suspended` for the current source attempt's dead job;
- `retrieval_status = suspended` for the current content revision's dead job.

Persisted media/source/content-index lifecycle rows remain unchanged. These are
operation-state read projections, not fabricated business terminal states.

Keep:

- `POST /internal/ingest/reconcile` as an enqueue-only operator trigger;
- `GET /internal/ingest/reconcile/health` as the aggregate health surface.

Add narrow exact-replay operations:

- `POST /internal/ingest/content-index/{media_id}/retry-dead`;
- `POST /internal/ingest/source/{media_id}/retry-dead`.

Each route uses existing internal protection, finds the exact current dead job,
validates its domain identity, invokes queue-owned `requeue_dead_job`, and
returns the same job ID. It never creates a replacement attempt or revision.
If no matching dead job exists, it returns the existing not-found/conflict
contract rather than guessing.

Keep one separate internal legacy repair transition:

- `POST /internal/ingest/content-index/{media_id}/repair`.

It is valid only for a legacy `failed` index state with no current live/dead
reindex job. It requests a genuinely new revision with `operator_repair`; it
never masquerades as replay of a dead operation. There is no public control and
the periodic reconciler does not invoke this transition.

Extend health with:

- stale source-attempt count and oldest age;
- fresh pending and stale pending/indexing document-index counts;
- dead/suspended source and document-index job counts;
- oldest currently due interactive-job age;
- oldest currently due background-job age;
- latest reconciler outcome and age;
- one derived `degraded` boolean.

Queue metrics come from queue-owned read helpers. “Due” means
`available_at <= now()`, not a future periodic job. Use `Presence` for
semantically absent ages and last-run data.

The media read model uses queue-owned batch projections:

- when the current source attempt's exact job is dead, return
  `processing_status = suspended`, stable presentation metadata, and suppress
  public Retry/Refresh so a second source operation cannot bypass the suspended
  prefix;
- when the current content revision has a dead
  `media_content_reindex_job`, return `retrieval_status = suspended` and stable
  presentation metadata.

Neither projection exposes raw queue errors or mutates lifecycle rows. Obsolete
dead attempts/revisions do not affect current media.

`degraded` is true when any source/index state is stale, either owned job kind
has a dead row for a current domain intent, or the latest reconciler result is
absent, unsuccessful, or older than two configured intervals. It is therefore
conservatively degraded until the first successful post-deploy reconciliation.
Queue ages remain diagnostic measurements rather than arbitrary red/green
thresholds.

## Hard-cut deletion

Delete after all callers move:

- `python/nexus/tasks/ingest_pdf.py`;
- `python/nexus/tasks/ingest_epub.py`;
- `python/nexus/services/pdf_indexing.py`;
- `python/nexus/services/web_article_indexing.py`;
- synchronous `repair_ready_media_content_index_now`;
- source-specific direct-index imports, calls, flags, and result fields;
- tests whose only contract is a deleted task or flag;
- the old one-worker compose service and its normal-production raw allowlist;
- the disabled reconciler production value and stale documentation.

Do not delete the maintenance safety boundary, its four-kind declaration, or
the explicit maintenance authorization gate.

Update seed/test callers to use canonical source services or content-index
transitions. Do not retain import wrappers.

## Implementation map

### Add

- `migrations/alembic/versions/0193_media_pipeline_reliability_hard_cutover.py`
  if `0192` remains head;
- `python/nexus/tasks/media_content_reindex.py`;
- `python/nexus/services/source_publication.py`;
- `apps/web/src/lib/media/mediaErrorMessage.ts` and its focused test.

### Temporary in Phase A only

- `scripts/backfill_web_heading_anchors.py`.

Delete this command in Phase B after its zero-remaining verification passes.

### Modify

- `python/nexus/db/models.py`;
- `python/nexus/errors.py`;
- `python/nexus/config.py`;
- `python/nexus/jobs/queue.py`;
- `python/nexus/jobs/registry.py`;
- `python/nexus/jobs/worker.py`;
- `python/nexus/tasks/ingest_media_source.py`;
- `python/nexus/services/capabilities.py`;
- `python/nexus/services/contributors.py`;
- `python/nexus/services/content_indexing.py`;
- `python/nexus/services/media.py`;
- `python/nexus/services/media_source_ingest.py`;
- `python/nexus/services/epub_ingest.py`;
- `python/nexus/services/epub_lifecycle.py`;
- `python/nexus/services/pdf_ingest.py`;
- `python/nexus/services/pdf_lifecycle.py`;
- `python/nexus/services/web_article_ingest.py`;
- `python/nexus/services/x_ingest.py`;
- `python/nexus/services/youtube_video_ingest.py`;
- `python/nexus/services/podcasts/transcription.py`;
- `python/nexus/services/remote_file_ingest.py`;
- `python/nexus/services/node_ingest.py`;
- `node/ingest/ingest.mjs`;
- `python/nexus/services/html_tree.py`;
- `python/nexus/services/sanitize_html.py`;
- `python/nexus/services/reader_apparatus.py`;
- `python/nexus/services/document_embed_extraction.py`;
- `python/nexus/services/oracle_corpus.py`;
- `scripts/oracle/seed_corpus_library.py`;
- `python/nexus/tasks/reconcile_stale_ingest_media.py`;
- `python/nexus/services/ingest_recovery.py`;
- `python/nexus/schemas/ingest.py`;
- `python/nexus/schemas/media.py`;
- `python/nexus/api/routes/internal_ingest.py`;
- `deploy/hetzner/docker-compose.yml`;
- `deploy/hetzner/docker-compose.yml` topology only; release and config
  publication remain owned by [deployment.md](../../deployment.md);
- `deploy/env/env-prod-worker.example`;
- `deploy/env/README.md`;
- `Makefile`;
- `docker/docker-compose.worker.yml`;
- `apps/worker/README.md`;
- `docs/architecture.md`;
- `docs/modules/jobs.md`;
- `apps/web/src/app/(authenticated)/media/[id]/MediaPaneBody.tsx`;
- `apps/web/src/lib/media/useMediaProcessingStatus.ts`;
- `apps/web/src/lib/media/sourceActionProjection.ts`;
- focused backend, worker, migration, deployment-contract, and frontend tests.

The Oracle seed drainer must allow and drain both `ingest_media_source` and
`media_content_reindex_job`; otherwise source success enqueues work the seed
process never executes and its readiness assertion becomes false.

### Delete

Delete the legacy files and paths listed above only after repository search
proves no production, seed, script, or test imports remain.

## Implementation and release sequence

### Phase A: additive schema

1. Add or exactly validate `content_index_states.revision`; add no `CHECK`.
2. Create or exactly validate the seven FK indexes concurrently.
3. Verify all seven names, definitions, and `indisvalid = true`.
4. Analyze the affected tables and verify representative production predicates
   are index-eligible, interpreting planner-selected scans in light of relation
   size.
5. Deploy and run the bounded legacy web-heading normalization command; verify
   zero unanchored heading fragments.

The additive schema remains compatible with the old code. Deploy it before the
behavioral cutover. Do not routinely downgrade successful additive indexes
during an application rollback.

### Phase B: behavior hard cut

1. Thread job context through source ingestion and fence every authoritative
   source publication before changing unexpected failures to queue-owned
   retry/dead-letter behavior.
2. Add owner-row-serialized queue coalescing, exact claim fencing, the reindex
   task/registry entry, and exact dead-replay paths.
3. Add media-only content revision transitions and prepare/plan/publish
   indexing.
4. Move EPUB, PDF, web, X, Oracle, and seed callers; remove every inline path.
5. Convert reconciliation to dispatch-only and promote only that formerly
   maintenance-controlled kind into the normal production set.
6. Split and validate the 17-kind production topology, preserve the four-kind
   maintenance gate, and add deployment healthchecks and bounded statement
   timeouts.
7. Add the strict URL, Node result, parser, capability, and UX contracts.
8. Delete the temporary normalization command, legacy modules/flags, and update
   all owner docs/tests.

Do not deploy an intermediate code state where a source caller can enqueue an
unregistered job, unexpected source defects can retry without complete
publication fencing, a worker lane omits a production-enabled kind, a deployed
lane enables a maintenance-only kind, both lanes schedule the same periodic
work, or the Oracle seed cannot drain the jobs it creates.

### Phase C: repair and verify

1. Release Phase B only through [deployment.md](../../deployment.md).
2. Verify API `/version` and both worker health contracts report the bound
   source SHA and task-contract digest; verify each worker's lane and exact
   share of the 17-kind production-enabled set, with all four maintenance kinds
   absent.
3. Trigger reconciliation once.
4. Observe the historical pending backlog drain in bounded batches.
5. Re-run the known EPUB and XML-declaration cases through normal source APIs.
6. Re-add the Gutenberg URL through corrected classification.
7. Leave access-denied, invalid-file, and provider-credit cases untouched until
   their source conditions change.
8. Verify public `/livez`, `/readyz`, and `/version`, internal ingest health,
   queue ages, domain states, and teardown latency.

Once Phase B has accepted new job payloads/revisions, application recovery is
roll-forward. Do not restore inline indexing or the undifferentiated worker.
Schema downgrade is reserved for a demonstrated schema defect and only while no
new-code operation depends on it.

## Acceptance criteria

### Database and teardown

- the revision column has the exact storage shape and no new `CHECK`;
- media content-index operations validate non-negative revision values and
  defect on malformed state; note-index operations ignore the field;
- all seven indexes exist, match the exact definitions, and are valid;
- no index or uniqueness constraint encodes reindex lifecycle/coalescing;
- injected failure after every migration step proves upgrade is exactly
  resumable from absent, exact-valid, and exact-invalid catalog states, while a
  wrong same-named definition defects without destructive repair;
- the seven referencing-side predicates match their indexes, tables are
  analyzed, and representative plans demonstrate index eligibility at
  production-like cardinality; a planner-preferred sequential scan on a
  genuinely small relation is not itself a failure;
- teardown of a high-cardinality fixture completes under the worker statement
  timeout;
- deletion remains explicit and leaves no owned rows or storage intents;
- no request, provider call, or filesystem/object-store access occurs in a
  teardown, source-publication, or index-publication transaction.

### Lifecycle and fencing

- registry/task/source services carry the exact `JobExecutionContext` through
  every source publication boundary;
- a reclaimed source worker is forced stale before every tested artifact,
  supersession, modeled-failure, author-observation, and terminal publication;
  each transaction rolls back with no authoritative write;
- object-store writes made before a lost claim remain unreferenced and converge
  through the existing reservation/cleanup owner;
- forced embedding failure after EPUB/PDF/web/X extraction leaves readable
  artifacts durable, media `ready_for_reading`, and the source attempt
  `succeeded`;
- the current content revision remains pending/indexing behind retry or a
  discoverable dead job without changing source truth;
- `ready`, `no_text`, and `ocr_required` are modeled terminal domain outcomes;
- a source refresh during a running index permits exactly one waiting successor;
- a stale revision and a reclaimed reindex worker attempt both fail prepare or
  publication without materialization or state writes;
- successful publication replaces the whole materialization and retains the
  state row/revision;
- indexing does not mutate source artifacts;
- production has zero web fragments with headings but without source-owned
  Nexus heading anchors before the new indexer is enabled;
- every source-success path requests exactly one current revision;
- no source adapter imports or calls retrieval indexing;
- no service, seed, or reconciler performs synchronous media reindex repair.

### Queue and reconciliation

- a new revision coalesces a waiting job, refreshes its payload, and grants a
  fresh retry budget;
- every enqueue locks media, then its media-owned content-index state, then
  relevant job rows inside `retry_serializable`;
- concurrent enqueue tests establish exactly one waiting job for the current
  revision without a lifecycle uniqueness index, and the postcondition
  assertion defects on injected duplicates;
- ensure-current reconciliation does not reset attempts or backoff;
- a running job permits one waiting successor;
- a dead job remains unchanged until exact operator replay;
- `max_attempts = 3` has exactly two reachable retry delays;
- the reconciler calls no provider or index builder;
- stale source recovery never duplicates a live or dead owned job;
- transcript repair dispatches the existing podcast semantic job;
- interactive and background lane allowlists are disjoint and exhaustive for
  the declared 17-kind production-enabled set;
- the four maintenance kinds are absent from both deployed lanes and remain
  available only through the explicit maintenance authorization gate;
- production-enabled plus maintenance kinds equal the full registry;
- only the background lane schedules production periodic jobs;
- neither deployed worker has an unbounded database statement timeout;
- local, seed, and deploy worker entry points use the same lane contract.

### Source failures, parsing, and UX

- Gutenberg `.epub3`, `.epub3.images`, and `.epub3.noimages` paths enter remote
  EPUB ingest and still reject invalid bytes;
- every Node result variant maps exhaustively, while malformed owned protocol
  raises;
- HTTP 403 persists `E_SOURCE_ACCESS_DENIED` and suppresses same-source actions;
- too-large and unreadable results retain their specific terminal codes;
- Unicode XML declarations parse through the one shared boundary for every
  production caller;
- a current dead source job projects `processing_status = suspended`, suppresses
  public Retry/Refresh, and shows honest repair-needed copy without changing
  persisted source/media state;
- readable media stays open while retrieval is pending, indexing, suspended, or
  legacy failed;
- capability-derived actions and typed guidance replace raw generic errors;
- source action enforcement and capability projection call the same terminal
  predicate;
- the UI does not offer an impossible in-detail-page browser capture action.

### Hard-cut gates

Repository search finds:

- no imports of deleted tasks/indexing modules;
- no `index_content` or `post_success_index` ingest contract;
- no inline document indexing in source adapters, Oracle reuse, seed, or
  reconciliation;
- no temporary `backfill_web_heading_anchors.py` command;
- no old one-worker deployment service or command;
- no raw `WORKER_ALLOWED_JOB_KINDS` in either normal deployed service;
- no maintenance-only kind in either production lane;
- no production reconciler interval of zero;
- no positive normal-production schedule for the four maintenance-only kinds;
- no deployed worker statement timeout of zero;
- no revision `CHECK` or media-reindex partial unique/lifecycle index;
- no registry handler that discards source `JobExecutionContext`;
- no authoritative source-worker `db.commit()` outside a common exact-fenced
  mutation boundary;
- no duplicate terminal source-error policy outside `capabilities.py`;
- no direct production `lxml.html.document_fromstring` outside
  `html_tree.py`.

Focused owner tests, migration upgrade and downgrade rehearsal, production-plan
probes, `git diff --check`, and deployment health must pass. Broad unrelated
suites are not required for this cutover.
