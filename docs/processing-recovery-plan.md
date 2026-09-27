# processing recovery

status: implementation in progress; [isolated execution evidence](processing-recovery-execution.md); production acceptance `NOT_RUN`
origin: 2026-09-26 owner approval of [the investigation](processing-failures-review.md)
authority: this plan specifies implementation; the review retains evidence and the item inventory.

## goal and boundary

recover the diagnosed library through its existing owners. preserve original
bytes, media identity, filing, reader positions and historical failures. source
publication, source limitations and search readiness remain independent facts.

scope: apparatus cost; explicit retained-epub reprocessing; honest missing-image
and navigation diagnostics; the two keats publication repairs; gutenberg source
correction; ordinary video/x/fanged and note-index recovery; the recorded
admission, reconciliation and storage-classification defects as a separate slice.

non-goals: scraper/bypass services, automatic alternate-source chains, generated
replacement text/images, general source-replacement ui, svg degradation, new
transcription/ocr, metadata/generation repair, oracle cleanup, navigation redesign,
global caches, larger resource limits, new queues or permanent test infrastructure.
browser capture uses the existing extension. no forced zero-attention target:
denied sources or absent replacement bytes may remain unresolved honestly.

## contracts and composition

existing flow: source admission → postgres job → bounded parser → fenced reader
publication → separate content-index job → imports/reader projections.
keep each mutation in its owning service; transports only decode and dispatch.

### 1. source analysis and quality

- `html_apparatus` memoizes the existing normalized/lowercased 80-character
  ancestor prefix for one parsed tree. retain prefixes only; discard on return.
  target discovery and extraction use the same helper. no unicode-semantic change
  or descendant-text mutation while the memo is live.
- only proven absent local HTML image bytes may become recorded source issues.
  validate archive/path confinement first. preserve usable authored `img`
  candidates; record missing references; replace an image only when no usable
  candidate remains. preserve existing archive/integrity/svg rejection; detected
  corruption never means absence. missing svg resources, unsafe paths,
  unmanifested-but-present assets and missing essential spine/package structure
  still reject. no new raster decoder. storage failure is not source absence.
  generated notices cannot establish readability: require surviving nonblank
  canonical source text or a retained supported image in reading-order content;
  otherwise return `E_SOURCE_NOT_READABLE`.
- reuse the offline image-placeholder mechanism through one pure shared helper.
  preserve authored id/name, tail and visibility. accessible wrapper says “image
  unavailable: {authored alt}”, or “image unavailable” without alt. visual text is
  `aria-hidden` and excluded from canonical/indexed/quotable text. strip inbound
  generated marker attributes before assigning local ordinals. never invent letters.
- unresolved local navigation destinations remain nonactionable in the existing
  node projection, including parent labels and valid children. record these targets;
  never guess a chapter-start destination. ordinary href-less labels are valid.
  preserve source body anchors; a sanitizer regression is a defect to repair.

add one strict schema module, `schemas/source_issues.py`:

```text
SourceIssue =
  MissingImage { kind, fragment_id: uuid, marker_ordinal: nonnegative int,
                 resource_path: normalized package-relative path }
  | UnresolvedNavigationTarget { kind, node_id: existing bounded string,
                                 href: existing resolved local href }

reader_publications.source_issues: jsonb NOT NULL DEFAULT []
```

use literal kind tags `MissingImage` and `UnresolvedNavigationTarget`. one owned
`data-reader-source-warning="<ordinal>"` marks each affected img or placeholder,
unique within its fragment, even when another image candidate remains usable.
multiple missing paths can share that marker. deduplicate by fragment/ordinal/path.
validate marker targets and navigation ids against the publication; unresolved
nodes must have absent targets. repeat those checks in offline validation using
its existing fragments and navigation lists. paths are ZIP identities; no second
URL decode. external navigation hrefs retain current policy and are not new issues.

one row's existing generation owns its entire ordered issue list. empty means
“no recorded issues”, never “complete reproduction”. count each missing reference
once per source element/path and each unresolved navigation node once. all new
source publications explicitly replace issues, including `[]`; title changes and
stored-html normalization preserve them under the publication lock. extend the
existing publication entrypoint with required `Preserve | Replace(issues)` intent.
commit issues, fragments, assets, navigation and generation atomically under the
existing source execution fence. no warning table, duplicate status or failure-code
abuse. historical failure events stay unchanged.

cap issues at 10,000 records; charge serialized UTF-8 diagnostics and placeholder
bytes against the existing 64 mib output budget. overflow is `E_RESOURCE_LIMIT`
with dimension `Output`; no truncation or partial successful publication.

### 2. public reads, actions and offline composition

reuse existing endpoints; strict python/typescript decoding cuts over together:

| surface | contract |
|---|---|
| imports items | add `source_issue_count`, derived from current publication |
| imports detail | add `source_issues: Presence<{generation, issues: SourceIssue[]}>`; absent means no publication |
| existing media navigation response | add `source_issues: SourceIssue[]` under its existing generation |
| source retry | retain `POST /media/{id}/retry`, `{from_stage:"source", client_mutation_id, expected_attempt_id}` |
| exact dead execution/index repair | retain `/media/{id}/repair` and its existing inspected attempt/job/revision fences |

read issue facts from the publication owner in the same database snapshot as
readiness/navigation. no per-row object-store requests or client-derived eligibility.
ordinary retry remains owner-authorized. blocked sources keep capture guidance.
reprocessing after a processor correction is operator-only; no public force flag.

processing stays `Active | NeedsAttention | Complete`. a terminal processed
document with issues presents “readable with issues” in warning tone; it remains
openable/searchable according to existing capabilities. issues alone do not
create another queue failure or acknowledgement workflow. index failure retains
the readable publication and its issues.

carry the list through `ReaderPublicationProjection` into navigation, already
embedded in offline `reader.json`; no duplicate top-level list. hosted/offline
readers share a compact notice with reachable issue details and location/path
disclosure. advance reader contract and reader bundle from 2 to 3; archive grammar
stays 1. update strict python, typescript and kotlin validators together. old clients require update;
old downloaded packages require re-download through existing version handling.
preserve pending progress/account state. missing published local assets remain
storage/integrity failures, never silently converted into source warnings.

### 3. operator admission and narrow data repair

trusted operator entrypoint: `python -m nexus.ops.processing_recovery`. no new
http admin surface, caller-supplied privilege bit, job scheduler or repair registry.

```text
reprocess-source(media_id, expected_attempt_id, expected_source_sha256, mutation_id)
  -> existing SourceRetryAdmission {media_id, source_attempt_id, job_id}

correct-source-type(media_id, expected_attempt_id, expected_source_type, mutation_id)
  -> SourceRetryAdmission

normalize-web(media_id, expected_generation, expected_index_revision, mutation_id)
  -> {media_id, generation, index_revision, job_id}
```

derive creator identity from media. reuse `resource_mutation_replay` with distinct
operation scopes under that creator. same id/bytes returns the original receipt;
changed bytes conflict. lookup replay before storage I/O; verify source outside
transactions, then recheck all inspected facts under serializable admission.
stale facts return `E_RESOURCE_CONFLICT`; invalid operation returns
`E_REPAIR_NOT_ALLOWED`. no writes on refusal; no independent commits inside composition.

- **reprocess:** require current failed media/latest failed attempt and retained
  epub source with the exact hash; refuse existing publication, fragments or
  anchored/positioned reader state. current epub replacement changes fragment ids;
  preserving previously published epub identity is outside this repair. explicit
  invocation attests reviewed processing correction; record runtime sha in the
  operator receipt. share the source owner's new-attempt admission with ordinary
  retry. atomically append
  attempt, mark queued, enqueue, append recovery event and record replay. add
  `ReprocessSource {new_source_attempt_id}` to the existing recovery-history union.
  every current parser/security/resource validator still runs; old failures remain.
- **gutenberg correction:** require failed `generic_web_url`/web article, no
  publication, fragments, file, positioned cursor or anchored reader content.
  classify its stored url with `url_source_spec`; require inspected result
  `remote_epub_url`. atomically change kind, create the correctly typed attempt,
  enqueue and record `CorrectSourceType {new_source_attempt_id, source_type}`
  recovery history. retain media id, metadata, creator and all filing. violated
  preconditions stop the repair; there is no replacement fallback.
- **web normalization:** transform stored html with the current heading owner;
  require exact canonical-text equality, preserved authored ids/targets and
  unchanged fragment ids. preserve all cursor/highlight state and issue facts.
  atomically advance publication generation and call `request_media_content_reindex`.
  retain old failed jobs/history; never refetch or weaken the index assertion.
  keep media locking at `FOR NO KEY UPDATE` for these non-key publication changes,
  compatible with queue-history foreign-key inserts; prove worker concurrency.
- **notes:** use existing `enqueue_note_reindex` in its caller transaction;
  index current bodies. no serializer change without a reproduced current defect.

preflight every epub recovery, including ordinary fanged retry, for existing
publication/reader state. stop unsupported cases and record them; never reset state.

the two bounded correction commands are removed after verified recovery; reusable
retained-source reprocessing remains. delete private helpers with no surviving caller.

### 4. durable admission and reconciliation

commit url acceptance, refresh and system-repair attempts with their jobs whenever
input is already durable; reuse `enqueue_accepted_source_attempt_in_transaction`.
retain upload-session ownership across external verification. select recoverable
source obligations from latest attempt facts, including accepted/jobless work.
exclude exact live or dead queue-owned obligations BEFORE the discovery limit;
dead work stays suspended until explicit recovery. apply the same selection rule
to pending indexes. generic storage errors retain infrastructure retry/defect
semantics; only confirmed missing objects justify “source unavailable”. move
ordinary retry's replay lookup ahead of storage verification too.

## designer-owned content

each package pairs its implementer with the designer below. the designer supplies
populated examples before code and judges rendered output. good content states
the observed limitation, what remains usable, and an actually available action.
use existing shared status copy, action catalog, imports inspector and reader
notice area; never put instructions into canonical source prose.

| feature / designer | required content |
|---|---|
| incomplete source / editorial + accessibility | “readable with issues”; “some images are unavailable. you can read the available text.”; preserve real alt text, expose every issue location/path in details, use accurate singular/plural counts; never promise all text survived |
| navigation / reading | “some contents links are unavailable. you can still read the book in order.” only after complete spine traversal is verified; no guessed destination or silent omission |
| processing / interaction | “processing took too long”; “no readable content was found”; “no retry is currently available for this import”, with existing cause-specific action. remove permanent-impossibility claims |
| recovery / operations | existing retry/repair/reindex action labels; explain stored bytes versus refetch and new versus stopped attempt. submitting → “starting…”; admitted → “queued”, never “fixed”. history: `ReprocessSource` → “reprocessing accepted”; `CorrectSourceType` → “source type corrected; processing queued”; exhaustively render every variant |
| indexing / information | “search indexing failed. you can still read this document.” only when `can_read`; make no unverified quotation/highlight promise |
| capture/correction / content | “this page blocked the import”; existing open-original/capture guidance with no success guarantee. operator receipts report old/new identities and actual publication/index outcomes |

## non-overlapping implementation packages

paths below are relative to `python/nexus/` unless stated. one owner per file;
the named shared owners accept changes from other packages. stages are ordered
where ownership overlaps, not parallel edits to the same service.

| package | exclusive responsibility / principal files | depends on |
|---|---|---|
| a · source processing | `services/html_apparatus.py`, `services/epub_ingest.py`, `services/epub_structure.py`, `services/epub_sanitize.py`; shared placeholder helper | b's issue types |
| b · publication contract | issue schema, `db/models.py`, one alembic migration, `services/reader_publication.py`, `services/imports.py`, `services/epub_read.py`, `schemas/imports.py`, `schemas/media.py`, source-history union/codecs; publication lock and normalization operation | none |
| c · recovery/admission | `services/media_source_ingest.py`, `services/capabilities.py`, `tasks/reconcile_stale_ingest_media.py`, `ops/processing_recovery.py`; replay, source correction, notes coordination; index-owner changes only here | b |
| d · presentation/delivery | `apps/web/src/lib/status/imports.ts`, imports client/row/inspector, reader notices/action copy, offline package/delivery schemas, shared TS reader contract and Android offline validators | a, b, c |
| e · integration/repair | temporary live checks, exact-item operator run, receipts, ticket/register resolution and deletion of temporary tests/one-shot commands | a–d |

b owns all migrations and shared persistence/history contracts; c calls b's
publication operation and owns index coordination. d alone changes offline
delivery and consumes a's shared helper. coordinate apparatus edits with the
separate source-notes plan; this slice adds no new apparatus recognition rules.

## red / green / refactor / remove

the owner's explicit request authorizes temporary end-to-end integration/live
tests. create them outside retained application code against an isolated real
database/queue/object store and authenticated browser; use the exact source files
and safe counterexamples. no mocks, auth bypasses or production test seams.
`./scripts/test` remains the sole permanent static gate, unchanged.

| acceptance | observable proof |
|---|---|
| a1 · cost | joyce fails baseline; fixed code publishes under unchanged 30 s and worker memory limits. apparatus/html/text match the diagnostic oracle; measure Linux container peak/counters, then open the book |
| a2 · honest partial source | all four image cases and pierre publish readable content with issues; every absent reference is disclosed hosted/offline; surviving text/assets remain; diagnostics never enter canonical text. an image-only book with every image absent rejects. existing archive/integrity/svg rejection survives; independent failure is blocked, never green. new publication clears old issues; title/normalization preserves them; dangling markers/nodes and missing published assets reject |
| a3 · admission | real operator/HTTP → queue → worker → publication. lost-response replay returns identical admission even during later storage outage; changed mutation bytes, stale attempt/hash, lost execution claim cannot publish |
| a4 · publication repair | both keats indexes become ready; original fragment ids/text/targets survive; letters keeps offset 52 and this living hand keeps its empty cursor. concurrent index settlement cannot deadlock or publish an obsolete revision |
| a5 · source correction | gutenberg retains media id/filing/history, processes as epub and opens; a published or changed candidate is refused |
| a6 · durable work | process interruption cannot leave committed durable acceptance without work; a jobless obligation behind 25 older dead rows is discovered once; dead jobs remain suspended |
| a7 · outcomes/content | fanged publishes; both note indexes become ready from current bodies. video/x/capture report provider-dependent outcomes separately; video success does not imply captions, capture success requires readable captured content. hosted and exact installed Android artifact show matching issues; incompatible packages require re-download without lost progress |

for EVERY package: challenger reviews contract/content examples → observe target
failure on baseline → implement → obtain real green evidence → adversarial diff
review/refactor → rerun affected checks on final code → delete temporary tests,
fixtures, instrumentation and dead code. retained invariants may already pass
baseline; do not manufacture failures. preserve concise receipts, artifact hashes
and unresolved tickets, not test infrastructure. challenge stale writers, altered
bytes, false success, lost source text and unintended authority at each step.

## hard cutover and trade-offs

take the existing release backup and use the release owner. migrate current
publication rows to an empty recorded-issues list without claiming a historical
quality audit. publish server/web/native strict contracts together; remove old
decoders, duplicate placeholder/copy logic and permanent-impossibility copy.
retain ordinary recovery eligibility except the specified storage correction.
historical records remain facts, never executable compatibility paths. code revert
alone does not undo schema/data repair; use the verified backup or forward repair.

trade-offs: partial reading reduces fidelity but exposes it; operator reprocessing
adds deliberate control instead of automatic repeated rejection; 10,000 diagnostic
records bound memory at the cost of rejecting larger damaged books; offline truth
requires a small coordinated contract cutover and re-download; browser capture
requires user participation; previously published epubs stop for separate identity
preservation work. current repairs precede separately evidenced latent
defects. deleting temporary tests leaves behavioral regression detection to use
and subsequent targeted checks; retained receipts prove only their tested artifact.
all of this reuses current storage, queue, history and publication owners.
