# retained-book repair plan

status: implementation in draft prs [#608](https://github.com/NielsdaWheelz/nexus-web/pull/608)
and [#609](https://github.com/NielsdaWheelz/nexus-web/pull/609); static checks,
local source probes and operator containment proofs passed. restored-database qualification is in progress;
production repair and consumer acceptance remain NOT_RUN.
owner decisions settled 2026-10-14. planning base: `75b17c0301be59da4a45dec8b35ab97d998e9199`.
planning-time production: `665e7b3af03282d37ac1a2aac3c6589e2a0f5932`, schema 0277.
recheck identities before execution. this work does not gate the usable release.
execution: [maintenance runbook](runbooks/retained-book-repair.md).

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
reader and contributor scopes may overlap.
fresh inspection determines eligibility and counts. the failed historical
aggregate stays failed; do not filter its rows into an apparently passing plan.
newly added books and other viewers' libraries do not expand either frozen set.

| exact case | media id | existing evidence |
| --- | --- | --- |
| city of god | `043e7f93-bff0-4e6d-8c2e-ff684288641c` | 30,140 ms |
| kjv, volume 2 | `20405d0e-4fda-4cc7-b5e0-04b6a8a724d6` | 64,376 ms |
| kjv, volume 1 | `228d14cf-120c-495c-9e5c-5a3383658843` | 56,328 ms |
| the complete essays | `e6b755eb-c744-4391-b6ec-2b3ed2553837` | 37,078 ms |
| cosmic connections | `2293419e-8bb2-4fa9-851e-d1010b24067f` | 887 numeric-only note bodies with absent html |
| row 232 | `09f34c39-5c2c-481a-a713-9d83f7bbf320` | special backlink preservation; may become unresolved under the hard cut |
| frankenstein | `ce72f700-7416-44a5-ac80-9a2fb8d23717` | source/credits unverified; keep its existing viewer and library |
| portrait, norton critical edition | `9e5d8118-050d-48dc-9c99-870443481f61` | failed import; exact-source recovery unproved |

authoritative evidence: [reader census](tickets/reader-source-notes-production-repair-pending.md),
[time refusals](tickets/reader-repair-epub-parse-budget.md),
[note correspondence](tickets/reader-repair-existing-apparatus-correspondence.md),
[credit census](tickets/epub-contributors-production-repair-pending.md),
[frankenstein source identity](tickets/legacy-epub-credit-outside-owner-scope.md),
[portrait source identity](tickets/epub-apparatus-prefix-scans-exhaust-parse-budget.md).
retain their source hashes and immutable receipts; never commit private book bodies or credentials.

## invariants and composition

`verified retained source → existing parser/planner → inspected proposal →
generation/source fence → existing publication owner → existing consumers`.
no new http api, database schema, public wire format, reading-copy format or
repair framework. reuse the source, contributor-identity, publication and job owners.

| operation | may change | must preserve |
| --- | --- | --- |
| reader repair | sections/toc locations, note groups, source-proved apparatus presentation and additions, navigation source issues; publication generation; existing article-index reconciliation | original source bytes/path/hash, fragment ids/order/hrefs/html/text/offsets/assets; existing apparatus ids/keys/kinds/exact locators/source identity and edge keys/endpoints/relations; ownership, libraries, annotations, highlights, progress, saved links and retrievals |
| credit repair | uniquely matched `epub_opf` observations and proved additions through the existing identity owner | manual/unrelated credits, existing person identities; all reader/publication/index state and `metadata_enriched_at` |
| portrait recovery | new attempt/job and appended history; first publication/index/metadata effects | media/source/creator identities, original bytes/hash and historical attempts; no mutation of an already published reader |

inspect is read-only. reader apply reparses outside its short locked transaction,
then checks source, full inspected proposal and current generation atomically.
changed means exactly one generation increment; unchanged means zero mutation.
stale, ambiguous or invalid input means zero mutation for that item.
snapshots and allowed diffs are per operation; one lane's legitimate changes
are not another lane's baseline corruption.

## lane a: bounded maintenance

change only the private `epub_ingest._build_plan` contract: required keyword
`parse_budget_ms: int`, no default. ordinary ingestion supplies its existing
`MAX_EPUB_ARCHIVE_PARSE_TIME_MS` (30,000 ms); maintenance supplies a fixed,
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
  application write role. one connection, zero overflow, 30-second statement
  timeout, two-second lock timeout. supply only required database/storage/auth
  settings; no model-provider keys. verify the actual access path first.
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
do not add another book-specific fallback. all other valid proposals must remain
equivalent except the intended, proved numeric-body enrichment.

the existing operator interface remains:

```text
python -m nexus.ops.reader_navigation_repair inspect --media-id <uuid>
python -m nexus.ops.reader_navigation_repair apply --media-id <uuid> --generation <n> --inspection-digest <sha256>
```

inspect the entire diff, including labels, ordering, reference/edge metadata and
source issues; #584 is not merely a body-text patch. zero removed identities
is mandatory but insufficient by itself. the current inspection exposes only
apparatus key sets. extend its private dataclass with `item_changes` and
`edge_changes` through existing `_row_changes`, plus
`installed_metadata_sha256` and `proposed_metadata_sha256` through existing
`_digest` over normalized metadata. expose typed `status_before` and
`status_after` too: a status-only normalization still changes the publication.
prove publication round-trips that
projection. these outputs make full review and uncertain-commit reconciliation
possible; the generation-bound `inspection_digest` cannot serve as a postcommit hash.

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

only if the audit produces a correction, implement the
[missing preview fence](tickets/epub-contributor-apply-does-not-bind-preview.md):

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

no proposal means no contributor code pr or write. the api image excludes
`python/scripts`: supply this existing script read-only with a recorded hash
matching the candidate, rather than assuming it is packaged.

portrait uses the existing capability, not a new retry system:

```text
python -m nexus.ops.processing_recovery reprocess-source <media-id> <expected-attempt-id> <expected-source-sha256> <mutation-id>
```

require failed, unpublished retained epub, exact current attempt/source/creator
and verified bytes. use the same mutation id and operator image to reconcile
uncertain admission; never fabricate a new one merely to retry. retain historical attempts.
use the current normal runtime for admission and record the actual queued
worker image separately: the command's runtime hash fingerprints its own process.
rehearse through the real queue/worker with unchanged import limits.

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
| navigation / `schemas/media.py:MediaNavigationOut` | routine sections are reading divisions; full `toc_nodes` preserve publisher hierarchy/destinations. notes remain reachable without becoming routine chapters merely because they have headings. keep authored labels; repeated numbers stay distinct; no global label/filename blacklist |
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
| b: finish #584 | `services/reader_navigation_repair.py` only; strict enrichment, complete exception removal and full projection evidence; navigation/note content designer |
| c: source audit; conditional third pr | `python/scripts/repair_epub_contributors.py`, `services/epub_contributor_repair.py`; existing `contributor_writes.py` only if checked-plan materialization requires it. source/credit/recovery content designer |
| coordinator | this plan, runbook, private scope/receipts, tickets and integration; sole production write owner. recovery uses existing `ops/processing_recovery.py`/`services/media_source_ingest.py` |

service/ops paths above are under `python/nexus/`. no shared-file parallel edits.
two initial code prs; the source audit runs independently. integrate both,
then qualify one immutable operator image. maintenance-only activation needs
no web/api rollout if actual deployed consumers accept its output; schema
equality alone is insufficient. any normal-runtime fix gets its own deployment.

before any clone worker runs, isolate database/queue AND output storage. use a
separate rehearsal r2 bucket via existing `R2_BUCKET`, scoped credentials and
verified copies of the original objects; no production storage writes.
on the disposable clone only, export/remove unrelated nonterminal queue rows
and capacity leases before taking the verification baseline; preserve portrait's
historical attempts/jobs and terminal history, record any fixture cascade effects.
the temporary harness uses unmodified `JobWorker.run_once()` plus
`ChildExecutor.open(settings)` in the deployed worker image under its actual
448 mib contract. source admission must leave its exact job as the only
eligible/expired background work. after source success, freeze the exact index
job and any newly produced, retained asset-cleanup jobs proved to reference
portrait's new resources. consume ordinary claims only from that list, each
at most once, stopping when index succeeds; the bound is asset-cleanup count
plus one turn. stop on retry, failure, uncertainty or an unexpected next claim.
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
   reinspection. no migrations run for this maintenance.
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
  a precise failure; repeated mutation admission creates no extra attempt/job;
  stale-attempt and already-published requests refuse. metadata is separate.
- current web/phone consumers show the reviewed navigation, note bodies and
  credits; departure/return, saved positions and affected-copy refresh work.

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
