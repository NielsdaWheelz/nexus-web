# librarian and curated browse

status: implementation specification, 2026-11-11. documentation only; no code,
migration, provider run or runtime qualification has been authorized by this file.
the owner requested this combined specification/plan. implementation requires a
separate instruction. current owners: [chat](modules/chat.md),
[suggestions](modules/suggestions.md), [references](modules/resource-references.md),
[verification](local-rules/testing-standards.md).

## outcome and scope

- one account-owned librarian conversation at `/librarian`, reachable everywhere;
  one navigation entry, no selectable
  conversations or branches. all sends append, including questions about old messages.
- browse opens onto a finite curated feed. contextual suggestions and daily share
  editorial judgment with different eligibility. quick reads retains its immediate
  time/progress selection through the existing shared primitives.
- curation uses existing available resources and feed entries only. existing
  explicit browse/search remains; no new ingestion connector.
- one optional, manually edited reading brief in account settings. no automatic
  orientation, inferred profile, brief-writing tool or memory tree.
- chat stores messages and live source references. source edits and disappearance
  are accepted; exact historical source reconstruction is not a requirement.
- retain existing reading, saving, playback, source acquisition, authored writing,
  generation, jobs, cancellation, receipts and resource visibility owners.
  connection discovery retains relationship ownership; curation consumes graph
  evidence without turning its own recommendations into durable links.

non-goals: engagement optimization, infinite scroll recommendations, notification
campaigns, a new agent runtime, active-turn steering, successful-answer regeneration,
sent-prompt editing, generalized migration/import machinery, new upload features,
automatic library additions or graph links merely because something was recommended.
deferred: [orientation](issues/librarian-orientation.md) and
[external discovery](issues/librarian-external-discovery.md).

## product and content contract

| feature | required behavior and content | reuse |
| --- | --- | --- |
| browse | at most 20 picks; canonical title, author/source, time and ordinary actions; one optional supported rationale. search temporarily replaces the feed; clearing restores its visit state. | `BrowsePaneBody`, `CollectionView`, `presentSuggestionItem`, `ResourceRow`, `useSuggestions` |
| contextual selection | lectern/library suggestions display ten with a twenty-item curated pool; daily displays at most five. current visit order survives new publications; empty is valid. quick reads remains a direct, model-independent list of at most five. | existing sections, eligibility, publication/view protocol and pane mementos |
| librarian | one transcript, model picker, always-available send, per-turn cancel, visible `queued` state. `ask librarian` with a question sends; without one it opens the same librarian with a live reference and focused empty composer, never invented user text. palette cmd+enter sends there. opening old messages never changes the append destination. | `ChatSurface`, composer, markdown/answer/footer, `runTail`, draft/receipt owners |
| references | explicit attachments and published citations have live read-only figures. a closed-by-default companion aligns them to their referring messages; margin/all, source-follow/back and reading place retain their owners. unavailable numbered citations remain identifiable; invalid locators retain source navigation. | `LibrarianReferences`, `ReferenceFigure`, shared margin and source authority; [chat](modules/chat.md) |
| reading brief | one multiline settings field, explicit save; `Edit reading brief…` in the `Librarian` pane overflow opens and focuses it. no composer control. blank clears it. help: `what you want to learn, pursue, or avoid. the librarian uses this when answering and choosing reading.` | account settings form, draft/feedback owner, `/me`; workspace entry contract |

the content designer owns examples and editorial acceptance for each row above.
reuse existing typography, spacing, actions and accessible names; no new card system.
app-authored copy is lowercase; source titles and quotations retain their original case.

`rationale` is nullable plain text, one sentence, at most 240 characters. good:
`a primary account of the dispute you’re studying.` both claims require supplied
or inspected evidence. bad: `an insightful must-read perfectly tailored to you.`
metadata-only evidence permits topic relevance, not claims about unread arguments.
model output cannot replace titles, urls, dates, duration, artwork or capabilities.
do not fill quotas, invent popularity, expose internal scoring, or add endorser chips.
empty browse: `no picks right now.` suspended updates retain prior rows and say
`selection stopped updating.` use existing read/retry and source-coverage states.

good brief: `i’m studying how institutions survive succession. prefer primary
sources and serious disagreement. less startup commentary.` no seeded biography
or hardcoded personal instructions. explicit requests govern the current turn;
only a manual brief save changes standing instructions.
brief limit: 8,000 unicode codepoints, enforced by the server; whitespace-only
becomes null, otherwise preserve the text. oversize input retains its draft and
reports validation failure; never truncate instructions. deletion is labelled
`delete turn` and explains that the question and answer disappear while completed
actions remain.

## composition and capability contract

```text
manual brief + committed intent + existing resources/feed entries
  -> selection eligibility and bounded retrieval
  -> librarian editorial generation
  -> validated, atomically published selection
  -> browse / contextual suggestions / daily
existing time/progress selection -> immediate quick reads

selection / palette / composer -> durable account fifo -> existing chat worker
  -> brief + earlier settled turns + current request + live references
  -> existing generation/tools -> persisted answer and operational receipts
```

| caller | reads | writes |
| --- | --- | --- |
| foreground librarian | account-authorized resource/search readers, message history within the run horizon, current brief; existing explicitly configured web/shared-memory capabilities | only existing explicitly requested additive actions through current tool/undo owners; no brief write |
| editorial job | bounded candidates and intent resources through a `SelectionRead` plan; enforce current visibility on every read | selection publication only; no web discovery, shared-memory grant, authored write, save, subscribe or graph mutation |
| settings | current account brief and version | absolute version-checked brief update |

attachments focus a question; they grant no access. remove conversation membership
as the foreground search boundary and automatic membership writes after retrieval.
do not broaden other background jobs. retrieved text and prior assistant answers
are data, never standing instructions. keep `assistant` versus `discovery`
operational provenance beneath the shared librarian name.
existing optional jarvis saves keep their tool-call uuid as `submission_id`.
send the authenticated account uuid as the stable, caller-reported
`native_conversation_id` for its sole timeline; never use the changing run id or
fabricate a native capture lane. jarvis's existing nexus submission accepts this
opaque association; note identity is owner plus submission id (adr 0067).
include the adapter in the cut and qualify exact retry; no new memory grant.

## data and api

all contracts use existing typed-wire rules: snake_case, explicit nulls, generated
web types, current authorization, and one coordinated wire revision bump when due.
sequence/version values use the existing decimal-string int64 wire type.

| owner | final storage |
| --- | --- |
| `users` | add nullable `reading_brief text` and `reading_brief_version bigint` |
| `librarian_state` | rename/extend the existing `chat_deletion_revisions` row: `user_id` primary key, `next_seq bigint`, `deletion_revision bigint`. this permanent per-account admission/deletion row is not a selectable conversation |
| `messages` | retain id, role, literal content, status and timestamps; replace conversation ownership with `owner_user_id`; account-unique `seq`; add ordered `attachments: LiveReference[]`; remove parent/branch/fork and selection-snapshot fields |
| `chat_runs` | retain pair ids, generation selection/spec, job/event/cancel/receipt ownership; status is `queued`, `running`, `complete`, `error` or `cancelled`; add nullable weak `retry_of_run_id`; remove conversation/context-version/frozen-prompt fields |
| `llm_calls` | nullable `native_execution: {profile_key, thread_handle, settled}`; bind a fresh native identity before submission and require confirmed finality before closure; retain no prompt or provider history |
| retrievals/citations | existing `message_retrievals` owns answer/tool identity, retrieval ordinal, nullable citation ordinal and live target; replace duplicated captured/result payloads with that target. local citation edges are projections, not a second evidence owner |
| `suggestion_feeds` | add only `browse` to existing `suggestions` / `daily` modes; retain one account/mode/destination owner and current job pointer; add nullable `last_admitted_at` for the automatic build floor |
| `suggestion_shortlists` | replace `target_refs` with ordered `items: [{ref, rationale}]`; retain revision/time and daily edition metadata; latest successful publication only |

`LiveReference = {resource_ref, field, locator}`. `field` is existing nullable
resource-field selection. `locator` is null or an existing structural target:
web/epub/transcript fragment plus codepoint offsets, pdf page/quads, time range,
or note/message codepoint offsets. note/message identity comes from `resource_ref`.
extract shared coordinate-only primitives where needed; do not duplicate a second
reader-target grammar. no quote text, prefix/suffix, content hash, body version,
recorded title or implicit passage-anchor creation. existing highlights remain
references to actual highlight resources. invalid current ranges are unavailable;
there is no nearest-text repair. syntactically invalid targets are rejected.

retrieval/citation targets are the closed union
`{kind: resource, reference: LiveReference}` / `{kind: url, url: http(s)}`.
one message-owned citation-ordinal sequence spans both. project local-resource
citation edges only, with no copied evidence; web citations open their url and
display url/domain without saved title/snippet or a claim of current availability.
do not create external snapshot resources for chat. native/oracle source-owned
snapshots remain with their existing owners.
amend the shared ordinal-edge rule specifically for message sources: their local
citations have no snapshot. delete chat snapshot/conversation arms in
`reader_publication.py`, `x_source.py` and `resource_items/evidence.py`; preserve
native/oracle captured-evidence behavior. convert old chat external targets to
url targets during migration; remove only genuinely orphaned external snapshots.

| endpoint | final contract |
| --- | --- |
| `GET /librarian/messages` | bounded turn windows: mutually exclusive `before_seq`, `after_seq`, `around_message_id`; omitted means latest. `limit` defaults to 25 turns, maximum 50. returns chronological pairs, current execution/capabilities and nullable before/after cursors. an unavailable anchor is 404, never silently latest. |
| `POST /librarian/attachments/resolve` | strict 1–16 live references; ordered current rich presentations in one authenticated repeatable-read snapshot, private/no-store; no writes. |
| `POST /chat-runs` | existing uuid `Idempotency-Key`; `{content, selection, attachments, expected_deletion_revision}`. at most 16 attachments; existing message/input bounds. accepted receipt carries the current turn, read after admission commits; no conversation/destination fields. |
| `GET /chat-runs/{id}` and existing events stream | retain ordinary pair/status/stream recovery; remove conversation/tree payloads. |
| `POST /chat-runs/{id}/retry` | fresh uuid key; `{selection, expected_deletion_revision}`. only owned failed/cancelled runs accepted; append a new pair with original question/references and `retry_of_run_id`. |
| existing `POST /chat-runs/{id}/cancel` | idempotent stop intent; supports waiting and active turns. |
| `DELETE /chat-runs/{id}` | delete one terminal turn pair, never a subtree or later retries; absent is success. nonterminal conflicts until cancellation settles. preserve independent action/undo receipts. |
| `GET/PATCH /me` | output brief and version. writing the brief requires `reading_brief` and `expected_reading_brief_version` together; null clears. an already-equal value is a no-op; otherwise stale version is conflict, retaining the draft. no new settings endpoint. |
| selection endpoints | retain existing GET, POST `/view`, POST `/refresh`; add the same protocol only at `/browse/selection`. retain direct `GET /lectern/quick-reads`, with no publication/job or new endpoints; its rationale is null. |

timeline response is `Data[TimelineOut]`, with
`TimelineOut = {items, before_seq, after_seq}`. each item contains
`run_id`, `user_message`, `assistant_message`, nullable `retry_of_run_id`,
`execution`, `can_cancel`, `can_retry`, `can_delete`, reusing existing message/run
projections. before/after cursors are exclusive; windows contain whole pairs.

`GET` selection returns existing state plus nullable publication with hydrated
`{target, rationale}` rows. `/view` accepts retained refs and returns only current
targets/capabilities, preserving requested order; it never supplies replacement
rationales. the visit owns its adopted rationale and order. `/refresh` admits or
joins ordinary due work and returns 202 state; it never waits for a model. explicit
pane refresh reads/adopts the latest completed publication with existing feedback.
no raw model response reaches the client before schema and membership validation.
absent publication is null; the mounted observer separately requests refresh
according to state. a read alone must not leave first selection permanently idle.
retain strong account/pair ownership foreign keys. live source targets and retry
links are weak: deletion makes them unavailable without deleting citation ordinals.
tool receipts survive turn deletion with their message association cleared.

## timeline, queue and source lifetime

admission locks the account and commits two consecutive message positions, run
and queue position together. waiting turns live in `chat_runs`; only the earliest
nonterminal run receives an executable unique `chat_run` job. enqueue it in that
same admission transaction when it is the head. queued work survives reload/process
exit; no new queue/table, held-job reinterpretation, poller or provider session.

the sole terminal owner recomputes the earliest nonterminal run and admits its
missing unique job atomically with settlement. cancelling a middle waiting turn
cannot release its successor. execution projection reports waiting rows as `queued`
without requiring a job; the head retains existing job-state projection. lock
order is generation (when required), account, run, job, matching current recovery.
here `account` means `librarian_state FOR UPDATE`, never the frequently updated
`users`/consumption row. reuse the dedicated fence; avoid broad account-write
contention. bootstrap the state row through the existing account owner.
cancelled queued turns retain their question and cancelled answer state. a dead
active worker follows existing interruption/finality recovery before another turn
starts; a timeout is not evidence that provider execution ended.
unknown native finality retains the existing job. a bound thread without an observed
turn cannot prove that its previous writer will never submit; bounded native
reconciliation uses exact terminal or container-retirement proof before settlement.
exhausted recovery holds for the owner-scoped repair command in the
[generation contract](modules/llms.md).
settlement folds committed text frames into terminal partial content and preserves known ledger
failure/correlation, using existing unpublished-citation cleanup. never rerun the
model to reconstruct lost output. durable automatic continuation remains deferred.

run-start context includes the current brief, bounded earlier settled turns,
current question and freshly resolved attachments; exclude later queued questions.
older history is searchable through existing resource search. preserve current
input/output limits and transport recovery. no automatic historical synopsis.
brief edits affect subsequent turns; they do not rewrite an answer already running.
`settled` means terminal: complete, failed or cancelled. label incomplete answers
explicitly and retain completed-action receipts; omitting a failed turn must not
hide actions that already happened. mark retries as new attempts rather than
independent interest votes. explicit attachments and mandatory question/brief
that cannot fit produce the existing terminal `context_too_large` outcome, retain
the question and release the queue; do not silently truncate mandatory input.
enforce the same message horizon in every tool search/read/inspection and message
attachment: current question plus earlier terminal turns only. whole-account
access must not expose later queued messages through tools. ordinary user timeline
reads can show the queue; this is a run capability, not a new conversation scope.

retry is a new appended attempt using current brief/resources and surviving
completed-action receipts. retain the original partial answer. it neither rolls
back actions nor promises identical historical input. duplicate transport delivery
of the same run uuid acknowledges that run; it never generates twice. after a turn
is deleted, the retained account deletion fence rejects a stale absent-run resend,
preventing resurrection. retry admission and deletion share the account lock.

source text exists transiently in model/tool input. remove chat-owned persisted
copies from reader snapshots, frozen run prompts, retrieval evidence, read-tool
arguments/results, external chat snapshots and chat citation snapshots. persist
only tool identity/status/error, target refs, created-effect refs and undo state;
intentional authored output belongs to its canonical resource. retain actual user
and assistant message text and reference coordinates. source owners may still retain their own documents,
highlights and native citation evidence. preserve native/oracle evidence contracts
while removing the chat-specific branches named above.
old answers may discuss words their live links no longer contain: accepted.

## editorial selection

reuse `suggestions.py`, `selection_context.py`, `daily_selection.py` and
`suggestion_shortlists.py`; there is one candidate/eligibility owner and one
publication job, with a new editorial operation between retrieval and publication.

| mode | eligibility and limits |
| --- | --- |
| browse | existing available unfinished individual media, held or unheld, including older work and feed arrivals; no new source acquisition. retrieve at most 80; publish at most 20. |
| suggestions | existing destination rules, including source suggestions where already supported; retrieve at most 80, publish at most 20, display ten and refill from that retained pool. |
| quick reads | existing complete, unfinished readable-document predicate and remaining duration under ten minutes; direct selection of at most five, no editorial call or publication. |
| daily | existing held/acquired/publication-evidenced account-morning window and source caps; at most five, first successful edition fixed. old archive material is not daily news. |

replace latest-message-per-conversation extraction with bounded recent committed
user messages and live reference anchors; exclude retry duplicates, assistant
outputs and automatic arrivals as intent votes. retain existing reading, listening,
note, highlight and individual-save inputs. no brief means no invented biography.

job phases: (1) existing repeatable-read bounded candidate/context capture;
(2) retire search/transaction; (3) existing generation service with new operation
`selection_curation`, owner
`suggestion_feed`; (4) validate strict `{items:[{ref,rationale}]}`; (5) short fenced
publish transaction. never hold a database transaction during generation.
every selected ref must be a distinct offered candidate, never merely a context
ref. validate surface caps and current eligibility. malformed/out-of-pool output
fails the attempt atomically. legitimate zero picks is successful empty.

add one developer-owned generation policy on the existing codex personal route:
`gpt-6.1-sol`, medium reasoning, strict json, 180-second deadline, 256 kib input,
existing enforced native/tool bounds. `selection_curation`, owner kind
`suggestion_feed` and plan `SelectionRead` are new variants in existing owners.
the plan contains exactly `nexus.resource.inspect`, `nexus.resource.read` and
`nexus.document.search`, confined to candidate/context refs. no alternate model or deterministic
fallback. compose editorial rules, manual brief, surface constraints, bounded
committed intent and existing resource projections. allow bounded current resource
inspection through existing tools. select for substance, deliberate relevance,
intellectual stretch and variety; evidence limits the specificity of claims.

brief save advances selection input revision. publication must still own its job,
account/destination authority and captured brief version; superseded brief output
does not publish. finish/clear that job through its owner and leave current inputs
due for normal admission. ordinary input changes may leave a complete older pool
visible; they cannot extend access. failed work preserves the last success.
inside the fenced publication transaction, recheck selected-target eligibility;
drop newly ineligible rows without substitution, preserving survivor order and
rationales. zero survivors is successful empty; malformed output is failure.

non-daily automatic builds: first publication immediately; thereafter due for
meaningful input changes or a new account-local civil day, with a 15-minute minimum
between new automatic admissions, measured by `last_admitted_at` set atomically
with job creation. retries of that same job retain existing queue policy. failed
or superseded initial work does not bypass the admission floor; an explicit repair
retries the existing failed job. visible observers use the existing refresh owner; no new poller.
daily retains its existing 07:00 scheduler. routine background publication is quiet
and never replaces an adopted visit. prior results may remain through contention;
no freshness guarantee or archive of editions.
remove the old 15-minute age-trigger and 30-second dirty-build floor. reading
progress counts only when existing committed-intent rules move an anchor/read
state. active reading can therefore cause up to one new model build per visible
non-daily feed per 15 minutes. without a provider, a first editorial publication
is unavailable; an existing publication remains visible. there is no mechanical
substitute masquerading as librarian judgment.

## cutover and removal

one migration after the actual sole head; one coordinated server/client release.
production preflight found three accounts, eight chats, fourteen paired turns and
one branch. the owner approved preserving every account separately and flattening
branches chronologically with original-parent references. the verified backup also
contains four authored links and four source stubs for already-deleted chats; the
owner approved removing those exact dangling records and their derived projections,
while preserving immutable accepted commands. all other unmappable references fail. preflight pair ownership
and supported references against the newest backup; no generic importer.

1. apply the [release preconditions](issues/release-librarian.md); settle work and
   freeze writers. no device with uncommitted input or pending commands is reset.
2. assert owned message pairs, acyclic parent relations, supported locations and no linked
   empty conversations. unsupported data fails before mutation and gets explicit
   targeted repair; no silent dropping or compatibility reader.
3. preserve message ids, literal text, dates, runs and action receipts. order turns
   by user-message admission time, old conversation id, old sequence and run id;
   keep each pair together. convert old parent reply relations into message
   references and quote targets into live coordinates, then drop the old fields
   and copies. never rewrite old answer literals to repair citations.
4. replace authored conversation links with links to that discussion’s first user
   message as a navigation anchor, not evidence that its first turn used the
   resources. retire automatic context-only membership. message locators retain
   message ids and lose conversation ids. also convert canonical typed embeds in
   authored bodies and their projections; reject collisions/unmappable references.
   preserve submitted change bytes, accepted source prefixes and replica identities.
   following migration `0339`, lock account heads, fence old feed grammar with
   `snapshot_floor_seq=head_seq`, and advance only admitted replica formats.
   add a targeted empty-outbox device upgrade that preserves source/causal counters,
   marks provisioning incomplete and invalidates derived scope state; reuse existing
   verified snapshot provisioning. writing resumes only after complete publication.
   this reset transition is new work: cursor rejection does not currently trigger it.
5. discard derived suggestion publications and settle their old job pointers;
   the current daily edition can be built anew. preserve resources, sources,
   progress, saves and reading state. drop conversations and old contracts only
   after all dependent data is rehomed.

delete conversation create/index/tree/title/branch/regenerate/destination APIs and
web routes; no redirects or aliases. replace stored workspace conversation visits
with `/librarian?message=<id>` (empty unlinked visits become `/librarian`). remove
chat index/destination overlays, `findDestination`, `Forks`, tree derivations,
conversation context membership and snapshot-only quote/revision machinery.
retain shared upload, citation, reader, draft, feedback and action owners with
remaining callers. enumerate all consumers before deletion; no dead exports,
wire variants, error codes, glyphs or comments describing removed capabilities.
remove hardcoded personal biography/goals from the chat prompt; keep application
instructions. the optional brief supplies user direction, never additional authority.

## implementation boundaries

each package has one implementer and one separate adversarial reviewer. no shared
file has parallel writers. the integration owner alone edits the shared schema,
wire registry, resource capability registry and final migration.

| package | exclusive responsibility / principal files | depends on |
| --- | --- | --- |
| a: contracts and integration | `db/models.py`, final alembic migration, `api/edge.py`, generated wire integration, `node/authored/src/types.ts`, web authored persistence/sync, android `AuthoredStore.kt`, shared resource/search/edge rules, `tools/{contract,run,reads}.py`, reader publication/x-source/evidence chat arms, workspace data migration | schema decisions first; final migration after b–d agree |
| b: librarian backend | `services/chat/*`, `schemas/conversation.py` replaced by `schemas/chat.py`, `api/routes/chat.py`; queue, timeline, live refs, citations, deletion/retry; `tools/memory.py` adapter. proposes shared-tool changes to a | a contracts |
| c: editorial backend and brief | selection/context/daily/shortlist owners; suggestion schemas; browse/consumption/daily/library routes; generation operation/policy; users/profile schemas and versioned brief save. supplies `SelectionRead` requirements to a | a contracts; b intent-ref contract |
| d: product and content | web chat/selection/palette/workspace routing, browse and shared suggestion sections, account brief field; content examples and states above; module docs/reauthoring updates | b/c api contracts |
| e: qualification and cleanup | disposable public-boundary drivers, newest-backup rehearsal, real-model content review, dead-code search and final rule review; release steps in `docs/issues/release-librarian.md` | b–d integrated |

within b, replace `conversations.py` with bounded timeline ownership and `quotes.py`
with live-reference ownership; retain the `chat` directory for conversation mechanics.
within c, preserve quick reads’ direct path; do not create a second editorial engine.
within d, keep canonical resource/row/editor primitives and existing browser/native
transport owners. feature designers review transcript/brief and feed content
against their schemas before wiring and again with real generated output.

## acceptance: red, green, refactor, remove disposable cases

write the following finite integration journeys before implementation. establish
failures at the real missing behavior; setup failure is not red. exercise real
api/database/worker/web boundaries, plus actual provider calls for editorial and
foreground tool behavior. no mocked internal modules, production test branches or
lab-only repair.

| id | acceptance |
| --- | --- |
| a1 | selection, palette and composer append to one timeline; selection without a question opens an attached draft without sending invented text; old-message links open bounded windows; no destination/branch/create/index controls or old routes remain. |
| a2 | queue two sends during an active turn, reload and open a second pane; fifo and exactly one active generation hold. cancel a middle waiter without releasing its successor; cancel/fail/interrupt the head and preserve committed partial text plus known failure. next head starts only after settlement. |
| a3 | lost admission response retries the same uuid without duplication; failed-turn retry appends and preserves old text/receipts; successful retry is rejected. `delete turn` names its pair/action scope; delete then replay its old send: no resurrection. |
| a4 | edit/delete a referenced source before execution and afterward; current content or unavailable is shown. invalid locators never guess. inspect storage to prove chat-owned source copies are absent while message literals survive. |
| a5 | librarian retrieves an unattached authorized resource and earlier message; excluded resources remain unavailable. later queued input never enters an earlier run. editorial tools cannot browse externally, write, or access shared memory. existing owner-only jarvis saves retain exact submission retry with the new stable timeline association. |
| a6 | brief save/clear, text bounds, equal retry and stale-version conflict are correct; draft survives failure. foreground answers and curation read it; neither can write it. an in-flight curation result using an obsolete brief cannot publish. |
| a7 | one small inspectable corpus proves each mode’s distinct eligibility, intent from multiple recent user messages, no recommendation echo, duration/news windows and source diversity. actual model output meets the designer’s evidence/rationale rubric. |
| a8 | duplicate/out-of-pool output fails without replacing last success; legitimate empty succeeds; access loss during generation cannot publish an ineligible row. brief supersession and job repair leave new work admissible. |
| a9 | browse → reader → back, search → clear, background publication and explicit refresh preserve the correct order/rationales/scroll. quick reads works without a provider; its exhaustion and contextual refill obey finite caps. |
| a10 | newest-backup migration preserves literal messages, ids, pairs, receipts, authored links/embeds and locators. nonempty-outbox upgrade refuses without mutation; interrupted snapshot exposes no partial corpus; next writes retain source sequence. old cursors/formats and unsupported shapes reject. daily rebuild and first new selection work. |

after each boundary: reviewer attacks authority, ordering, failure and content
claims; implementer resolves findings before proceeding. after green: remove dead
paths, consolidate only demonstrated repetition, rerun affected journeys and
`./scripts/test`. distinguish local/fake composition, live model behavior and
production/device observations. then delete feature-specific cases/fixtures and
temporary outputs; retain existing runtime/helpers and the three mandated search
checks. record proof in the implementation pr, unresolved findings in individual
issue files. run no unrelated capacity campaign or permanent regression suite.

## accepted trade-offs

- existing corpus only tests curation, not new-source discovery; no orientation
  means retrieval can miss forgotten subjects.
- live references sacrifice historical reconstruction; settings-only brief
  sacrifices offline document editing.
- fifo trades steering immediacy for simple ordering. failure retry is a fresh
  attempt, not rollback; old actions may already have completed.
- bounded retrieval can miss good candidates. twenty contextual picks reduce
  reserves from the old eighty-item ceiling; no quota is filled merely to refill.
- editorial work adds latency/provider use. the build floor, finite inputs and
  stable publications bound it. first browse/suggestions/daily publication needs a
  working provider; quick reads remains immediate and receives no editorial rationale.
- hard cut rejects unsupported historical shapes and requires a coordinated
  authored/client release. there is no dual path or old-client compatibility.
