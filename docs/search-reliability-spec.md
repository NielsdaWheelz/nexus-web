# search reliability: revised implementation and acceptance spec

contract revised 2026-10-29; implementation status reconciled 2026-10-30.
historical evidence retains its recorded source and migration identity. the isolated
integration `ff83a5318` of search `7173b6a91` with main `96a3b7bdf` had one canonical
migration 0329/down 0328 and passed the sole static gate. that closed the source/head
collision. that frozen integration's disposable functional composition passed as
scoped below. integration of main `e2192e593` preserves its historical x-data
contracts; earlier static/manual receipts do not qualify this newer tree.
integrated migration and bounded native backend/os qualification now have accepted
evidence; [release acceptance](issues/release-search.md) records their scope and
the remaining deployed/client gates.
the previous spec is preserved at
`.nexus-local/search-reliability-spec.before-2026-10-28.private.md`.

## decision

useful retrieval and a surviving database take precedence over speed. preserve
semantics and writing; bound concurrency and physical resources; let complete
work finish. a safe timeout is a failure outcome, not a working search.

the user's 2026-10-29 decision permits deliberate serialization of heavy search,
suggestion ranking, indexing and backup. their simultaneous peaks need not fit.
normal services must fit while present, including idle workers and retained
connections. on 2026-10-30 the owner explicitly removed backup-window enforcement
as a requirement for this single-user prototype. keep ordinary nightly backups;
no new pause/admission mechanism or recurring server outage is required. measured
idle-worker backup success does not prove unrestricted overlap, and historical
overlap failures remain failed. this accepted limit does not change caps/reserves,
verified backups or stopped-writer requirements for incompatible releases.
useful search must eventually complete; ordinary reading, local writing
and cancellation remain usable, and finite queued work must drain. serialization
is a scheduling choice, not permission for starvation, lost work or hidden failure.
capacity waiting must remain visibly and honestly pending; generic waiting copy
is sufficient. it never spends the execution allowance, which begins at admitted
execution. existing request/presentation owners must resume deferred work under
the current intent, preserve stable completed results and honor cancellation.
browser requests use nonblocking admission before embedding; their existing
client intent owns capacity waiting and natural retry. execution and transport
safeguards remain finite. actual deployment ceilings and capacity remain with
[release acceptance](issues/release-search.md).

retire the former 400 ms background computation, 500 ms hold/retirement and
60-second quiet-publication acceptance gates, plus the former foreground
latency/phase-cutoff requirements. **no replacement numeric deadline is approved;
15 seconds was a suggestion.** finite operational watchdogs are implemented;
their values are safeguards, not acceptance targets. qualification remains
required as specified below.

this document owns common acceptance. [database capacity](database-capacity-spec.md)
owns physical topology/accounting; [suggestion admission](suggestion-admission-spec.md)
owns exact domains, ranking, admission and publication. these are cohesive owner
boundaries, not prescribed separate prs or duplicated acceptance contracts.
this target supersedes conflicting timing requirements in
[search](modules/search.md), [suggestions](modules/suggestions.md),
[release-search](issues/release-search.md) and linked issue resolution clauses.
it does not change historical verdicts or turn old failures into passes.

retain the 2 gib ram host, postgres 512 mib/no-swap leaf, api 384 mib and other existing
service limits. retain the established 64 mib database and 128 mib workload host
reserves; deployment's separate 256 mib available-memory preflight stays intact.
where the connector is omitted from a backend qualification, its full 128 mib cap
is reserved alongside the 128 mib host reserve: 256 mib available physical memory,
with the 64 mib postgres reserve independent.
production host swap remains enabled: cloud-init provisions at least 1 gib.
the no-swap condition applies to service leaves, whose `memswap_limit` equals
`mem_limit`, not to the host. record host ram headroom, swap use and pressure
alongside service charges; swap capacity is not physical ram reserve. nonzero
host swap use is not itself a failed gate or permission to raise leaf limits.
no larger host, external search service/pooler, new scheduler, persistent partial
rankings or local corpus replica. no semantic feature is cut by this revision.

## evidence and uncertainty

- **observed:** production postgres oom kills and recovery; warmed ordinary
  connections could exhaust memory before another search. separately, suggestion
  work held search admission for minutes. allocator attribution remains incomplete.
  [oom](issues/production-search-postgres-oom.md),
  [contention](issues/production-search-admission-contention.md).
- **observed:** exact retrieval over 39,769 restrictive chunks found required
  matches in about 1.5 seconds; a server-membership prototype took about 0.9 seconds.
  a separate complete strict read took about 2 seconds and still used ann. database
  reserve held; neither proves a full exact suggestion refresh or whole-host fit.
  [retrieval contract](modules/search.md),
  [strict read](issues/strict-search-family-ranking-budget.md).
- **observed:** the historical exhaustive suggestion reference took 204.6 seconds
  for lectern and 220.4 seconds for a named piece; the b34 candidate took 0.73 and
  0.89 seconds. receipts are the private `final-suggestion-quality-b34dd44cb-refowner-*.private.json`
  files under `apps/web/.nexus-lab/cases/native-results/`. these obsolete-plan
  timings neither qualify nor disqualify the proposed repaired exact queries.
- **observed:** static checks, the three retained foundations and real-model
  shortlist/discovery/chat-tool cases passed at their recorded revisions. derived
  0319 preservation and actual main 0320 migration passed. actual half 0321 built
  in 59.12 seconds with sampled database charge 335.3 mib, unchanged recorded
  non-index/authored/source fingerprints and vector count, and confirmed cleanup.
  vector count alone is not original-vector-byte equality. this is build and
  preservation evidence, not retrieval or capacity acceptance.
  remaining [upgrade and pairing](issues/release-search.md) and
  [capacity](issues/production-database-connection-budgets-implicit.md) gates.
- **observed:** latest oracle generation/content review passed with three citations;
  only two had exact navigation targets, with no browser-click proof. provider
  cleanup is now confirmed; the original lab-exit-125 history remains.
  [blake locator](issues/oracle-resolved-blake-anchor-has-no-captured-location.md).
- **observed:** selected stock exact source `c6aa98b08` completed a warm full
  five-anchor, both-family global refresh and published 32 refs at input 1205.
  real private browser/bff/api lexical and hybrid requests subsequently completed
  usefully while queued behind another full global refresh. confirmed retirement,
  service limits and cleanup passed. private receipts:
  `.nexus-local/native-selected-global-shortlist-c6aa98b08-actual.private.tar` and
  `.nexus-local/native-real-overlap-c6aa98b08-actual.private.tar`.
  this proves feasibility for that warm selected 0321 component, not cold reads
  or the actual 2 gib topology.
- **observed current-source composition:** integration `ff83a5318` passed the three
  canonical lab scenarios plus a temporary semantic extension in
  `20261029-042930-e7ded121bbd8`, with complete cleanup. normal reindexing succeeded
  on attempt 1 and produced one current ready vector. an absent-token lexical
  query returned zero; hybrid returned the intended semantic passage. another
  library's scope excluded it, all scope included it, and hidden content stayed
  excluded. this uses fake providers: it proves composition, not live retrieval
  quality or native capacity. the first extension receipt guard failed after the
  canonical scenarios passed; that failed attempt remains failed.
- **observed functional completion:** run `mac-search-7173b6a91-e8dbfac99e3d`
  reached its final recheck: global/named publications had 32/16 refs at input 1212
  with cleared job pointers; overlapping lexical/hybrid reads returned 200 with
  the semantic witness. reading, normal writing/reload and accepted prefix 2,
  ui stop, indexing and fixed/new-note scans completed. its overall verdict
  remained FAILED because an invalid auxiliary filename was rejected before
  backup creation; it is not backup-overlap or full memory acceptance.
- **resolved setup findings:** the bulk permit is functionally exercised on 7173.
  the earlier notes failure was instrumentation-only in the two-browser control;
  no actual failed upload `POST` was captured. normal online writing/reload does
  not prove injected upload-failure retry. earlier proofs retain their own source.
- **observed memory failure:** run `mac-search-7173b6a91-1b9ec08d05a6` used a valid
  backup key but its 1280 mib parent recorded oom 1/kill 1. a strict-scan child failure
  settled DEAD attempt 1 with `E_RESOURCE_LIMIT`; postgres kept its epoch.
  backup later completed canonical create/full-byte verification naturally and
  manual maintenance exited 0. those successes do not repair the failed memory
  workload. [backup overlap](issues/search-backup-overlap-oom.md) owns the remaining
  attribution. auxiliary/runtime recovery and preparation-owned cleanup are
  confirmed; a private full database snapshot preceded removal of the prepared
  database/volume/network/parent. the protected original database and shared daemon
  were unchanged. the original failed verdict is unchanged. these historical
  0321 components do not qualify integrated 0329 or the actual 2 gib topology.
- **release disposition:** [release acceptance](issues/release-search.md) records
  user-reported paired preparation completion, the published release and explicit
  remaining limits; final client counters were not independently captured.
  extension/offline behavior, useful progress, queue drain, migration, bounded
  capacity and ordinary production use are accepted at their recorded scopes
  and are not repeated. brave import/metadata remains
  [entitlement-blocked](issues/live-search-qualification-brave-payment-required.md).

## target behavior and invariants

search retains direct, lexical and semantic capabilities, existing scopes and
filters, strict tools, pickers, connection discovery and oracle retrieval. show
truthful pending/failure states and retain useful completed phases. no results
means successful empty completion; semantic failure cannot masquerade as hybrid
success. slower server work must leave local authored search, reading, writing
and stop controls usable.

permissions, canonical reading boundaries, publication/model identity, original
vectors, distance thresholds, anchor attribution, evidence and activation stay
exact. browser/strict distance remains 0.5, suggestion similarity 0.80; oracle
retains its full 0–2 cosine domain. preserve lexical ordering, family composition,
diversity and current result windows. exactness of a neighbour window does not
promise exhaustive application results or stable pagination across corpus changes.

main's local-first authored owner remains authoritative: locally committed
immutable changes survive remote failure and retry the same sequence and bytes.
server-owned writes retain their own identity/version/retry contracts. database
busy or lost response never proves that a write failed to commit. no old note
write owner, replay ledger or second recovery mechanism returns.

suggestions retain [stable visits and explicit refresh](modules/suggestions.md):
an adopted pool keeps its order, eligibility is rechecked, and refresh reads the
latest completed publication without waiting for a new ranking. retain the
15-minute age policy and 30-second build spacing as scheduling policy, not a
completion guarantee. old rankings never grant current permission. after a finite
competing workload drains, every active due feed must publish the settled input
revision; old rows, empty substitutes and perpetual rescheduling do not satisfy it.
freeze that due-feed cohort at scenario start. identify pre-existing suspended
failures separately; failures or suspensions created by the scenario cannot
remove feeds from acceptance.

## architecture and operational bounds

keep the current owners; change policy at those owners rather than adding layers.

1. `db/engine.py`, `db/session.py`, `db/listen.py` and deployment composition own
   finite physical checkout, transaction/loop lifetime and total accounting.
   the candidate uses role pools with zero overflow, short reserved control
   transactions and a shared api listener to preserve bounded ownership and
   progress. those mechanisms are justified by their callers and demonstrated
   failure modes, not a mandatory pool matrix or listener rewrite. count every
   process, child, listener, maintenance and backup/operator connection. quotas
   and retained-backend costs remain provisional until the reachable concurrent
   topology fits the envelope under the capacity specification.
2. `search/admission.py` retains one database-wide expensive-read gate and a
   physical search lease through confirmed backend retirement. browser requests
   reserve it before embedding; background provider work and unrelated
   ordinary/control work retain their existing owners. a snapshot covers complete
   permission/ranking/hydration facts; publication uses a later short transaction.
   no ordinary transaction waits for a provider or the search gate.
3. browser intent waits at its existing client owner for admitted work to finish;
   requests refuse occupied capacity without a server-side queue. do not
   repeatedly preempt that read to make the foreground appear fast. background
   refuses observed local physical-capacity or shared-gate contention without
   waiting. the shared-gate try-lock cannot bypass foreground waiters already
   queued in postgres; there is no cross-process priority before a request reaches
   that gate. existing query owners cancel superseded/disconnected requests;
   cancelled waiters never execute later. no extra durable queue or priority service.
4. `api/search_operation.run_search_operation` remains the http deadline,
   disconnect and cancel/join owner. capacity queue waiting must not spend the
   finite execution allowance; that allowance starts at admitted execution and
   is not reset during the read/result construction. provider work retains its
   owned finite guards; tool/oracle owners retain their enclosing cancellation
   scope. transport ceilings are separate constraints, not execution allowances.
   api115/bff120/browser125 safeguards remain unchanged. an unadmitted busy
   response leaves the current client intent pending, with cancellable backoff
   outside its execution clock. a prefix retains completed pages and its remaining
   allowance; capacity deferral retries the current page, never the prefix.
   real/provider/network failures settle rather than reset that allowance.
5. shortlist/discovery handlers retain a finite attempt read watchdog through
   `search_session_async` and `read_snapshot`'s remaining statement-timeout
   backstop. provider work has its existing finite provider/job owner outside
   admission. `jobs/process_executor.py` retains the existing fresh-child wall
   watchdog, termination/join and supervisor heartbeat/claim ownership. its
   configured wall allowance (default/max 900 seconds) also supplies both
   background read allowances, replacing the failed independent 30-second cap.
   the earlier whole-handler watchdog still wins; this guarantees neither 900
   seconds of computation nor joined cleanup on forced child kill. it is not a
   foreground service promise, and no-wait admission/refund rules are unchanged.
6. cancellation still joins driver work and closes/invalidate-checks the captured
   backend before capacity reuse or publication. retain the scope's fail-closed
   behavior for unconfirmed retirement. a cleanup warning alone must not reject
   an otherwise live completed operation after confirmed retirement; actual
   request cancellation/expiry still wins. cleanup is never abandoned to meet a
   stopwatch. preserve original failure classification during rollback.

**useful completion and queue drain are release gates.** lexical and hybrid
search may wait behind admitted work; simultaneous peak execution is not required.
the chosen admission policy must let both complete usefully while ordinary
reading, local writing and cancellation remain usable. the reviewed watchdog
table must distinguish visible queue waiting from admitted execution and retirement,
plus provider/transport guards. client/bff/platform ceilings must permit useful
completion under that policy without spending execution time on capacity waiting.
no blind timer reset, new protocol, phase telemetry or scheduler is prescribed.
timed-out requests
and retained earlier results do not substitute for useful completion.

choose and record finite watchdog values and a finite qualification observation
window before executing qualification, from measured complete-work costs and
cleanup margin. they are operational safeguards, not new latency targets. do not
silently inherit old phase caps, add an independent shorter computation ceiling,
restart clocks, or use infinite waits. the background allowance explicitly derives
from its existing child owner after an integrated named refresh exhausted 30
seconds; useful completion still needs affected native qualification. if measured
background cost cannot coexist with
successful foreground requests under the chosen serialization policy inside
actual transport ceilings, this synchronous baseline fails: return the concrete
conflict for a design decision before adding preemption, incremental snapshots,
an async search protocol or a feature cut.
preliminary cost measurements also declare a finite diagnostic watchdog before
execution. expiry is censored noncompletion, not a successful latency measurement
or qualification; diagnostic limits do not become product allowances.

only admission refusal may return the existing delayed `RescheduleRequested`
without spending an attempt. admitted computation expiry spends the existing
bounded failure budget and eventually exposes suspension/failure. narrow the
catches in `suggestion_shortlists.py` and `connection_discovery.py`; do not change
generic queue refund semantics. observed contention for a physical search permit
or the advisory gate, before reading starts, is admission refusal. a connection
setup timeout or generic pre-read expiry is not evidence of contention and must
not be refunded merely because its phase says checkout. lost claims, shutdown and unrelated database
errors keep their own meanings. successful publication still atomically rechecks
claim, feed and authority, replaces the complete pool and settles the job. changed
inputs may leave that captured revision dirty; a later complete build must converge.

## retrieval choice: prove the simpler baseline first

qualify exact original-float retrieval on the representative complete corpus,
under the same admission and memory envelope. keep eligibility and scoring in
postgres; return only bounded winning rows. do not raise `_EXACT_MAX` and export
an entire uuid/vector domain into python. bounded output does not establish
bounded database memory: inspect the actual joins, sorts and maintenance demand.

- browser/strict/oracle select nearest chunks from the complete authorized,
  current-ready model domain, using their existing thresholds and deterministic
  chunk tie order.
- suggestions select canonical **reading/chunk rows** independently for each
  original anchor and family, ordered by distance, reading id and chunk id,
  before the existing 400-row cutoff and media grouping. retain all anchors and
  both semantic families. use straightforward sequential queries in one snapshot;
  do not restore the old all-anchor cross-product. an exact chunk cutoff followed
  by reading projection is not equivalent; this boundary belongs to the
  [suggestion retrieval contract](modules/suggestions.md).
- share readiness, calibrated scoring and canonical scope mechanisms where their
  contracts match. a universal truncated-candidate interface is not required.
  preserve proven query-shape repairs and remove duplicate work when doing so
  preserves the proper selection boundary.

the selected exact baseline has completed the bounded native qualification in
[release acceptance](issues/release-search.md). fresh application startup/first
use and warmed resident demand are separate observed scopes; neither proves an
empty operating-system/postgres cache. no cache-cold guarantee is claimed.
ordinary deployed use and public reachability are accepted; concurrent search/
scope use completed without a new oom. [combined query-time headroom](issues/production-database-connection-budgets-implicit.md)
remains unquantified, so this is not an unrestricted-topology memory guarantee.
no additional probe is selected. slower queries still retain snapshots and the
gate longer; future scope changes must account for that cost.

if exact retrieval fails capacity or foreground/background progress, assess the
existing stock original-float access path before requiring normalized-half ivf.
select one qualified implementation, not runtime fallbacks or load-dependent
recall. keep the prior approximation floors if ann is necessary: browser at least
95% of exact-200 qualifying owners and every semantic first-page reference owner;
suggestions overlap at least `ceil(0.9 * min(10, reference_count))` per frozen case,
with every changed item reviewed. preserve semantic-positive restrictive cases,
including `moderate_tolkien`; graph-only success cannot conceal a broken semantic
lane. approximation remains an explicit quality cost, never inferred permission
to shrink anchors, families, thresholds or candidate windows.

## existing work: keep, delete or condition

| disposition | work and reason |
| --- | --- |
| keep | finite pools/control/listeners, async ownership, fresh background children, physical retirement and admission; retained memory and orphaned work remain hazards at any speed |
| keep | canonical readiness/scope/owner/projection query repairs, meaningful duplicate-work removal, atomic publication, provider failures, busy/write uncertainty and current main's authored/capture/annotation contracts |
| delete | hard subsecond hold verdicts and computation-expiry refunds; these reject useful work or hide noncompletion |
| removed from the selected exact path | count-proof routing, multi-domain ann cursor plumbing, half-key frontier/error proof and candidate-only norm `[0.5,2]` restriction. dimension/model and valid finite nonzero-vector checks remain |
| selected package | pinned stock pgvector with exact original-float retrieval, without the normalized-half index or local cancellation patch. retained lifecycle and integrated native proofs keep their recorded source/package identities and limits |
| migration owner | deployed 0329 follows 0328. accepted original-owner preservation, bounded migrator fit and actual production cutover are recorded in release acceptance. historical 0321-after-0320 receipts remain a different lineage; no migration replay is required for documentation closeout |

trade-offs are explicit: serialized work lowers throughput and can lengthen
foreground waits; exact retrieval spends more scan/io time to preserve recall;
fixed suggestion visits and background contention delay ranking freshness;
approximate access can lose candidates; a dependency patch incurs ongoing release
ownership. no trade permits inaccessible evidence, silent semantic loss, lost
writing, permanent hidden failure or memory-limit increases.

## implementation responsibilities

| owner | exclusive responsibility | prerequisite |
| --- | --- | --- |
| a: database capacity | `config.py`, `db/{engine,session,listen}.py`, runtime/worker lifetime wiring and deployment resource settings; freeze physical quotas and control reserve | current topology inventory |
| b: retrieval | `search/semantic.py`, relevant `sources/indexed/scope/project` query changes, `suggestions.py`, indexing/owner helpers, selected 0329/down 0328 and postgres package | frozen exact reference and proper ranking identity |
| c: operation/publication | `search/admission.py`, `api/search_operation.py`, route allowances, `search/service.py`, shortlist/discovery/oracle/tool caller scopes; watchdogs, retry classification and claim-fenced publication | b's measured complete read and a's ownership; agrees timer contract with d |
| d: client/write outcomes | browser search policy/loaders, bff deadlines, existing pending/error presentation and busy/uncertainty consumers; consume main's authored contract | c's reviewed end-to-end allowance; no authored-owner rewrite |
| e: integration | reconcile module/release docs, coordinate migration identity, temporary qualification and release evidence; no duplicate edits to a–d | their reviewed interfaces and acceptance below |

these are implementation responsibilities, not separate delivery prs or a request
to redo completed repairs. the implemented change crosses these boundaries and
must be qualified as one composition.
assign one editor per file for remaining work. source-only old-policy drafts
remain historical until deliberately revised; do not execute them as new acceptance.

## meaningful acceptance and release gates

follow [testing standards](local-rules/testing-standards.md). static verification
uses only `./scripts/test`; retain exactly the existing three manually invoked
search foundation checks.
other cases are temporary in the existing disposable/native workflows, not a new
suite, benchmark campaign or runtime. freeze cases and comparison references
before tuning; record actual waits without manufacturing latency percentiles.

| gate | required outcome |
| --- | --- |
| retrieval quality | frozen name/body/semantic-only/empty cases, global and restrictive library/source/piece scopes, active-model/readiness changes and exclusions. exact baseline matches reference windows/order; ann meets the retained floors. preserve literal evidence, full reading boundaries and real activation. include 401 equal-distance chunks and overlapping readings for suggestion cutoff ties |
| useful progress | full five-anchor, both-family refresh, strict discovery and foreground lexical/hybrid search complete through their real owners. heavy work may queue and serialize; reading, local writing, sync and stop controls remain usable. the finite queue drains, and every active due feed publishes the settled revision within the predeclared observation window after competing jobs/mutations drain. timed-out reads, perpetual deferral and old publications fail this gate |
| lifecycle/failure | supersession/disconnect and owned timeout retire real backends before reuse; subsequent work succeeds. contention alone refunds; compute expiry consumes attempts. failed/lost-claim work preserves the old publication; authority withdrawal removes access; revised inputs converge; listener reconnect rereads truth. unknown retirement never publishes or releases its physical allowance |
| writing | local authored commits survive busy/disconnect and retry original sequence/bytes. server-owned writes preserve their own identity and uncertainty before dispatch and after a committed write whose response fails; no false refusal or lost intent |
| actual capacity | current candidate on actual 2 gib ram topology with production host swap enabled, postgres512mib and all service leaves no-swap at their real limits; cold then warmed readers/listeners, two clients, all normal services present even idle, authored buffers, reachable maintenance/autoanalyze and verified backup under the declared serialization policy. count retained memory and host swap use/pressure; preserve physical reserves. zero new oom/kill, database recovery, process crash or lost claims; useful work completes, the finite queue drains and owned resources retire. a larger-host/component pass does not close this gate |
| integration/release | qualify 0329 after main 0328 plus the real deployed 0317 upgrade route, verified backup/value preservation, exact source/image/schema/wire/client identities, paired actual phone search/reader and successful continuation of writing. historical 0321 receipts do not qualify this 0329 lineage |

brave import/metadata remains blocked until entitlement permits real completion;
no fake-provider pass or unrelated oracle success closes it. review the known
blake locator and separate verse issue without silently dropping affected citation
semantics; generation success does not prove navigable citations. personal
x-capture eligibility/attribution has its own canonical-reading repair and focused
admitted retrieval/activation proof in
[pr872](https://github.com/NielsdaWheelz/nexus-web/pull/872); a common exact vector
reader alone did not establish that oracle lane's coverage. existing explicit
screen-reader/unrestricted-worker deferrals remain named in
[release-search](issues/release-search.md), not broadened by this revision.

release stays with the existing controller and a separate explicit release
instruction. target an announced interruption of 30 minutes, including stopped
writers, verified backup, migrations and paired restart. on 2026-10-30 the owner
authorized safe forward completion if it takes longer; this is no migration-abort
or rollback deadline. do not
mix workers or restore the known-broken predecessor as a claimed repair. selected
image/patch requirements and recovery steps must be reconciled in release-search
before activation. preserve historical snapshots/outputs; delete temporary cases
only after final qualification. the pr records proof, limitations, net authored
lines and deletions; issue files close only on their own proved criteria.
