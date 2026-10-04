# metadata enrichment: implementation contract

status: local metadata, current native/main composition, genuine three-item
research and restored-copy release preparation GREEN at `bcb86e020`.
disposable proofs/fixtures deleted; final `./scripts/test` PASS at unchanged-tree
native-main merge `6f036a29a`. production release and
saved-item repair remain separately reserved; section 9 is not complete.
owner decisions: 2026-10-01–02. [verification receipt](metadata-enrichment-verification.md).
scope: nexus metadata only. the separate kernel agent owns model execution.
no unanswered product questions block this plan. paths below are repository-relative.

## 1. target and invariants

one enrichment researches the identified item, accepts one strict result, and
publishes through one inspectable background job. reading remains available.

- books: first **book** publication, excluding prior serialization, broadcasts
  and lectures. collections: that collection's first book publication. essays:
  that essay's first publication, including periodicals, not its later collection.
  an epub container does not establish that its content is a book.
- other supported media retain first-public-release semantics for the identified
  item; provider acquisition/scheduling times are never publication dates.
- translations/reprints retain the work's original date. edition facts describe
  the encountered edition. preserve known year/month/day precision; invent none.
- unknown never erases an existing scalar. an empty, explicitly observed
  contributor role may clear that role. omitted roles remain untouched.
- no findings, failure, uncertainty and stale input never advance
  `metadata_enriched_at`. accepted research may advance it without changing values.
- durable provider truth, domain acceptance and queue settlement are distinct.
  a successful model call with no findings is not successful enrichment.
- publication is atomic and replayable; retrying an operation never buys another
  completed generation. uncertain submission blocks fresh research until settled.

non-goals: new kernel/runtime, provider fallbacks, manual field ownership,
confidence scores, per-field evidence records, citation requirements, additional
historical date types, fuzzy person merging, batch dashboard, permanent test
infrastructure, or general workflow platform. retain existing supported media
kinds, access rules and contributor vocabulary.

## 2. research and capability contract

`generation_policy.py` selects codex personal, `gpt-6-luna`, `xhigh`, with the
existing 300-second deadline and 32 kib input bound. freeze a 64,000-token
context budget and an 8,000-token output reservation. admit that
exact catalog selection or report unavailability; never silently substitute.
qualify the deadline live before changing it.

user decision, 2026-10-02: retain those admission/reservation budgets. stock 0.160
has no native hard context/output token-cap field; report that enforcement limit
explicitly. observed usage and frozen numbers do not prove enforced ceilings.

supply current metadata, complete ordered credits with contributor handles,
source/provider identifiers, media reference, and up to 1,000 normalized opening
words. keep the existing first-available text-source order. bound raw reads to
64,000 characters in total; normalize before taking words. clamp descriptive
hints using existing hint limits, then fit the excerpt into the remaining
serialized utf-8 budget. use literal unicode json. never truncate identifiers,
dates, or the credit list into a false complete observation. if fixed context
alone exceeds 32 kib, fail `input_too_large` before dispatch. replace the old
sample setting with `metadata_enrichment_max_content_words` / corresponding
uppercase env key, default 1,000; update `.env.example`. no second context builder.
bound the final content including admission facts; append no unbudgeted suffix.

research uses `nexus.document.search`, `nexus.resource.read`, `web.search` and
`web.read` through the generation owner; use identifying strings in web queries,
never private document passages. input text is evidence, not instructions.
no compulsory search count, front-matter classifier or evidence-packet builder.

external kernel dependency: the kernel agent supplies supported-request
validation, durable terminal truth, safe recovery and genuine web search/read
execution. nexus metadata consumes those contracts through its existing
generation service. capability absence is a visible failure. no metadata-owned
adapter, bridge, sandbox or dispatch recovery. a live run must demonstrate the
selected model/reasoning and successful search/read before release.

## 3. generated schema and publication

one external json object; every listed key is required and nullable; all objects
forbid extra keys. reject malformed output as a whole, without repair prompts.

| key | non-null value |
|---|---|
| `title` | nonblank string, at most 255 characters |
| `contributors` | 1–12 unique role slices, defined below |
| `original_published_date` | existing calendar-valid `PublicationDate`: `yyyy`, `yyyy-mm`, or `yyyy-mm-dd` |
| `edition_published_date` | same type |
| `edition_isbn` | canonical checksum-valid isbn-13, 13 digits |
| `publisher` | nonblank string, at most 255 characters |
| `language` | existing two-lowercase-letter language code |
| `description` | nonblank plain text, at most 2,000 characters |

role slice: `{role, credits}`. `role` uses `CONTRIBUTOR_ROLES_ORDERED`; at most
one slice per role. `credits` contains 0–20 ordered objects, each exactly
`{contributor_handle, credited_name, raw_role}`: nullable admitted handle,
nonblank name at most 200 characters, nullable raw role at most 80 characters.
reject duplicate identity within one role; the same person may hold several roles.
`contributors: null` means no observation; `[]` at the outer level is invalid;
`{role: "author", credits: []}` explicitly clears authors. unknown roles use
`unknown` plus `raw_role`; do not expand the taxonomy.

at this untrusted boundary, convert accepted nulls immediately to existing
`Presence<T>` and validate handles against the submitted item's admitted credit
set. existing handles bind identities; changed credited spelling neither creates
nor renames the person. a null handle uses the contributor owner's exact
identity/alias resolver. retain changed spellings as searchable nonresolving
aliases; never generate resolving aliases or fuzzy merges. deduplicate by person
and role, not spelling. recheck
source/credit context at publication through the frozen-input fence.

reuse `PublicationDate`. extract the current epub isbn checksum/normalization
into a shared schema owner; external source adapters may normalize isbn-10, but
generated output must already satisfy canonical isbn-13.

merge non-null scalars; null preserves. reuse the reader-document title owner,
contributor writer and collection revision invalidations. keep the existing
`authors_manually_managed` rule, rechecked during publication; this plan creates
no new pins. report `retained_manual_authors: true` only when that rule withheld
a differing author proposal. `changed_fields` describes actual stored changes.
call title/role replacement only for semantic changes; unchanged research must
not bump reader generation or delete/reinsert identical credits.

all eight nulls yield `no_findings`. an explicit empty role slice is a finding.
non-null confirmation of an existing value is successful research. partial
results are successful; no inference of completeness from a success label.
`unresolved_fields` is the fixed-field enum subset whose generated value was
null, not a new evidence protocol. original-date copy distinguishes a stored
unknown from an existing date the research could not verify.

## 4. execution, persistence and admission

composition: admission → existing `enrich_metadata` job → existing generation
service → accept json → fenced domain publication → worker settlement.

keep job id as operation id, the stable generation identity and `codex/metadata`
journal step. store the accepted result and publication outcome in the existing
memo; owned nullable values use `Presence`, including `published`.

`MetadataField` is the eight-key enum from section 3. `MetadataFailureCode` is
`catalog_unavailable | configuration_error | model_unavailable |
authentication_failed | quota_unavailable | research_timeout | invalid_output |
input_too_large | output_limit | stale_input | no_longer_eligible | access_revoked |
cancelled | policy_violation | worker_interrupted | execution_failed`.
map existing typed errors once in the metadata owner, before generic worker
classification loses them; unknown diagnostics become `execution_failed`.

`MetadataOutcome` is a tagged union:

- `completed`: `completed_at`, `changed_fields`, `unresolved_fields`,
  `retained_manual_authors`.
- `no_findings`: `completed_at`.
- `failed`: `completed_at`, `reason: MetadataFailureCode`.

use database time. under the media lock, the successful stamp is
`greatest(clock_timestamp(), previous successful stamp + interval '1 microsecond')`
(clock time for the first); use that same instant for `completed_at`. it is a
monotonic publication marker, not an elapsed-time measurement. publish metadata,
successful timestamp, outcome checkpoint
and collection invalidations in one transaction. preserve media→job claim lock
order and the existing claim/source fences; perform no network call in this
transaction. a lost claim cannot publish. publication replay reads the stored
outcome and never merges/stamps again. a completed provider terminal stays
completed even when domain acceptance returns `no_findings` or `invalid_output`.

| event | queue behavior | domain publication |
|---|---|---|
| accepted finding, including unchanged/partial | `succeeded` | atomic accepted values and successful timestamp |
| no findings; invalid output; stale/ineligible/access-revoked; terminal generation failure | `dead`, nonretryable | no metadata or successful timestamp change |
| retryable failure proven before submission | existing bounded retry (`failed` is nonterminal) | none |
| uncertain submission | existing uncertainty barrier; no fresh dispatch | none |

add one explicit `TerminalJobFailure` handler result to the existing worker
result union: `{result_payload: Mapping, error_code: str, error_message: str}`
in `jobs/queue.py`. recognize it before dictionary conversion; metadata supplies
the result and safe error. no-findings uses internal `E_METADATA_NO_FINDINGS`
bookkeeping without inventing a public failure code. route it through
`fail_job(force_dead=True)` under the same live
claim. do not implement this with `failed_result_statuses`, which retries
completed research. execute existing dead-letter/history hooks exactly once.
terminal user copy is derived from safe typed codes; raw
provider output/tracebacks stay in existing operational records.

retain metadata jobs in **both** terminal states through the registry/pruner;
add `finished_at` to `JobRow`. retaining all metadata jobs is intentional for
this corpus: simplest inspectable history and replay, at the cost of storage.
no second history table or metadata mirror in source-processing error fields.
new failures come from the operation projection; remove metadata writes to the
legacy media error triple and clear only old `failure_stage=metadata` projections
at cutover. preserve unrelated source/index errors.

manual admission uses existing `resource_mutations`, scope
`media_metadata_enrichment:{media_id}`, existing client mutation uuid type and
canonical request hashing. require `expected_job_id: Presence<UUID>` naming the
latest job seen. authorize first; replay returns the same job, even after it
finishes. otherwise lock media, then matching jobs in stable order; recheck
read/creator authorization, receipt, expected latest job, eligibility and
barriers; enqueue and save receipt in one transaction. latest order is
`(created_at desc, id desc)`.

block a fresh manual request if any metadata job is pending/running/failed, or
any retained metadata step has unresolved dispatch. expected-job mismatch is
409 `E_RESOURCE_CONFLICT`; active/uncertain is 409 `E_RETRY_NOT_ALLOWED`.
replay lookup precedes these fresh-request checks. a lost response resends the
same mutation id and body; an intentional rerun gets a new id.

automatic ingestion keeps its existing enqueue timing and source-readiness
semantics, but uses the same job/result schema and returns the actual job row.
all metadata insertion paths acquire the media lock before inserting. stamp
enqueue time there using the database clock, not transaction-start `now()`, so
an older transaction cannot insert a falsely older latest job. keep it strictly
after the preceding metadata enqueue time under that lock, including clock ties
or reversal (`greatest(clock_timestamp(), previous + interval '1 microsecond')`).
no generation advisory lock is acquired merely to enqueue.
do not suppress a source-change-triggered job by coalescing it with stale work.
existing source fences decide whether its research may publish.

rss ingestion stores one nullable, source-owned bibliography fingerprint on
`podcast_episodes`; never derive its initial value from enriched media. new or
changed feed observations update source facts and enqueue atomically. identical
observations preserve researched facts and admit no new work. include complete
description text and supplied/show-default authors; exclude diagnostic provider
aliases, which update independently. the full observed source remains fenced
even when its tail falls outside the bounded research excerpt.

## 5. api and live observation

one public submission path:

- `POST /media/{media_id}/metadata-enrichment`, body
  `{client_mutation_id, expected_job_id: Presence<UUID>}`; 202
  `Data[{media_id, job_id}]`. creator-only; unreadable/nonexistent is 404,
  readable noncreator is 403; existing eligibility applies.
- `GET /media/{media_id}` gains `metadata_enrichment: MetadataEnrichmentView`.
- `GET /stream/media/{media_id}/metadata/events` emits typed `state` snapshots
  of that same view. use existing stream-token auth and masked read access.
  reauthorize every snapshot; revoked/deleted media closes without data leakage.

`MetadataEnrichmentView = {operation: Presence<MetadataOperationOut>, retry,
last_enriched_at: Presence<datetime>}`. the timestamp projects existing
`metadata_enriched_at`, so publication by an older job still invalidates facts
while a newer job is latest. read facts, latest job and barriers in one database
snapshot: existing repeatable-read dependency for detail, a fresh repeatable-read
transaction for each stream snapshot.
`retry` is `{status: allowed, expected_job_id: Presence<UUID>}` or
`{status: blocked, reason: not_creator | not_eligible | active | uncertain}`.
this projection owns `can_retry_metadata` and the metadata action snapshot:
carry its expected job and precise blocked reason in `RetryMetadata`, rather
than mapping every false boolean to permission denied. row menus use their
inspected action snapshot; no per-row detail fetch or silently refreshed
expectation immediately before submission.
the operation owner exposes a batched read for requested media ids; reuse it in
media hydration and action snapshots, preserving their bounded query count.

the action runtime owns a per-media pending admission intent. reuse
`createMutationIntent`, retaining its uuid and frozen expected job after a
network failure; newer snapshots must not rotate an unresolved intent. return
the job id to the existing hud acknowledgement with its `metadata…` action.

`MetadataOperationOut` common fields: `job_id`, `created_at`,
`started_at: Presence<datetime>`,
`generation_id: Presence<UUID>`, `selection: Presence<{provider, model, reasoning}>`.
its `status` union is:

- `queued`; `running`; `recovering`;
- `waiting {reason: retry, until: Presence<datetime>}`;
- `completed {outcome: completed MetadataOutcome}`;
- `no_findings {completed_at}`;
- `failed {completed_at, code: MetadataFailureCode}`;
- `uncertain`.

projection precedence: published outcome; live exact claim; unresolved journal
submission; dead failure; durable wait; scheduled retry;
expired safe-to-reclaim claim (`recovering`); queued. a normal pre-dispatch
uncertainty checkpoint under a live claim still displays `running`. a crash
between publication and worker acknowledgement must not hide completed work.
public `completed_at` comes from the memo, or `finished_at` for queue-only dead
failures. all times are aware utc. do not
return payloads, prompts, raw `last_error`, or fabricate a generation id before
one exists. check uncertainty across retained jobs, not merely the latest job.
only the generation owner's `Completed` journal authorizes local publication
replay. a parent terminal beside an `Uncertain` journal cannot establish recovery;
the qualified native adapter exposes local recovery from the exact
provider-sealed model-turn terminal before any provider/catalog call.
metadata calls `generation_has_local_recovery` from its early uncertainty guard;
without a seal or exact authoritative non-submission proof, retain the barrier.
non-submission proof permits local failed settlement, never redispatch or a
fabricated successful terminal. parent terminal, local stop,
exceptions and missing usage/native identity are never recovery authority.
recover this job's uncertain step using its stored spec and intent, before current
source/access/eligibility checks. validate handles against that frozen input.
the existing publication fence then rejects stale or revoked facts; recovery
does not grant permission to publish them.

reuse `tail_snapshot_stream` and the existing `media_events` notification channel.
add a transport-only metadata-job insert/semantic-update/delete notification
trigger; exclude heartbeat-only lease updates. job payload changes cover journal
checkpoints. listen before the initial read. keep the stream open while a detail
consumer is visible, including after terminal status or an absent operation, so
later automatic jobs are discoverable. retain the shared server missed-notify
recheck; add no browser polling.

one shared browser observer per visible media id, using `sseClientDirect` and
`fetchStreamToken`, following the podcast lifecycle observer. pane and overlay
share it; no subscriptions per collection row or maintenance batch. detach when
no consumers remain; never cancel the job. terminal publication invalidates open
media details, title/credits and affected collections through existing owners.
reconnect snapshots reconcile changes missed while detached/disconnected.
refetch only bibliographic detail, not the reader's whole `loadMediaPane` seed:
preserve locator, selection, transcript and playback while respecting the title
owner's reader-generation/offline invalidation. keep existing overlay facts
visible during refresh. preserve collection filters/drafts; discard stale page
cursors through the existing revision owner. unchanged success refreshes activity
without replacing collections. arbitrary batch work with only collections open
is observed on their next normal refresh, not by new per-row streams.

after each advanced successful stamp, the text reader checks its current
navigation generation through the existing reader owner, including when a
missed title change returns to the old spelling. the same generation needs only
that navigation read. a differing generation requires navigation/content/navigation
under one stable version and exact structure/content equality before retaining
mounted reader coordinates; changed content uses the existing composed reload.
never infer unchanged source from equal titles or lengths. pdf metadata changes
do not reopen its viewer. no metadata-owned generation mirror or api field.

all touched routes return typed response models; register the SSE model in
`wire_schema.py`, regenerate `wire.gen.ts`, and consume generated `ApiJson` /
`Schema` types. no hand decoder for owned json. hard-remove the metadata arm of
`POST /media/{id}/retry`, its old response boolean and client decoder. source
retry remains its existing independent contract; type that remaining route.

the existing detail projection also returns stored `provider`, `provider_id`,
`requested_url` and `canonical_url` as required `Presence<string>` fields.
retain `canonical_source_url`'s existing contract. inspect these facts in the
overlay's source group, without extra detail or collection-row reads.

## 6. epub contributor repair

parse epub2 `opf:role`, epub3 role refinements and `dc:contributor`, preserving
credit order and multiple roles for one entity. explicit roles override the
untyped-creator author default;
untyped contributors are `unknown`. map supported marc roles through the current
taxonomy; retain unsupported values as `unknown/raw_role`. combine multiple
unsupported labels in source order into one unknown credit's raw role; if its
80-character bound is exceeded, report an unrepresentable observation without
applying that entity's credits. a role exceeding 20 credits is likewise reported
and left unobserved, never published as a complete first twenty. remove
unconditional creator→author and semicolon splitting:
one opf element is one credited entity, potentially holding several roles.

repair saved epubs through the existing bounded `extract_epub_metadata`, never
reader reingestion. a metadata-only maintenance command offers preview/apply and
reports media id, moved/added credits, skipped reason and before/after counts.
reuse retained source retrieval, contributor identities and source fingerprints.

only change old `epub_opf` observations whose original source/name/identity can
be matched. compare the source and affected credit rows again under the media
lock at apply. preserve unrelated row identities, sources, later observations
and manual author protection. extend the contributor owner with a narrow
source-observation repair; whole-role replacement is unsafe for mixed sources.
ambiguous matches, including previously split semicolon names, stop that item's
repair and remain reported; never guess.
reader publications, sections, anchors, progress and index generations must be
unchanged, as must `metadata_enriched_at`: source repair is not model research.
explicit role evidence may correct a translator wrongly in authors. follow
[epub's creator/contributor role semantics](https://www.w3.org/TR/epub-33/#sec-opf-dccreator).

## 7. content ownership and quality

assign a content designer within **each** work package; author examples/copy
before implementation, then have another reviewer challenge them.

| feature / designer | definition of good content |
|---|---|
| research / bibliographic editor | prompt distinguishes book, collection, essay and edition; canonical credited names rather than forced full names; neutral 1–3 sentence description of the actual item; no sales copy, invented precision or identifiers; examples include a later collection containing an earlier essay and a reprint of a book |
| contributors / source-data editor | explicit opf role mapping examples, named ambiguity cases, and concise repair report; no person inferred from a guessed name expansion; no unsupported role relabeled author |
| operations / reliability content designer | state names distinguish model execution from publication; safe errors say what failed and whether retry is available; no false success, blame, traceback or invitations to bypass uncertainty |
| interface / product content designer | keep reading status separate; label original date “first published”; use status copy below; describe actual changes, not enqueue as completion |

the publication description displays `Media.description`; retained podcast
notes remain in their listening/source view and never replace this bibliographic
field.

source content shows exact stored provider identity and only distinct meaningful
urls. show `provider: not recorded` when absent; omit an absent provider id.
retain the existing `source url`, then distinct `requested url` and `canonical
url`. identical requested/canonical strings distinct from the source url share
the label `requested and canonical url`. compare exact strings only; never
reconstruct or normalize identifiers, and do not display several unknown urls.

approved baseline copy: `queued`, `researching metadata`, `waiting to retry`,
`no metadata found`, `metadata research failed`, and
`execution unresolved; retry unavailable`.
completed with changes: `updated: {field labels}`; without: `no changes`.
if original date is unresolved: `first publication remains unknown` when stored
absent; otherwise `first publication unverified; kept {date}`.
withheld authors: `kept manually set authors`.
stream failure: `live status disconnected` with reconnect, independent of job
failure. a failed detail reread says `metadata updated; couldn't load current
values`; its retry rereads, never re-enriches. stale input says
`research result was not applied`.
no fabricated percentages. include latest operation time/id and admitted
model selection in existing metadata activity details; no new diagnostics page.
preserve focus/scroll, use one polite outcome announcement, and verify long
values at 360px and enlarged text. one compact research group uses existing
dialog typography; no new dashboard or decorative status vocabulary.

## 8. non-overlapping implementation packages

owners may prepare concurrently; shared files have one editor as assigned below.
all python paths start `python/nexus/`; web paths start `apps/web/src/`.

| package | sole edit ownership / dependencies |
|---|---|
| a. domain + research | `services/metadata_enrichment.py`, new `schemas/metadata_enrichment.py`, metadata policy in `services/generation_policy.py`, sample setting in `config.py` and repository `.env.example`; owns generated schema, acceptance, bounded context and pure merge planning; consumes b's contributor/isbn contracts |
| b. contributors + epub | `services/contributors.py`, `services/contributor_writes.py`, `services/contributor_taxonomy.py`, `services/epub_ingest.py`, `services/epub_lifecycle.py`, new `schemas/isbn.py` and `python/scripts/repair_epub_contributors.py` (repository-relative); owns identity binding, role parsing and saved repair |
| c. job + api | `tasks/enrich_metadata.py`, `services/metadata_dispatch.py`, new `services/metadata_operations.py`, `jobs/{queue,registry,worker,process_executor}.py`, `tasks/prune_background_jobs.py`, `api/routes/{media,media_ingest,resource_items,stream}.py`, `services/{media,media_processing_state,media_source_ingest,capabilities}.py`, `services/podcasts/ingest.py`, `services/resource_items/action_snapshots.py`, `schemas/{media,resource_action_snapshots,client_mutation}.py`, `db/models.py`, `wire_schema.py`, notification/cutover migration; consumes a/b, owns atomic orchestration, replay and operation projection |
| d. interface | `lib/media/ingestionClient.ts`, new `lib/media/mediaMetadataOperations.ts`, `lib/actions/resourceActions.ts`, `lib/actions/resourceActionMenu.tsx`, `lib/actions/resourceActionRuntime.tsx`, `components/media/MediaInfoOverlay.tsx` and its css, existing pane/collection refresh owners, generated wire; consumes c; no backend mutation logic |
| e. integration / release | temporary live checks, existing release workflow, module docs `media-metadata.md`, `epub.md`, `jobs.md`, relevant tickets; no competing runtime edits |

c composes accepted domain data from a with contributor writes from b in one
transaction; a does not invent another contributor resolver. d renders c's
projection without rebuilding admission policy. e verifies the composed result.
existing web refresh owners are `app/(authenticated)/media/[id]/MediaPaneBody.tsx`,
`libraries/[id]/LibraryPaneBody.tsx`, `authors/[handle]/AuthorPaneBody.tsx`,
`search/SearchPaneBody.tsx` under the same authenticated root, and
`lib/lectern/LecternProvider.tsx`. a owns all new metadata schema declarations;
c specifies its api/outcome types before a writes that shared schema file.
the kernel agent alone owns shared libraries, adapter/dispatch and dependency
pins; give it the capability/live acceptance contract in section 2.

## 9. hard cutover and verification

artifact readiness and historical release readiness are separate. kernel
integration owns the original-evidence verdict and coordination. the nexus
reset/ledger owner owns the finite archival disposition and `0246` integration;
the release owner owns drain, verified backup and separately authorized aligned
deployment. metadata/media owns publication and retained metadata-job disposition.
the kernel's `docs/issues/historical-uncertainty-release.md` records requirements,
not executed receipts. metadata root owns application reset/ledger and release
preparation in `feature/metadata-enrichment`; kernel's 2026-10-03 ownership
handoff is `686b7ce4c43637e6f503db6f437c30450e4b4006`. no kernel/native writer
overlaps these paths. production disposition and aligned deployment remain
separate final actions after the concrete owner proofs and review.

release preparation uses one strict `ReviewedModelCutover` input and the
existing aligned deployment controller; see
[the finite operator sequence](../deployment.md#reviewed-model-history-reset).
the original `0252` → `0254` → `0255` receipts remain historical. current main
already owns resource `0253` and atlas `0254`; the final canonical chain is
`0252→resource 0253→atlas 0254→native 0255→metadata 0256→effects 0257`.
kernel owns native renumbering/current-main composition; metadata owns its two
renumbered migrations and the complete restored-copy qualification. `0257` adds
independent completed-write receipts and archival audit storage. the unreleased
`0246` reset preserves receipts before deleting execution history. all runtime
inspection and undo use that single receipt contract, including chat writes.
unfinished writes or missing original principals block migration. a reviewed
orphan parent acknowledgement grants no recovery, completion or write authority.

trade-offs: receipt storage duplicates the completed facts needed after reset;
it adds no second execution lifecycle. the restore attestation is an explicit
reviewer statement, not proof inferred from its hash. a preliminary live archive
proves the local repair; production still requires a fresh drained backup and
actual restore of those exact bytes. release now uses the existing locked
backend environment rather than a second schema validator in system python.

1. inventory current metadata jobs/memos, unresolved generations, legacy metadata
   errors and manual-author pins. freeze metadata admission and quiesce writers
   through the existing release workflow. drain or explicitly settle old work
   under the old contract. classify only original authoritative evidence;
   otherwise the reset/ledger and metadata owners need a reviewed exact-id
   archival abandonment under the approved reset. preserve original uncertainty,
   null terminals, effects and history; revoke old grants and fence stale replay.
   historical counts are neither a fresh census nor additive totals.
2. archive exact settled legacy metadata job records in the release backup and
   retire them from the live projection before replacing the memo schema. verify
   references before deleting rows; preserve media facts and generation evidence.
   the metadata cutover does not delete generation history. if the actual starting
   revision crosses `0246`, preserve its discarded originals in the verified
   pre-disposition archive. preserve completed-write identity, original principal,
   result, created refs and reverted state in independent effect receipts before
   deleting execution history.
   copied authorship and the `0252` → `0254` → `0255` fixture do not prove
   `0241` → `0246` undo. actually restore the backup, then prove disposition,
   the entire chain from the actual starting revision, real effect/undo and
   stale-replay refusal on that copy.
   do not fabricate modern changed/unresolved lists for old runs. the retained
   `metadata_enriched_at` still records prior accepted research. unresolved jobs
   cannot be deleted merely to make cutover pass.
3. deploy the new api, worker and web together. remove old authors-only output,
   nullable date overwrite, boolean enqueue response, metadata source-error
   projection and stale tool-authority docs. no dual parser, route alias, schema
   fallback or parallel metadata path. apply guarded saved-epub repair; inspect
   skipped items. rollback incompatible durable schemas using the verified
   release backup, not an older binary against new memos.
   the existing aligned entrypoint must forward the exact reviewed snapshot
   to its controller. release remains blocked until the application disposition,
   restore/effect/undo proofs and separate release authorization exist.
   compose the canonical chain above after qualified adapter integration.
   rename/reparent undeployed native/metadata/effect migrations, retaining their
   behavior. rebuild disposable databases under the actual final graph; never
   stamp or alias old revision numbers into this chain. preserve historical
   receipts and original uncertain databases under their actual revisions.
   prove historical effect/principal preservation and whole-chain rollback when
   native's guard passes but metadata's later guard rejects unresolved work.
   verify installed adapter/pins and provider-sealed local recovery. its
   executable `CodexCallbacks` authority uses the frozen `MetadataResearch` tool
   plan; the current shell grant does not qualify it. no dual head or old grant.
4. start new enrichment for the selected book/collection/essay samples, including
   affected lewis items after uncertainty settlement. inspect actual persisted
   dates, admitted model, tool execution and open-view refresh. unresolved work
   stays in its existing ticket; a failed kernel prerequisite is blocked evidence,
   not metadata acceptance.

for implementation, the owner's explicit temporary-test instruction overrides
the repository's usual static-only verification policy **for this work only**:
write disposable end-to-end integration/live tests first; observe RED at the
intended boundary; implement; observe GREEN; refactor; observe GREEN again;
delete the tests, fixtures, dependencies and test-only seams. `./scripts/test`
remains the sole permanent automated gate. do not rebuild a permanent harness.

use the real api, database, queue, worker and browser. controlled responses at
the external provider boundary may exercise deterministic failures; they do not
substitute for actual codex research. use an isolated corpus; production checks
are controlled reruns, never synthetic fault injection. retain a short receipt
of commands, revisions, operation ids, observed outcomes and limitations.

| acceptance slice | required proof |
|---|---|
| bibliography | actual book/collection/essay research chooses the specified first publication; uses exact luna/xhigh and working search/read; preserves date precision |
| nulls + partial + unchanged | null dates preserve old values; partial changes are atomic; unchanged non-null result succeeds; unresolved-date copy matches stored facts |
| no findings + invalid output | all-null and malformed results never stamp success; queue settles terminal unsuccessful; no second model call; provider terminal truth retained |
| replay + concurrency | lost enqueue response yields same job; concurrent distinct requests and a scheduled retry cannot admit a second manual job; crash after publication reuses the outcome without restamping |
| execution fences | stale source/credits, lost claim and revoked access cannot publish; uncertainty blocks fresh research; pre-admission catalog failure is visible without a generation id |
| required tools | known missing search credentials fail as configuration errors before model submission; no generation id or stamp; configured research works; original-seal recovery bypasses current tool unavailability |
| native recovery | sealed terminal recovers from frozen input with zero catalog/provider calls after source/credits/access or current-tool-definition change; original terminal/usage retained; publication rejects stale/revoked facts; without either seal or authoritative non-submission proof, remains uncertain; exact non-submission proof settles failed locally |
| context | a large unicode credit list cannot exceed the encoded input budget or silently lose identities; malformed handles/isbn/roles fail before publication |
| contributors + epub | stable person across credited-name changes; role-refined creator/contributor parsing; explicit empty author slice clears; historical repair preserves unrelated credits and reader state; ambiguous repair is reported |
| observation + retention | open pane/overlay sees new automatic and manual jobs, completion and safe failures; reconnect/reopen agrees; ordinary pruning cannot reveal an older failure as latest; stream sharing avoids per-row listeners |
| authorization + cutover | noncreator cannot enqueue; revoked reader sees no stream data; old metadata route/schema is rejected; no live legacy memo reaches the new decoder |

at each step, a reviewer other than the implementer names a counterexample and
checks the invariant that defeats it: schema → ambiguity; admission → replay;
publication → crash/stale input; ui → missed notification; cutover → old memo.
fix any surviving counterexample at its owner before advancing. after final
GREEN and static checks, delete the temporary tests, run `./scripts/test`, update
module docs, delete only resolved tickets, and stop.

## 10. explicit trade-offs

- a single model judgment keeps the system small; output validation cannot prove
  historical truth. existing generation/tool records provide inspection.
- null preservation protects known data but can retain an incorrect value when
  no replacement is found. automatic scalar retraction is outside this contract.
- 1,000 opening words and bounded context are a starting allocation; later local
  reads handle missing front matter. oversized fixed context fails visibly.
- xhigh costs latency on the serial worker; the finite live cohort took about
  69/83/71 model-turn seconds on the final current-source cohort. this does not
  establish a universal latency bound;
  there is no new concurrency system.
- the native route retains 64,000/8,000 admission/reservation budgets without
  hard token ceilings. the user accepted that limit; no local limiter is added.
  aggregate usage across research steps does not measure peak context or prove caps.
- native execution retires shell quota parking. known pre-submission failures
  use bounded queue retries; terminal native quota failures fail the job and
  allow a fresh manual request. no new quota scheduler is introduced.
- required-tool admission checks known local configuration. configured remote
  dependencies can still fail after submission and leave uncertainty. finite
  dependency qualification before live acceptance is not a product readiness
  network probe; none is added.
- indefinite metadata-job retention costs storage and retains research context;
  it avoids another outcome ledger and expiring replay semantics for one user.
- visible details consume shared stream listeners; closed views reconcile on
  reopen. there is no live subscription for every collection row.
- text readers perform one small navigation read per successful metadata stamp;
  a differing publication requires bounded content verification. this preserves
  reading state across missed title publications without another stored protocol.
- guarded epub repair leaves ambiguous items for explicit live repair. removing
  semicolon splitting preserves source entities but stops guessing that a
  malformed composite name denotes several people.
- deleting temporary tests sacrifices future regression automation; receipts and the
  permanent static gate do not replace that coverage.
- rss bibliography observations retain one source-owned fingerprint. changed
  observations enqueue fresh work; identical replay preserves researched values.
  an old episode's first actual feed observation initializes the unknown fingerprint
  and may enqueue once. another alias of the same resolved episode updates only
  diagnostic identity; if it changes during research, strict input fencing can
  require a deliberate rerun without automatically buying another generation.
