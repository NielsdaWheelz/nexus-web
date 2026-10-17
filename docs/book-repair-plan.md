# retained-book repair plan

status: implementation merged in prs [#608](https://github.com/NielsdaWheelz/nexus-web/pull/608),
[#609](https://github.com/NielsdaWheelz/nexus-web/pull/609),
[#613](https://github.com/NielsdaWheelz/nexus-web/pull/613) and
[#619](https://github.com/NielsdaWheelz/nexus-web/pull/619); native correction
[#630](https://github.com/NielsdaWheelz/nexus-web/pull/630).
production now runs the pinned correction
`f4026846f857fd137e9c9e170faba05f07c5e282`, schema 0287 and wire 2.
backend/web health, verified backups and the required physical/provider checks
passed. live acceptance is complete with the explicit dispositions below. the
[release record](releases/2026-10-15-nexus.md) separates current and earlier proofs.
book repair does not hold normal service or unrelated merges. the blanket
release hold is lifted; ordinary review/check protections remain unchanged.
root owns production repairs and the next necessary code deployment.

execution order: reconcile active operations/fixtures → verified backup →
remaining approved production repairs → portrait real-worker rehearsal and
production recovery → required phone correction → final records/owned cleanup.
use the deployed tools for data repairs. batch demonstrated code fixes, then
qualify and deploy one exact commit. later main merges belong to a later release
and do not invalidate evidence for the unchanged pinned commit. no new admission
layers or repeated reviews without a concrete remaining risk.

current qualification and scope:

- reader: 465 fresh inspections plus 30 individually proved carries account
  for 495 surviving ids: 168 content-approved, 265 unchanged, 57 unsafe and
  five source-unproved. four later deletions complete the original 499.
  all 168 selected clone repairs (116 epubs, 52 articles), resource/fault/lock
  controls and positive controls are accepted. complete item proofs close the
  selected-row exclusions in the 98-table protected comparison; the selected
  sequence advanced the full suggestion singleton from 1 to 169. the 258-article
  census is complete. live acceptance: 168 of 168; 0 remain. accepted applies
  have full persisted/protected proofs. all168 changed applies are complete
  (`coordinator/finalf4026846/reader-final-acceptance.json`, `9915b658`):
  166 full http projections and two expected authorization refusals. the165
  automatic per-item counter observations each advanced by one, preserving
  the complete singleton identity and every other field; the three manual
  witnesses retain their accepted proofs and legitimate nav13 position.
  two owned publications are unfiled, with no library membership or read path:
  `3509567e-92bd-4549-a34d-7871083c0d22` and
  `6e1bb36b-bff7-431d-8062-dab2264cb5e0`. preserve that state and verify their
  ordinary `404/E_MEDIA_NOT_FOUND` is accepted; rendered access is not claimed. their
  source/persisted proofs remain mandatory, as do all representative consumers.
  the three manual consumer prerequisites are accepted (`6c4c2443`, peer
  `12c874e2`): nav13's old-copy409/preservation, fresh native navigation and
  hosted return; cosmic's full note/source/return; status16's empty projection.
  native request bodies, private locators and private asset bytes remain
  unobserved; the accepted old-copy proof uses the approved observable method.
  nav13 has30 stored toc nodes and31 rendered outline/persisted sections.
  city's original180-second timeout fully rolled back (`0ea6255a`). the shared
  bulk writer is now deployed and city live-accepted (`b7e9dce1`), with its
  apply completing in53 seconds under the unchanged budget.
  the unchanged article's mobile close restored focus to an offscreen reference
  and lost the positioned source. #642's focused correction is implemented,
  static/hosted green and deployed at pinned `f4026846`. actual desktop/mobile
  web and installed-phone source/close/return now pass (`0a2e66cb`); the full
  target stays visible after closing connections and returns to its departure.
  complete server cursors remain empty. the closing browser interval is complete:
  zero reader-position or activity writes; twelve successful workspace autosaves
  (`b083b0de`). no native zero-network-write claim is made.
- contributors: the original 244 reconcile to 235 unmatched, five unchanged
  and four deleted; this bounded audit does not establish broader metadata
  correctness. the separate frankenstein clone minimum and fixture restoration
  are accepted. its live repair is also accepted: three public cli calls,
  one apply and a fresh unchanged preview changed only the existing credit's
  `raw_role` from null to `aut`. person, alias, owner, library and source
  stayed exact; displayed author and publication generation did not change.
  its [consumer check](tickets/frankenstein-consumer-check-unresolved.md)
  remains explicitly unresolved by user decision.
- portrait: real source/index workers, refusal/replay cases, full98-table
  preservation and exact restoration of every queue/capacity/refusal fixture
  passed on the clone (`cd319d80`, combined peer `925cf4ff`). no clone worker
  remains active; original failed reports remain retained. production now has
  one fenced service admission and its normal successful source/index jobs:
  generation1, 95 fragments, 13 assets, and5,690 complete source-slice/quote/vector
  checks (`coordinator/finalf4026846/portrait-production-v1/persisted-acceptance.json`,
  `0d489fae`). original source/failure history, ownership, library membership,
  annotations and progress are preserved. the media unit is ready. metadata
  separately failed with `E_METADATA_MODEL_UNAVAILABLE` after two normal attempts;
  brave remains disabled. ordinary web and installed-phone reading, chapter i/ii
  navigation and return passed; all complete server cursors remain empty
  (`eb53f372`). the source/index/media-unit result does not relabel metadata
  as successful.

fresh pinned-release provider checks also passed (`2ddc5633`): one attached-quote
turn through the api and one resource turn through codex personal, both on
gpt-6-sol. each completed a real `nexus.resource.read`, published one citation,
and opened its rendered citation. no brave call or send retry. the resource's
revision6/offset134 cursor stayed exact. final live acceptance:
`coordinator/finalf4026846/final-live-acceptance.json`, sha256
`6c3cbd6a3cac939e42bb32670c09f0eb609eda80f56c9f10e7494f9dac5d65e8`.
owned unpacked probes, stopped proof containers, temporary production read-only
login, credential copies and tunnels are retired. accepted receipts, sealed
evidence, browser profile, task databases/volumes and shared dependencies remain.
no resize, reboot or brave use.

authoritative final receipts are under the private campaign root documented in
the [runbook](runbooks/retained-book-repair.md). root paths below are relative to
`coordinator/finalfdd0a3e/`; hashes identify the retained root and independent
peer receipts.

| accepted boundary | root receipt / hash | independent peer / hash |
| --- | --- | --- |
| selected 168 clone repairs | `reader-selected168-v1/final-closure-v1/root-review.json` / `0951240c` | `a-maintenance/selected168-final-actual-independent-review-v1.json` / `39589db7` |
| cosmic/status16 live persisted and http proofs | `live-reader-manual2-v1/root-review.json` / `0d49b804` | `a-maintenance/live-reader-manual2-actual-review-v1/receipt.json` / `61928e3f` |
| nav13 hosted navigation and explicit continue | `live-web-consumers-v1/nav13-root-review.json` / `8438e1a7` | `d-consumers/nav13-web-main-actual-independent-review-v1.json` / `b1b141b8` |
| nav13 old-copy refusal and passage preservation | `live-reader-consumer-v1/nav13-old-conflict-v1/root-preservation-acceptance.json` / `7db07907` | physical peer / `a799610e`; manual composition peer / `12c874e2` |
| nav13 fresh native navigation | `live-reader-consumer-v1/nav13-fresh-offline-v1/root-acceptance.json` / `1758872a` | `d-consumers/nav13-fresh-offline-actual-independent-review-v1.json` / `a228e949`; package peer `0afd50d9` |
| contributor clone minimum | `contributor-final-closure-v1/acceptance.json` / `468694bf` | `a-maintenance/contributor-finalfdd-actual-independent-review-v1.json` / `8284dce8` |
| frankenstein live credit | `live-frankenstein-v1/acceptance.json` / `0840ddbc` | `d-consumers/live-frankenstein-final-actual-independent-review-v1.json` / `0ae0f386` |

the original 0278 backup was restored and replayed through 0287. the pinned
correction's quiesced reader backup is fully read-verified (`817474a2`,
1,268,716,586 bytes), but NOT restored. the later pre-portrait backup contains
all168 repairs: `4a69c6bd`, 1,270,950,536 bytes, also fully read-verified and NOT
restored. normal writers remained active; its consistent snapshot lies within
the recorded acquisition interval. exact archive evidence and execution procedure belong
to the [runbook](runbooks/retained-book-repair.md#live-application-and-uncertainty).

root-owned `progress.json` and the referenced immutable receipts retain every
original failed attempt, refusal, reconciliation and continuation. those
failures remain failed evidence; separately accepted reconciliations preserve
their original outcomes. the specification does not duplicate that chronology.
owner decisions date from 2026-10-14; planning base was `75b17c0301be59da4a45dec8b35ab97d998e9199`,
with production `665e7b3af03282d37ac1a2aac3c6589e2a0f5932` / 0277.
recheck current identities before execution.

## outcome and scope

make source-proved books easier to navigate, restore proved note bodies, audit
saved source credits, and recover the failed portrait import. repair verified
items independently; retain explicit unresolved dispositions. completion of the
campaign means complete accounting, not a claim that every book was repaired.

| lane | frozen scope and starting evidence |
| --- | --- |
| reader | the 499 ids in r3 `inspection_start.selected_media_ids`; 494 inspected, 232 proposed changes, five failures, no apply |
| contributors | the original 244 owner-visible r4 ids: five unchanged, 239 `unmatched_creator` skips, zero proposals; plus only the frankenstein epub below |
| recovery | portrait below; normal source recovery, independently reported source/index/metadata outcomes |

the 232 reader proposals comprised 176 epubs and 56 articles.
reader and contributor scopes may overlap. historical complete accounting is
168 content-approved, 57 unsafe, five source-unproved, 265 unchanged and four
later deleted cases. current inspection covers the 495 surviving ids; exact
source/input/full-proposal equality is required to carry a content decision.
the 57 rejected proposals remain DEFERRED future work: 40 navigation cases,
14 note-content/link cases and three navigation-source-selection cases. retain
exact ids/source hashes/proposals and existing cause tickets. completion of those
follow-ups requires corrected source-verified repairs or source-proved no-change;
campaign closure neither resolves nor waives them. group fixes by demonstrated
shared cause, not per-book patches. they are outside this critical path.
fresh inspection determines eligibility and counts. the failed historical
aggregate stays failed; do not filter its rows into an apparently passing plan.
newly added books and other viewers' libraries do not expand either frozen set.

| exact case | media id | evidence and current disposition |
| --- | --- | --- |
| city of god | `043e7f93-bff0-4e6d-8c2e-ff684288641c` | historical 30,140 ms refusal; current repair live-accepted |
| kjv, volume 2 | `20405d0e-4fda-4cc7-b5e0-04b6a8a724d6` | historical 64,376 ms refusal; inspected under maintenance budget; unsafe note proposal deferred |
| kjv, volume 1 | `228d14cf-120c-495c-9e5c-5a3383658843` | historical 56,328 ms refusal; inspected under maintenance budget; unsafe note proposal deferred |
| the complete essays | `e6b755eb-c744-4391-b6ec-2b3ed2553837` | historical 37,078 ms refusal; inspected under maintenance budget; unsafe note proposal deferred |
| cosmic connections | `2293419e-8bb2-4fa9-851e-d1010b24067f` | 887 numeric-only note bodies enriched; live consumer acceptance complete |
| row 232 | `09f34c39-5c2c-481a-a713-9d83f7bbf320` | source-proved note pair; whole navigation proposal unsafe and deferred |
| frankenstein | `ce72f700-7416-44a5-ac80-9a2fb8d23717` | sole source-role correction accepted in production; viewer/library preserved; consumer check unresolved |
| portrait, norton critical edition | `9e5d8118-050d-48dc-9c99-870443481f61` | source/index/media unit and ordinary web/phone consumers live-accepted; metadata failed separately |

authoritative evidence: [reader census](tickets/reader-source-notes-production-repair-pending.md),
[maintenance contract](#lane-a-bounded-maintenance),
[note correspondence](#lane-b-note-bodies-and-navigation),
[credit census](tickets/epub-contributors-production-repair-pending.md),
[frankenstein consumer disposition](tickets/frankenstein-consumer-check-unresolved.md),
[portrait recovery evidence](runbooks/retained-book-repair.md).
retain their source hashes and immutable receipts; never commit private book bodies or credentials.

## invariants and composition

`verified retained source → existing parser/planner → inspected proposal →
generation/source fence → existing publication owner → existing consumers`.
no new http api, database schema, public wire format, reading-copy format or
repair framework. reuse the source, contributor-identity, publication and job owners.

| operation | may change | must preserve |
| --- | --- | --- |
| reader repair | sections/toc locations, note groups, source-proved apparatus presentation and additions, navigation source issues; publication generation; article-index reconciliation only when effective index blocks change; one transactional suggestion-input revision increment per changed apply | original source bytes/path/hash, fragment ids/order/hrefs/html/text/offsets/assets; existing apparatus ids/keys/kinds/exact locators/source identity and edge keys/endpoints/relations; ownership, libraries, annotations, highlights, progress, saved links and retrievals |
| credit repair | uniquely matched `epub_opf` observations and proved additions through the existing identity owner; one transactional suggestion-input revision increment per changed apply | manual/unrelated credits, existing person identities; all reader/publication/index state and `metadata_enriched_at` |
| portrait recovery | new attempt/job and appended history; first publication/index/metadata effects; ordinary transactional suggestion invalidation | media/source/creator identities, original bytes/hash and historical attempts; no mutation of an already published reader |

inspect is read-only. reader apply reparses outside its short locked transaction,
then checks source, full inspected proposal and current generation atomically.
changed means exactly one generation increment; unchanged means zero mutation.
stale, ambiguous or invalid input means zero mutation for that item.
snapshots and allowed diffs are per operation; one lane's legitimate changes
are not another lane's baseline corruption.
the suggestion counter is acquired last, through its existing owner, in the
same transaction as changed domain state. unchanged, refused, rolled-back
and landed-successor replay operations do not advance it. preserve the counter
row's identity and every other field; compare feeds/shortlists exactly while
their worker is not admitted. never exclude the whole suggestions subsystem.

## lane a: bounded maintenance

change only the private `epub_ingest._build_plan` contract: required keyword
`parse_budget_ms: int`, no default. ordinary ingestion supplies its existing
`_ARCHIVE_MAX_PARSE_MS` (30,000 ms); maintenance supplies a fixed,
reviewed 120,000 ms candidate. no environment/cli override or parser fork.
all archive, expansion, output, source-correspondence and identity limits remain.

the current time check runs after parsing; it is an acceptance budget, not a
kill deadline. qualify separately a 180-second whole-invocation deadline with
termination followed by forced kill after five seconds. qualify both values
against the exact four slow sources and cosmic; freeze measured limits in the
run receipt. no automatic escalation or retry after exhaustion. if insufficient,
record the refusal and review its cause before proposing another bound.

use the devbox, sequentially, one immutable operator container per inspect/apply.
candidate envelope: `--memory=1g --memory-swap=1g --cpus=1 --pids-limit=128
--read-only --init`, private 512 mib tmpfs counted within that memory limit,
existing non-root uid and no restart policy. equal memory/swap flags disable
swap ([docker contract](https://docs.docker.com/engine/containers/resource_constraints/#--memory-swap-details)).
check devbox headroom and effective cgroup limits, including `memory.swap.max=0`;
capture oom/kill counters before/after. configuration flags alone are insufficient.
set `PARSER_TEMP_ROOT` inside that private tmpfs: the worker's shared-root
pruner may delete standalone attempt directories. no production resize/reboot.

use a reviewed runbook, not a new runner service:

- qualify `/usr/bin/timeout` in the exact image, including a harmless process
  that ignores termination. explicitly install coreutils in the existing image
  owner only if absent. entrypoint: `/usr/bin/timeout --signal=TERM --kill-after=5s 180s python -m nexus.ops.reader_navigation_repair …`.
- create the container and persist its id before starting/attaching. do not use
  `--rm`, `--foreground` or `--preserve-status`. preserve exit, oom, resource,
  output and terminal-state evidence before removing the exact owned container.
  exit 137 alone cannot distinguish which process was killed
  ([timeout contract](https://www.gnu.org/s/coreutils/manual/html_node/timeout-invocation.html)).
- use authenticated ssh forwarding from devbox loopback to the freshly
  verified production postgres container's private bridge address: production
  postgres has no published port. pin database/container identity; stop on drift.
  `--network=host` reaches the devbox tunnel only after verifying actual
  engine/rootless networking. no new production listener. inspect has read-only
  database capability; apply gets the existing
  application write role. one connection, zero overflow and a 30-second
  statement timeout. the normal engine lock timeout is 10s; reader repair and
  contributor transactions set 2s locally. measure both separately on the final
  artifact; do not restore the removed lock-timeout setting. supply only required
  database/storage/auth settings; no model-provider keys. verify the actual access path first.
- remove private env files, tmpfs and owned tunnels after reconciliation.
  an outer ssh or `docker wait` timeout does not stop the workload.

preserve parser error codes/dimensions at the maintenance boundary using existing
`ApiError`/`ResourceLimitError`; do not turn a time/resource refusal into
`E_ARCHIVE_UNSAFE` or swallow defects. record process timeout/oom separately
from parser refusal. unknown exceptions remain failed, never unchanged.

## lane b: note bodies and navigation

finish/re-scope draft #584, initially `e3df92b6f7c09d59a5623e889ec5aa18c347ac64`.
implementation pr #609 supersedes that narrower draft; retain its prior evidence.
reuse retained-source correspondence, `_exact_epub_span`,
`_align_apparatus_keys` and the publication/apparatus owners. consolidate the
two repeated numeric-body predicates narrowly. absent old html is admissible
only when all of these hold:

1. existing supported body kind, source identity and unique occurrence agree.
2. old body is one to four decimal characters and equals the exact retained
   locator quote; old html is absent or canonicalizes exactly to that body.
3. new sanitized html canonicalizes exactly to the new prose; it starts with
   the old label followed by a nondecimal boundary.
4. the full prose occurs at that same retained fragment/start with the existing
   end-boundary proof. source offsets never replace retained coordinates.
5. existing locator, source identity and edges remain unchanged. the displayed
   enriched body may extend beyond its preserved numeric-label locator.

contradictory html, prefix `1` versus `10`, shifted/ambiguous occurrences or
unproved prose refuse. this is a source-proved maintenance conversion, with
no permissive on-read path or runtime compatibility branch.

make apparatus removal refusal unconditional. remove
`corrected_legacy_marker`, the `legacy_ref`/correction branches,
`_reciprocal_marker_correction`, `_verified_0245_legacy_backlink`,
`_specific_0245_bad_target` and `_assert_legacy_marker_unreferenced`.
the backlink helper also preserves row 232 without deletion: its removal can
make that item refuse. retain its [open obligation](tickets/reader-epub-row232-backlink-classification.md);
do not add another book-specific fallback. all other valid proposals remain
equivalent except the proved numeric-body enrichment and removal of unnecessary
article-index invalidation below.

the existing operator interface remains:

```text
python -m nexus.ops.reader_navigation_repair inspect --media-id <uuid>
python -m nexus.ops.reader_navigation_repair apply --media-id <uuid> --generation <n> --inspection-digest <sha256>
```

inspect the entire diff, including labels, ordering, reference/edge metadata and
source issues; #584 is not merely a body-text patch. zero removed apparatus
item/edge identities is mandatory but insufficient by itself. navigation
coalescence may retire only explicitly reviewed division identities, with
source-backed scope and reference/consumer obligations recorded. the old
inspection exposed only apparatus key sets. #609 extends its private dataclass
with `item_changes` and
`edge_changes` through existing `_row_changes`, plus
`installed_metadata_sha256` and `proposed_metadata_sha256` through existing
`_digest` over normalized metadata. expose typed `status_before` and
`status_after` too: a status-only normalization still changes the publication.
prove publication round-trips that
projection. these outputs make full review and uncertain-commit reconciliation
possible; the generation-bound `inspection_digest` cannot serve as a postcommit hash.

article repair must compare the complete ordered output of the existing
`build_web_article_index_blocks` owner over the same fenced fragments and the
before/proposed note regions. reuse that projection in navigation construction;
do not compare unordered database rows or a reduced navigation response.
equal output leaves index rows, jobs, summaries, claims, connections and
retrievals unchanged. changed output requests ordinary reconciliation exactly
once in the publication transaction. apparatus status and reader generation
alone do not invalidate this index. prove both branches, fresh unchanged apply
and stale refusal on the real clone; the 52 empty-note status repairs require
zero index effects. necessary reindexing still needs its own
[saved-evidence preservation proof](tickets/reindex-invalidates-saved-evidence-targets.md).
this narrow correction adds fresh rehearsal cost; it avoids deleting unrelated
product state or spending provider calls merely to normalize a status.

## lane c: source audit and portrait

run the existing `python/scripts/repair_epub_contributors.py --viewer-id <uuid>
--media-id <uuid>` preview against the explicit frozen ids. independently
reconcile requested versus returned ids: invisible/missing ids can be omitted
and exit zero also covers guarded skips. every requested id needs a disposition.
audit verified original opf and actual credit rows; `unmatched_creator` means
no unique surviving source-person match, not incorrect or correct credits.
accept source-proved unchanged or evidenced unresolved results. do not invent
identities, split semicolon names, merge people or broaden matching to manufacture eligibility.
frankenstein retains viewer `579543d7-64ec-4282-9f1b-7a445ebf672a`; reverify
visibility and source identity without changing ownership or library membership.
on 2026-10-16 the user authorized its source-proved credit repair while leaving
its web/phone check explicitly unresolved: the current release account cannot
read it. this exception applies only to frankenstein; do not manufacture access.

the audit produced one proved correction. merged #613 implements the
[preview fence](https://github.com/NielsdaWheelz/nexus-web/pull/613); its qualified contract is:

- preview emits `preview_digest` and full ordered before/proposed rows, not
  only counts or moved/added descriptions. bind viewer/media, verified source
  identity, complete current credit/manual state and selected person identities.
- reuse `plan_observation_credits`. existing people bind their uuids; proposed
  new people bind deterministic name/key plus a plan-local shared-entity ordinal,
  never object identity or future random uuids.
- `--apply` requires exactly one explicit `--media-id` and
  `--preview-digest <sha256>`; reject bare apply. recompute/compare inside the
  locked serializable transaction before allocation/dml, including every retry.
  materialize that same checked identity plan; no second resolution race.

no current proposal means no credit write. the api image excludes
`python/scripts`: supply this existing script read-only with a recorded hash
matching the candidate, rather than assuming it is packaged.

cleanup removed `ops/processing_recovery.py`; do not restore it. portrait's
historical `E_ARCHIVE_UNSAFE` remains terminal under ordinary retry. merged #619
adds the operator-only `media_source_ingest.reprocess_failed_stored_epub` admission,
with no public route, wire change, migration or permanent cli. it accepts the
creator, media id, expected failed stored-epub attempt, exact source hash and
request id through the existing serializable owner. verify owner, original row
and hash on every attempt. a new admission requires the expected latest failed
attempt and failed, unpublished media; reuse `_admit_successor` and append the
existing `ReprocessSourceRecovery` history. retain the historical failure.

repeating the expected attempt returns its deterministic existing successor,
after the same owner/source checks, with no new job or history. a nonlatest
expectation without a successor refuses. returning an already-landed successor
after publication is replay; creating a new attempt over published content is
forbidden. reconcile uncertain admission through this chain, never a new
invented attempt or the deleted mutation-id protocol.
use the current normal runtime for admission and record the actual queued
worker image separately: the admission runtime fingerprints its own process.
rehearse through the real queue/worker with unchanged import limits.
the operator's recorded diagnosis justifies this explicit reprocess; admission
does not prove corrected parsing. the ordinary worker still verifies bytes and
may fail under the unchanged archive, time and publication guards. remote-source
reacquisition, published republication and automatic retries are out of scope.

normal publication also requests indexing and metadata enrichment. the owner
accepts readable portrait with an independently failed metadata job while brave
is unavailable. verify source readable and index ready; record metadata's actual
outcome. do not claim the whole import completed, disable enrichment or alter
queue state to conceal failure. a current normal-ingest defect warrants a
separate proved fix; otherwise retain an unresolved recovery disposition.

## content and consumer acceptance

each lane's designer owns examples and expected content before implementation;
the independent reviewer rejects plausible-looking but unproved output.

| feature / existing schema owner | what good content means |
| --- | --- |
| navigation / `schemas/reader.py:MediaNavigationOut` | routine sections are reading divisions; full `toc_nodes` preserve publisher hierarchy/destinations. notes remain reachable without becoming routine chapters merely because they have headings. keep authored labels; repeated numbers stay distinct; no global label/filename blacklist |
| notes / `schemas/reader_apparatus.py` | source-faithful sanitized prose and structure, correct marker/body pairing and note groups. ambiguous targets stay explicitly unresolved. no generated prose or invented location |
| reader / `schemas/reader_document.py:ReaderDocumentOut` | note inspection/jump preserves departure and progress; return restores it; only explicit continue-reading changes position. verify epub and article consumers |
| credits / existing contributor taxonomy and `credits.ts` | preserve source spelling, punctuation and order; author/editor/translator stay distinct. unsupported roles retain unknown/raw-role semantics; never a plausible guessed author |
| recovery and operator receipts | distinguish readable, indexed and metadata-failed; distinguish proposed, applied, verified and unresolved. include a useful reason and next action, never a green total hiding missing ids |

before reader apply, inventory affected downloaded copies, sync pending progress
and close affected readers. if a selected copy cannot sync, defer that title;
do not discard pending position. old-generation sync must still return
`E_READER_CONTENT_CHANGED` without silently losing local state. after verified
apply, remove/redownload only affected copies and prove the new generation,
navigation and existing offline jump/return behavior. no reading-copy format
change; [offline evidence-pane parity](tickets/offline-reader-lacks-source-apparatus-inspection.md)
remains separate.

## ownership, sequence and proof

| owner / delivery | exclusive implementation files and responsibility |
| --- | --- |
| a: maintenance pr | `services/epub_ingest.py`; narrow operator error output in `ops/reader_navigation_repair.py` if required; `docker/Dockerfile.backend` only if timeout is absent. budget/containment receipts and operator-content designer |
| b: reader pr #609 | `services/reader_navigation_repair.py`; strict enrichment, complete exception removal and full projection evidence; navigation/note content designer. compose the required storage-factory call in `ops/reader_navigation_repair.py` after a's typed refusal change |
| c: source audit and contributor pr #613 | `python/scripts/repair_epub_contributors.py`, `services/epub_contributor_repair.py`; existing `contributor_writes.py` only if checked-plan materialization requires it. source/credit/recovery content designer |
| c: recovery correction | `services/media_source_ingest.py`; one diagnosed stored-epub admission through current source/job/history owners, separate from the credit pr |
| coordinator | this plan, runbook, private scope/receipts, tickets and integration; next canonical rollout, fresh backup and sole book production write owner |

service/ops paths above are under `python/nexus/`. no shared-file parallel edits.
the source prs and approved release work are merged; canonical artifacts and
matched wire-2 consumers passed the separate usable-release qualification.
book operator and repaired-content proofs below are now accepted as reported
above; these retained requirements are not a new execution queue.

before any clone worker runs, isolate database/queue AND output storage. use a
separate rehearsal r2 bucket via existing `R2_BUCKET`, scoped credentials and
verified copies of the original objects; no production storage writes.
qualify lanes sequentially on the same restored clone when the preceding
lane's complete effects, fixture cleanup and terminal state are accepted.
take a fresh protected baseline for each lane, preserving earlier accepted
repairs and the actual suggestion singleton. never reuse pre-repair hashes or
guess its revision. this avoids redundant restores but requires an exclusive
handoff with no intervening writer. restore again if the current state cannot
provide a proved baseline. preserve the backup, active clone and volume.
on the disposable clone, observe the actual eligible/expired queue and capacity
before taking the portrait baseline; preserve historical jobs and capacity rows.
if unrelated eligibility requires isolation, root owns the exact reversible
fixture and its restoration after both source/index turns. preserve
source-after/index-before baseline equality. the fresh protected capture proves 60 pending jobs and one
expired running claim with an occupied heavy capacity row (acceptance
`coordinator/finalfdd0a3e/portrait-protected-v1/before-v1/acceptance.json`,
`1c4b0c55`). the named fixture
may defer the 60 pending rows' `available_at`; for the single expired claim,
set only `status` to `pending`, the same future `available_at`, and null
`claimed_by`/`lease_expires_at`. clear only the heavy row's `job_id`/lease.
preserve all 61 full job rows, attempts, execution ids and history. restore
every original fixture value and the capacity timestamp changed by the worker.
take a fresh target snapshot after isolation; do not patch the earlier snapshot.
implementation and restoration are root-owned; current execution status is
recorded above.
the temporary harness uses unmodified `JobWorker.run_once()` plus
`ChildExecutor.open(settings)` in the deployed worker image under its actual
448 mib contract. source admission must leave its exact job as the only
eligible/expired background work. after source success, bind the actual queued
index job and current registry before admitting its ordinary worker turn. the
retired asset-cleanup claim loop is not part of this release. stop on retry,
failure, uncertainty or any unrelated claim; do not consume it as setup.
do not rewrite priorities, start periodic scheduling, invoke handlers directly
or patch the registry. leave other follow-on jobs unconsumed;
declare any real provider calls. normal production entrypoint proof remains live.

1. **red:** freeze exact scope/source hashes and failure receipts. temporary
   real-stack integration probes must demonstrate the current defects/refusals
   and expected invariants on a verified restored copy. no fabricated production
   faults or blanket claim that already-correct behavior fails.
2. **green:** implement only each owner's contract. run `./scripts/test` and
   the focused proofs below. independently review code, content and allowed diffs.
3. **refactor:** remove duplicate predicates and superseded exception paths;
   re-run affected proofs at the final candidate/image. no speculative helpers.
4. **qualify:** restore a fresh verified production backup and use the actual
   deployed api/worker/web/offline consumer versions. test exact slow books,
   cosmic and representative changed epub/article proposals; fully inspect the
   frozen reader set and reconcile every contributor id. review every apply
   proposal; rehearse the selected apply set, protected-state diff and unchanged
   reinspection. these repair changes add no migration. before qualification,
   replay main's 0279–0287 on the restored 0278 backup and take new protected
   baselines. 0279 recursively unwraps exact Presence objects; only workspace
   state receives its snake-case key migration. compare every old reviewed reader
   field through that explicit conversion against fresh complete proposals;
   any additional semantic change returns to review. 0281 changes reader-state
   rows; 0284 rewrites current summary/job fingerprints, 0285 removes retired
   media fields and rewrites teardown payloads, 0286 drops the replay ledger,
   and 0287 adds three suggestions tables. prove exact migration effects,
   preserve the identity set of current summaries, and discover the new table
   inventory before freezing its baseline. the existing reconciled 0283 clone
   may continue through 0284–0287 without another restore. run one current
   495-item reader inspection pass; old content reviews carry only through
   exact source/input/full-proposal equality. reuse those fresh fences for
   selected applies after audit equality, all fault restorations, positive-fixture
   cleanup and a no-intervening-writer admission prove the full unchanged-item
   bridge. retain original snapshots and their separately hashed comparison
   copies; do not repeat the 168 pre-apply inspections. consumer
   requests use current snake-case nullable wire and `X-Nexus-Wire: 2`.
5. **live:** take a fresh verified pre-apply production backup and record its
   cutoff; reuse the rehearsed backup only if no intervening relevant writes
   are proved. distinguish checksum verification from an actual restore;
   do not claim the newest dump was restored if it was not. reverify versions,
   sources and item fences. sync/quiesce each small affected batch, not every
   reader for the entire campaign. fresh proposals supersede stale ones.
   apply sequentially; verify persisted rows, consumer behavior and downloads.
   broad row equality is proved on the clone; live proof must distinguish
   legitimate concurrent writes from repair effects.
6. **close:** retain per-item evidence and unresolved tickets; delete temporary
   tests/fixtures/harnesses/dependencies after final refactor and live acceptance.
   retain no test-only production seams. run the static gate after deletion.

at every step, a reviewer from another lane challenges identity, concurrency,
resource containment, truthful results and scope before the next boundary.
review failures return to their owner; code approval is not live acceptance.

minimum temporary proof set, grouped by the failure it prevents:

- measure all four slow sources; each repaired time failure must pass within
  frozen bounds, and remaining refusals stay unresolved. ordinary import
  policy/output stays unchanged. real timeout, forced termination, oom
  and full-tmpfs cases leave no live process or abandoned shared temp state.
- cosmic restores the proved 887 bodies while preserving 1,774 keys and 887
  edge pairs; contradictory html, ambiguous/shifted text, numeric-prefix
  collision, redirected/removed identity and stale source/generation/proposal
  all refuse with zero writes. ordinary retained-coordinate correspondence
  still works when source coordinates differ. row 232's disposition is explicit.
- clone apply preserves complete protected state; changed increments once.
  fresh reinspection and apply with its fresh fence are unchanged; replaying
  the old fence refuses. kill near commit and lost reply require
  reconciliation, not a blind retry. one refused item does not fake aggregate success.
- conditional credit apply rejects source/credit drift AND an alias-winner
  change with otherwise unchanged inputs, allocating no people/aliases/credits;
  an accepted plan applies once and preserves unrelated state.
- portrait uses the real queue/current worker, becomes readable/indexed or has
  a precise failure; successor replay creates no extra attempt/job/history;
  wrong owner/hash, unlanded stale expectation and new admission over published
  content refuse without writes. metadata is separate.
- current web/phone consumers show the reviewed navigation, note bodies and
  credits; departure/return, saved positions and affected-copy refresh work.
  frankenstein's consumer check remains unresolved by the explicit disposition
  above; successful credit repair does not imply that check passed.

## receipts, failure policy and tradeoffs

use small private json files, not a new database ledger. campaign fields:
`schema_version=1`, candidate source/image/script hashes, deployed consumer
identities, database identity/revision, exact lane scopes, measured limits,
backup object/hash/restore receipt, and per-item artifact paths/hashes.
item fields: lane, media/viewer identity, verified source identity, before/after
generation where relevant, elapsed/resources, and a tagged outcome:
`proposed{digest,diff}`, `unchanged{proof}`, `applied{receipt}`,
`verified{reinspection,consumer_proof}`, `unresolved{reason,evidence,next}`,
`not_run{reason}` or `unknown{reconciliation}`. retain prior attempts;
never overwrite a failure with a later success. no credentials in receipts.

timeout, transport loss or missing terminal output during apply means unknown:
stop further writes, confirm the workload stopped, then reconcile source,
generation AND the complete approved projection: current installed metadata
must hash to the approved proposed hash. generation alone is not proof.
the projection hash excludes generated row ids; protected-identity checks remain
mandatory. use the equivalent full approved credit result for contributor writes.
only proved non-commit permits a fresh fenced attempt. all selected ids need
final unchanged/verified/unresolved dispositions; unknown or not-run work
prevents campaign closure. unresolved items retain their own tickets.

tradeoffs: per-item containers and larger off-host budgets cost time/devbox
capacity; they avoid spending production's small memory reserve. conservative
proofs leave some books unrepaired, including potentially row 232. per-item
atomicity permits partial progress, not corpus-wide rollback. operator-only
activation leaves production's runtime sha unchanged and needs separate evidence.
download refresh costs time but preserves the existing generation contract.
deleting temporary tests relinquishes ongoing regression coverage; receipts
prove only the qualified candidate. backup restoration requires stopped writers
and an incident decision about discarding post-backup writes; no automatic
reverse repair or whole-database restore.

non-goals: universal credit correctness/research, new reader/editor ui, offline
evidence parity, global canonicalizer optimization, deploy-tooling rewrite,
migration squash/archive retirement, brave restoration, key rotation or host
resize/reboot. existing tickets remain open until their own acceptance is met.
