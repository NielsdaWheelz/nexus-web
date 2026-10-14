# metadata research and imports

status: implemented; isolated qualification passed. see [the verification receipt](metadata-imports-verification.md) for final cleanup and gate status.
origin: 2026-10-13; audited checkout `03db506d52e11b11a08e24b439fb7a3fa851e29e`.

## 1. purpose and scope

good software keeps its promises, names its failures, and offers the action that
repairs the failed obligation. readability, searchability and researched metadata
are independent facts. one ambiguous “import succeeded” flag cannot represent them.

at audit, metadata already ran as retained `enrich_metadata` jobs, but imports
omitted them. the two investigated failures were successful model calls rejected
because index progress changed the frozen input. other defects concerned automatic
admission, stale publication, terminal settlement, local tool bindings, video
admission, file-publication replay and canonical teardown. implementation and
isolated proof are recorded in [the verification receipt](metadata-imports-verification.md);
separate open work remains in [the issue register](outstanding-issues.md).

deliver these fixes, personal review of no-findings results, composed recovery,
and the narrow search-readiness correction needed by that composition. keep the
existing imports workspace, metadata overlay, queue, generation service and
source/index owners. the reader's consumption “activity” view is unrelated.

approved decisions:

- no findings remains attention until this viewer marks that exact result reviewed.
- fix future behavior; leave existing jobs and saved bibliography untouched.
- all verification uses an isolated stack; no production verification or retries.
- retain the release controller's forward-repair policy; no rollback workstream.
- temporary end-to-end/live checks follow red → green → refactor → deletion.

non-goals: a generic activity/workflow platform, a new queue, model changes,
fallbacks, automatic stale-result retry, generation checkpoints, per-field manual
pins, confidence/provenance storage, historical backfill, production data repair,
local chat parity, and deployment-controller redesign. no compatibility decoder,
dual writer or feature flag. no unresolved product decisions.

## 2. invariants and ownership

| owner | invariant |
|---|---|
| source ingestion | successful terminal publication includes every automatic metadata job it promises; no best-effort enqueue afterward |
| metadata input | index lifecycle changes neither prompt bytes nor evidence identity; actual source replacement does |
| metadata publication | exact claim, current access, eligible media and unchanged evidence are necessary to publish |
| queue | changed facts, successful stamp, terminal outcome, capacity release and transition reactions commit together |
| imports | one stable row exposes every applicable obligation; metadata failure never rewrites source status |
| review | acknowledgement belongs to viewer + exact no-findings job; history and later failures cannot be dismissed |
| capabilities | offers and commands use the same owner policy and inspected identities; replay precedes fresh-admission barriers |

one job is one research operation, with the existing two-attempt budget. completed
findings, including partial or unchanged findings, are success. no findings and
terminal research failures retain their existing durable outcomes. pre-dispatch
unavailability may use the existing immediate retry; no new paid-research policy.

## 3. evidence and publication

introduce one internal immutable value:

```text
MetadataResearchInput { user_content: str, fingerprint: str }
```

build it once in a short read-only repeatable-read snapshot using the existing
session helper. end the snapshot before generation. the model receives current
identifying metadata, ordered credits/handles and opening text. source text is
evidence, never instructions; public queries use identifying strings, not passages.

hash canonical, untruncated bibliographic/source facts, the complete credit roster,
the source version below and the final opening sample. exclude index revision,
status and timestamps, process timestamps, requester identity and author-pin state.
authorize separately; enforce the fresh author pin at publication. administrative
fences are internal, not model prompt material. compare fingerprints, never entire
`GenerationIntent` values.

| source | authoritative version |
|---|---|
| pdf, epub, web/captured article, including x/email | existing `reader_publications.generation` |
| video or podcast transcript | new transcript `content_revision` |
| podcast bibliography | additionally existing `rss_metadata_fingerprint` |

preserve absent document generation distinctly; only transcript absence has the
explicit zero baseline. include the source kind in the fingerprint.

sample order: plain text → canonical fragments → podcast notes → description.
delete the ready-index-chunk branch. preserve 64,000-character raw-read bounds,
configured 1,000-word allocation, 32,768-byte total input, strict fixed-context
overflow rejection and existing hint/excerpt trimming. do not truncate the facts
hashed for concurrency checks.

add `media_transcript_states.content_revision BIGINT NOT NULL DEFAULT 0`.
zero is an opaque baseline, not “no transcript”; absent lifecycle row reads as zero.
`transcripts/state.py` alone owns `read_transcript_content_revision` and
`advance_transcript_content_revision`. `publish_source_transcript` advances once,
in the transaction replacing fragments/segments, after its existing state upsert.
all transcript publication paths use that owner. progress and reindex never advance
it. retain the existing raw-sql table owner; no new orm model or database `CHECK`.

publish in a fresh session using `retry_serializable`. every retry reloads media,
source identity, credits and authority; reuse the accepted generation, not mapped
research-session objects. leave global `expire_on_commit=False` unchanged. lock
media → exact job claim → existing reader/contributor owners, preserving their
lock order. validate before writes; any rejection leaves facts and successful
stamp unchanged. no network calls inside publication.

the document generation conservatively invalidates some title/navigation changes.
accept that small rerun cost rather than adding another document version clock.

## 4. durable composition

replace `complete_job` with the queue-owned primitive:

```python
finish_job(db: Session, *, context: JobExecutionContext,
           result: Mapping[str, Any] | TerminalJobFailure | None) -> JobRow | None
```

it fences the exact execution, stores the terminal result, releases capacity and
runs registered transition reactions in the caller's transaction; it never commits.
mapping/none means succeeded; `TerminalJobFailure` means dead without another retry.
retain existing retry/reschedule primitives for nonterminal outcomes.

move `worker._hooks` into the queue's private transition owner. preserve reactions
on reclaimed executions, reschedules, failed attempts, terminal failures and
expiry death, using the displaced execution identity where applicable. success
currently has no history callback; preserve that. retain lazy registry resolution
and the import-light supervisor. `on_failure` normalization remains worker-owned.
invoke reactions at real transition sites, not unconditionally in `_settle`, which
also serves payload updates. delegating terminal failure must not run hooks twice.

metadata calls `finish_job` before its publication commit, including modeled
early failures in short transactions. if a claim is lost, roll back all writes.
if a previously locked claim unexpectedly cannot finish, treat it as a defect;
never commit metadata alone. callback failure rolls back the whole publication.
no domain effects follow a committed terminal publication.

worker settlement first checks the stored execution. an already-terminal row for
that exact execution wins before handling `Lost`, normalizing failure or settling
again. do not repeat callbacks. heartbeat stops renewal and signals the bounded
executor to stop when the claim is no longer running; suppress the false reclaimed
warning for that exact terminal execution. reaper-driven death must still stop a
running child. the committed outcome wins if the stopped executor returns `Lost`.

inside `_publish_terminal_attempt`'s successful branch, enqueue requested metadata
for the attempt's requester through `enqueue_metadata_enrichment`, alongside
source terminal state and index admission. pass `request_id` explicitly. preserve
the existing automatic-research policy, including email exclusion and requester
requirement. source fencing prevents a settled attempt from admitting a second job.
remove the post-success transaction and `try_enqueue_metadata_enrichment`.
no new outbox is needed: both effects share postgres.

source composition must also close its prerequisite gaps:

- local/remote file adapters prepare without publishing. define frozen
  `PreparedFileSource { plan: ExtractionPlan, remote_file: Presence<RemoteFile> }`
  in `media_source_adapters.py`, using both existing types. the plan carries its
  storage path; `RemoteFile` carries fetched url/type/size/digest.
  `run_source_adapter` returns this or `SourceRunOutcome`.
  the coordinator publishes file artifacts, observations and terminal source/index/
  metadata obligations in ONE existing fenced transaction. discover embed-owner
  locks first. return directly from this branch; never finalize twice. storage
  i/o stays outside the transaction. expose adapter-owned
  `publish_prepared_file_source(db, *, media_id, prepared) -> (outcome, cleanup_paths)`
  and `finalize_prepared_file_source(session_factory, *, media_id, prepared, cleanup_paths)`.
  the former derives remote source pointer/url and calls existing lifecycle
  writers; the latter does existing postcommit storage work. no reverse import.
  keep preparation/publication inside the existing domain-exception classifier:
  domain refusals settle source failure; database/enqueue errors escape for retry.
  failure before commit leaves no epub publication to obstruct retry; failure
  after commit cannot lose the promised job. do not weaken epub immutability.
- for other outcomes, combine canonical supersession, contributor observations and
  terminal publication into one final fenced phase using the existing complete
  media/embed-owner lock set. teardown admission commits with winner effects,
  preventing deletion of the original attempt before finalization.

this changes file-adapter orchestration, but adds no durable checkpoint. non-file
recovery may repeat external acquisition/transcription; a source that disappears
during recovery can still fail visibly. preserving acquired external results
across all crashes would require a separate durable acquisition design.
if postcommit finalization is interrupted, existing reservation cleanup jobs retain
objects referenced by `media_file`/`epub_resources`; source replay does not rerun
finalization after its terminal fence. superseded-object deletion remains the
existing best-effort behavior; its separate [cleanup gap](tickets/superseded-storage-deletion-is-best-effort.md)
is outside metadata correctness and is not silently claimed fixed here.

successful playable-video ingestion always requests metadata, whether a provider
snippet exists or not. missing key, unavailable provider and unusable snippet do
not suppress research. a genuinely missing video remains `E_SOURCE_GONE`.

tradeoff: death before publication can repeat paid generation within the existing
budget. the generation ledger retains audit evidence, not accepted output. this
plan closes the postpublication gap without claiming exactly-once model execution.

## 5. read and capability contracts

keep the four `/imports` reads and the metadata detail/stream interfaces. extend
their declared models; regenerate web wire types. always serialize tagged presences.
add `Metadata` after `Index` in stage ordering. imports/history failure codes become
`SafeFailureCode | MetadataFailureCode`; metadata retains ownership of its vocabulary.

```text
ImportItem.obligations = {
  source: Presence<SourceImportObligation>,
  search: Presence<SearchImportObligation>,
  metadata: Presence<MetadataEnrichmentView>
}
SourceImportObligation = {
  state: source Active | source NeedsAttention | Complete,
  recovery: Presence<RetryUploadOffer | RetrySourceOffer | RepairSourceOffer>,
  unavailable_reason: Presence<ModeledRecoveryRestriction>
}
SearchImportObligation = {
  state: index Active | index NeedsAttention | Complete,
  recovery: Presence<RepairSearchOffer>,
  unavailable_reason: Presence<"NotOwner">
}
ImportItem.capabilities = { can_open: boolean, can_remove: boolean }
MetadataEnrichmentView += { unfinished_count: integer >= 0 }
MetadataEnrichmentView += {
  unfinished_operation: Presence<queued | running | recovering | waiting operation>
}
MetadataNoFindingsOperation += { reviewed_at: Presence<datetime> }
ImportSummary += { unfinished_work_count: integer >= 0 }
```

retain existing active-state fields and recovery identities. an obligation offers
recovery or a restriction, never both. source stages exclude `Index`/`Metadata`;
search uses `Index`. absent means no applicable recorded obligation, not success.
unpublished uploads occupy source; linked uploads keep their upload identity.
metadata is present for linked media even when its `operation` is absent.
keep `MetadataNoFindingsOutcome` immutable; only its viewer projection gains review.

imports population = current upload/source imports plus visible media with retained
metadata jobs. deduplicate using the existing upload-first identity rule. rss-only
episodes therefore appear. absence of a historical job proves no failure and
causes no backfill.
preserve upload/source `accepted_at`; metadata-only rows use earliest retained job
creation time. latest `operation` and oldest `unfinished_operation` are selected by
`(created_at, id)` in the same metadata projection. zero unfinished count iff the
unfinished operation is absent. this small overlap provides a truthful active
identity even when the latest operation already completed.

derive source and current-index obligations independently through their owners.
current search applicability requires an existing index and ready media, not a
succeeded source attempt. retained prior-index history/readiness remains visible
while replacement source processing makes current search inapplicable.

classification, in precedence order:

1. `NeedsAttention`: any applicable source/search failure, latest metadata failure,
   or latest unreviewed no-findings result.
2. `Active`: otherwise, unfinished applicable source/search obligations or any
   unfinished metadata job.
3. `Complete`: otherwise.

needs attention and in progress contain exclusive current rows; history remains
the historical view of all states. their summary counts count rows.
`unfinished_work_count` counts distinct pending/running/failed source, index and
metadata jobs linked to these imports, across all attempts/revisions. add active
unpublished uploads and applicable active source/search obligations not already
represented by a counted live job. deduplicate by import/job identity. inapplicable
old jobs keep polling without inventing an actionable current obligation. only this
count drives existing polling. latest metadata is ordered by `(created_at, id)`;
newer requests supersede older attention, but older unfinished jobs still block
fresh research and keep observation alive.

classify before filtering. attention filters consider only attention obligations;
progress filters consider only active obligations. correlate every stage/failure
filter against the SAME candidate. select the primary matching obligation by
`(stage_rank, attention_since or accepted_at, obligation_key)`; keys are source,
search, metadata. `ImportItem.state` carries aggregate kind and that primary
obligation's details. group each row once. retain attention's stage/oldest-problem
ordering and progress's accepted-time ordering, with stable import-ref tiebreaks.
history selects its newest matching entry and reports unfiltered current state.
keep the existing summary read's `observed_at` observation token. include job
`updated_at` and this viewer's review in item `updated_at`. heartbeats may refresh
projections during live work, but never create history entries; no new clock.

metadata's active candidate comes from `unfinished_operation`: running maps to
`Processing`; queued/recovering to `Queued` + `Queue`; waiting to `Queued` +
`RetryBackoff` and its `until`. progress is absent. when latest is terminal, show
that outcome and the separate unfinished operation rather than fabricate activity.

define `MetadataOperationFacts { kind: "MetadataOperation", operation: MetadataOperationOut }`.
widen only `HistoryEntry.facts` to `HistoryFacts | MetadataOperationFacts`; persisted
`HistoryFacts`, `history_event_type`, `history_payload` and stored-event decoding
remain closed. metadata history is projected:
one projected entry per retained job, using the latest generation PER JOB, batched
through `metadata_operations` and the generation-ledger owner. reuse owner-exported
setwise facts and decoding in list/summary/history; no per-row queries or duplicate
metadata state machine. the metadata owner supplies effective status, active/
attention facts, safe reason and operation timestamps from one setwise projection;
imports consumes those facts, not its own status `CASE`. terminal entry time is
completion; unfinished time is job creation. review decorates its original entry,
never creates a fake operation.
no-findings has absent failure code and does not match `had_failures=true`.

change history entry ids to validated text: `upload:<uuid>`, `processing:<uuid>`,
`metadata:<job_uuid>`. storage event ids remain unchanged. page by
`(occurred_at DESC, id DESC)` using text ids. version cursor bindings and reject old
cursors; change api/web together. one entry per job deliberately does not reconstruct
overwritten per-execution failures; label the filter “recorded failures”.

### personal review

```text
POST /media/{media_id}/metadata-enrichment/{job_id}/review
body: { client_mutation_id: ClientMutationUuidText }
200: Data<{ job_id: UUID, reviewed_at: datetime }>
```

any current reader may review. reauthorize before replay; lock media, reauthorize,
repeat replay lookup under that lock, then verify exact job kind/media association
and `no_findings`. insert-or-return
review and record the existing mutation replay receipt atomically. use database
time; repeated requests return the original timestamp. older results may be
reviewed, without clearing newer attention. 404 hides inaccessible/unknown media
or job; 409 `E_RESOURCE_CONFLICT` rejects a known non-no-findings result. retain
existing mutation-id validation and replay-conflict semantics.
replay scope is `media_metadata_result_review:{media_id}`; canonical request bytes
contain `{job_id: str(job_id)}`. reusing a mutation id for another job conflicts.

new table `metadata_result_reviews`: `id UUID PRIMARY KEY`, `viewer_id UUID NOT NULL
REFERENCES users(id)`, `job_id UUID NOT NULL REFERENCES background_jobs(id)`,
`reviewed_at TIMESTAMPTZ NOT NULL`, unique `(viewer_id, job_id)`. generate identity
at insertion; stamp database time. use ordinary non-cascading fks, no business
constraints. metadata owns writes and batched reads. reuse mutation replay; do not
add another idempotency table, generic dismissal or unreview feature.

notify the existing `media_events` channel transactionally using the job's media id;
refetch viewer-specific metadata/action/import snapshots without a bibliography
change event. use the existing mutation-intent client on lost responses.
admission and review success/replay call existing `publishImportsInvalidation()`;
imports itself has no metadata-stream listener and an idle summary must wake.
`media_deletion._delete_viewer_media_state` calls metadata-owned cleanup for personal
removal; physical teardown removes all relevant reviews before dependencies.
metadata jobs remain retained. no new user-deletion feature; operator user/job
deletion must first remove dependent reviews.

### independent actions

keep creator-only, exact-latest-job `RetryMetadata`. add
`ReviewMetadataResult { availability, job_id }` for the inspected unreviewed
no-findings operation; its action submits that exact id, never “latest”.
`CollectionMedia.reviewable_metadata_job_id: Presence<UUID>` comes from the viewer's
latest projection and supplies this snapshot capability. older history entries
use an inline review action with their own job id and the same mutation client.

replace singleton `Recovery` capability with `SourceRecovery { availability,
offer: RetrySourceOffer | RepairSourceOffer }` and `SearchRecovery { availability,
offer: RepairSearchOffer }`. preserve all commands, ids, expectations and busy
handling. `CollectionMedia` replaces `recovery`/`applicable_recovery` with independent
`source_recovery`, `search_recovery` and corresponding `applicable_*` presences.
delete `_recovery_offer`; retain permission-blocked explanations.

add readiness to `SearchRecoveryFacts`; fresh search-repair admission checks it
under the media lock AFTER replay, returning existing `E_REPAIR_NOT_ALLOWED` when
not ready. execution already has this requirement. this matters now: caption
publication can make a video ready while its earlier source job remains repairable;
a failed index then permits both repairs. do not gate indexing on source success.
both admission and composed recovery are covered by the verification receipt.

## 6. content and interaction

each feature has a content reviewer in its workstream. the bibliography designer
owns prompt/input/output meaning; the imports designer owns status, actions,
filter language and history; the runtime designer owns actionable failure and setup
copy. each reviews the rendered result against the schema, not just strings.

keep the current row/inspector structure. show concurrent failure and progress;
the inspector has source, search and metadata sections with their own actions.
retain keyboard/focus behavior and existing visual tokens. extraction/index repair
must never be the action attached to a metadata failure.

extract pure presentation into `lib/media/mediaMetadataCopy.ts`, consumed by
imports and `components/media/MediaInfoOverlay.tsx`. no second failure catalog.

| fact | copy | action, when permitted |
|---|---|---|
| queued / running | “metadata research queued” / “researching metadata” | none |
| recovering / retry wait | “recovering interrupted metadata research” / “metadata research will retry [time]” | none |
| failure | “metadata research failed” + safe specific reason | “retry metadata research” |
| no findings | “no metadata found” | “mark reviewed”; secondary “research again” |
| reviewed no findings | “no metadata found · reviewed” | “research again” |
| changed / unchanged success | “metadata updated” / “metadata checked; no changes” | “research again” |
| absent operation | “no recorded metadata research” | “research metadata” |
| older unfinished jobs | “[n] earlier metadata runs remain unfinished” | respect active-work barrier |

subtract the latest operation from that count only if it is unfinished. shared
menus retain “research metadata”; contextual retry/again labels need the operation
already present in imports/overlay, not another presentation field on capabilities.
review help: “removes this result from needs attention for you. it stays in history.”
partial success lists “not established by this run”, without attention. say content
remains readable/playable only when the corresponding readiness is true.
`model_unavailable` means research unavailable, including missing tools; do not
blame only the selected model. expose safe reason/job/generation/time, not prompts,
credentials or raw exceptions. reuse the rest of the existing closed failure copy.

generated output keeps its eight required nullable fields and strict whole-result
validation. good output identifies the saved bibliographic unit; distinguishes
work/edition; uses supported date precision, edition-specific isbn/publisher,
correct contributor roles/handles, and one to three factual description sentences.
book dates exclude earlier serialization/broadcast; standalone essays include their
own first periodical publication. unsupported facts are null. no fabricated
completeness, schema repair generation or change to model/effort/four-tool policy.

tradeoff: null preserves existing scalars, so research cannot erase an unsupported
old scalar. only authors have a manual pin. concurrent edits remain protected by
fresh evidence checks; adding scalar pins or historical repair is separate work.

## 7. local capability

extend `docker/docker-compose.worker.yml` using `nexus-codex-agent-host`,
`codex-egress-policy`, nginx configuration and two networks from
`deploy/hetzner/docker-compose.yml`. only host/proxy join the private network;
adapt project-scoped networking and use ordinary local logging, not journald.
the existing worker image already contains the host; no dockerfile change.
retain the pinned binary, confinement, read-only root, limits and egress allowlist.
share the existing project-scoped
`nexus_codex_run` volume/socket with workers. keep api/web host-native for this path;
no host-socket bind, tcp bridge, api container or alternate adapter.

add explicit `OPENAI_API_KEY` pass-through to both lanes and `BRAVE_SEARCH_API_KEY`
to interactive; brave base url/timeout and metadata content-word limit go to
interactive, embedding model/dimensions to both lanes. normalize these
two keys at `config.py` ingress: strip; blank becomes `None`. preserve production
required-key validation. missing local credentials leave unrelated tasks available
and research visibly unavailable. do not use empty-string compose defaults or
inject the whole `.env` into the native host.

define `NEXUS_LOCAL_CODEX_ACCOUNT_DIR` as an explicit existing account-directory
bind, defaulting to `../.nexus-local/codex/codex-personal`, with
`create_host_path: false`; uid 10001, directory 0700, auth file 0600. only host/proxy
use the optional `codex` compose profile; workers have no host/health dependency.
reuse the local build declaration, not production's required image interpolation.
the profile adds no required parse-time variable. ordinary workers start without
account state. for research: prepare the private account directory, stop host,
run its `apps.codex_agent.enroll` one-off, explicitly start host and await health,
then start workers. only the host mounts the account; never copy production credentials.
worker health, native
catalog health and actual tool execution are separate observations. genuine local
enrollment is a verification prerequisite, not a reason to add fallback behavior.

## 8. implementation boundaries and workflow

paths below are relative to `python/nexus/` unless prefixed otherwise. one writer
per file. agree contracts before parallel edits; integration owns shared artifacts.

| stream | exclusive implementation ownership | reviewer/content role |
|---|---|---|
| a: queue settlement | `jobs/queue.py`, `jobs/worker.py`; queue contract in `docs/modules/jobs.md` | concurrency reviewer; runtime failure designer |
| b: research/source correctness | `tasks/enrich_metadata.py`, `services/{metadata_enrichment,metadata_dispatch,media_source_ingest,media_source_adapters,youtube}.py`, `services/transcripts/{state,current}.py` | data/concurrency reviewer; bibliography designer |
| c: metadata read/review | `schemas/metadata_enrichment.py`, `services/metadata_operations.py`, new `services/metadata_reviews.py`, `services/generation/ledger.py`, `api/routes/media.py`, review cleanup in `services/media_deletion.py`; `docs/modules/media-metadata.md` | authorization/replay reviewer; review-content designer |
| d: imports and composed actions | `schemas/{imports,import_history,resource_action_snapshots}.py`, `services/{imports,import_history,media,content_indexing}.py`, `services/resource_items/action_snapshots.py`; web `lib/imports/*`, `components/imports/*`, metadata copy/observer/overlay and `lib/actions/*`; `docs/modules/imports.md` | query/capability reviewer; imports interaction designer |
| e: local capability | `config.py`, `docker/docker-compose.worker.yml`, `.env.example`, `apps/worker/README.md`, local setup in `docs/runbooks/codex-personal-agent-host.md` | runtime/credential reviewer; setup-content designer |
| f: integration and qualification | one next canonical migration after `0276`, generated `apps/web/src/lib/api/wire.gen.ts`, this plan/receipts/ticket register, temporary external campaign | independent acceptance reviewer |

integration migration contains only transcript revision and review storage/indexes;
check the current head at implementation, do not create parallel migration heads.
the metadata schema owner supplies contracts before d consumes them. d owns every
web edit, including review actions; c supplies endpoint semantics. b uses a's
settlement primitive. a and e can proceed independently; the final cutover is aligned.

for each stream: write failing target-behavior cases → independent reviewer attacks
invariants and oracle → implement → prove green → review race/error paths and
content → refactor → rerun affected cases. reviewers must identify evidence or a
specific counterexample, not hypothetical architecture expansion. resolve material
objections before moving on; ticket any separate defect immediately.

## 9. temporary acceptance campaign

this session authorizes a finite exception to the static-only repository policy.
leave `./scripts/test` unchanged. put temporary runner, fixtures, responder and fault
configuration in `/tmp/nexus-metadata-<nonce>/`, outside the shipped tree. use an
isolated compose project, postgres/minio state, auth identities and ports. exercise
real browser/bff/api, parsers, storage, queue claim/heartbeat, both lanes and database
transactions. synthetic/public-domain fixtures only; no production credentials/data.

control external responses at existing boundaries: the configured native unix
socket with its pinned handshake/catalog/tool protocol, `YOUTUBE_DATA_BASE_URL`,
and existing `X_API_BASE_URL` for canonical-source fixtures.
internal monkeypatches, production failpoints and a database-wire proxy are excluded.
use database locks/cancellation and actual process pause/kill for failures.
domain red cases may supply the missing native/tool bindings to reach the intended
failure. test the stock-compose capability defect separately, without that override.

| acceptance | required evidence |
|---|---|
| original defect | document imports/readability succeeds; metadata failure appears in attention, detail and history; its action admits only metadata |
| independent obligations | metadata failure + indexing progress stays in attention while polling observes completion; simultaneous failures filter by their own stage/code |
| all recorded work | metadata-only rss item appears; newer request supersedes older failure; older live job keeps polling and blocks another request |
| review/replay | exact no-findings review survives reload/lost response, differs by viewer, preserves history; reviewing old result cannot dismiss newer failure; failure cannot be reviewed |
| input identity | pending→indexing→ready and index-only rebuild change neither input nor fingerprint; document/transcript replacement beyond the sampled prefix invalidates |
| publication races | concurrent scalar edits and unchanged-roster author pin survive; revoked access/lost claim writes nothing; serialization retry reloads and does not generate twice |
| automatic promise | enqueue sql failure rolls terminal source publication back; crash after source commit cannot lose/duplicate promised metadata; source replay creates one job |
| atomic terminal outcome | crash after metadata publication preserves success/result, also on attempt two; no extra generation after restart; transition hooks run once |
| executor lifecycle | self-settled terminal return is accepted; reaper terminal death stops a live child; stale/reclaimed execution cannot publish |
| recovery composition | ready video with repairable source and failed index offers both actions; search repair does not restart source; non-ready fresh repair refused, accepted replay preserved |
| video policy | no key, provider failure and missing/malformed snippet still admit research for playable video; empty provider items remains source-gone |
| runtime/content | absent/blank/whitespace keys are unavailable; valid tools and native host work; malformed/all-null/partial/unchanged research has correct outcome and copy |
| storage/wire | populated isolated migration preserves existing jobs; review cleanup permits supported teardown; history ids/page ties/filtering are correct; old cursors rejected |

include these boundary variants: attention(metadata failure) must not match an
active index's stage; older/inapplicable live jobs keep polling; terminal latest
metadata exposes its older active representative. review replay after access
revocation and a foreign job path return 404; same key/different job conflicts;
new key/same review returns original time; review/admission wakes idle imports.
workers start with account path unset/absent; explicitly requested native startup
fails clearly. local/remote file rollback permits a real epub retry without
forbidden republication; unrelated published epubs remain immutable. canonical
teardown cannot preempt winner obligations. reservation cleanup retains referenced
objects after postcommit process death.

deterministic publication-gap case: hold a fixture reader-publication row; let the
publisher acquire media/job and block there. queue a READ COMMITTED `SELECT` of that
exact job `FOR UPDATE`, without a status predicate. prove the trap is next using
`pg_blocking_pids`, waiting statements and tuple locks; reset if heartbeat is ahead.
release the reader row; the trap captures the interval before worker settlement.
baseline exposes published facts with a running job; fixed code exposes facts and
terminal result together. kill worker while trapped, release, restart and observe
lease recovery. obtain attempt two by a real earlier crash, not counter mutation.

for source finalization, hold a youtube response containing a title but no channel
credit. after `SourceExecutionStarted`, lock `media_processing_events` in `SHARE`
mode, then release the response. the terminal `SourceSucceeded` insert blocks;
queue the media-row trap, release the history lock, then inspect source success
and metadata-job count. kill/recover before old post-success enqueue can reacquire
media. separately block/cancel the metadata insert for this no-index video fixture
to prove enqueue rollback.

for local/remote file publication, gate the `reader_publications` insert with a
`SHARE` table lock and queue the media-row trap. baseline releases media after
artifacts alone; fixed code releases it after all source obligations commit. test
death both before that commit and while the trap holds afterward: recovery must
produce exactly one publication and metadata job. retained uploaded bytes may
survive rollback; reader projection and terminal success may not. verify wait
topology; arbitrary sleeps prove no commit boundary. use a small public-domain
remote epub accepted by safe-fetch; never add a loopback/ssrf exception. cancelling
a file's first queue insert tests index-admission rollback; label it accurately,
since the video case separately exercises the exact metadata insert.
these gates rely on postgres's [row-lock](https://www.postgresql.org/docs/15/explicit-locking.html)
and [read-committed recheck](https://www.postgresql.org/docs/15/transaction-iso.html)
semantics, and must themselves be qualified against the isolated engine.

use one `qualify.py` runner with `red`, `green` and `final` phases through
`uv run --project python --frozen --no-sync python /tmp/nexus-metadata-<nonce>/qualify.py <phase>`.
this finite campaign was executed; the verification receipt records its results.
red records intended baseline failures;
setup failure is not red. green repeats those assertions; refactor repeats affected
boundaries. before final, remove fault/provider overrides and restore normal
candidate services; keep isolated ports/state/cors configuration. final
qualification includes an uninstrumented import using the real native
host, exact model/effort and four-tool plan. record actual search/read executions;
qualify any required tool the model did not exercise through its existing tool
pipeline, labeled separately. inspect persisted bibliography against section 6.
controlled output does not
qualify provider capability. keep the live fixture count small; no benchmark suite.

save `docs/metadata-imports-verification.md` outside the disposable directory:
source sha/diff identity,
built image identity, schema, case outcomes, fixture/job/generation ids, tools and
limits. delete all temporary tests, responders, fault config,
fixtures and added test dependencies; retain no test-only production code. then run
`./scripts/test`. deleting runtime checks gives up future automated regression
protection; static checks and receipts do not replace it. isolated success also
does not establish production configuration or provider reliability.

## 10. cutover and done

remove the old sampler branch, whole-intent fence, swallowed enqueue path, separate
metadata settlement commit, worker-only reaction owner, singleton recovery shape,
duplicate metadata copy and old history-id/cursor decoder. update module docs at
their owners; no new generic infrastructure. existing historical job outcomes stay
readable through their current decoder; this change introduces no old/new decoder.

a future authorized release aligns api, worker and web, stops writers, takes the
required verified backup and applies the single canonical migration through the
existing controller. retain exact schema/version and health requirements from
[deployment.md](../deployment.md). repair defects forward with a new release.
restoring a backup is separately reviewed disaster recovery with possible loss of
later writes, not immediate rollback. no production smoke, census or retry is part
of this campaign. the two existing failed jobs remain untouched and may become
newly visible under the corrected projection.

done means all acceptance cases have receipts, content review passes, adversarial
objections are resolved, temporary checks are deleted, static checks pass, and no
retired path remains. delete resolved tickets only after implementation; record the
fix in its commit/pr. the verification receipt records implementation evidence;
the specification alone is not proof.
