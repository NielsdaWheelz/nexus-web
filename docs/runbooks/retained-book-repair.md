# retained-book maintenance

status: the [usable fdd release](../releases/2026-10-15-nexus.md), schema 0287
and wire 2, is accepted; the merge freeze has ended. retained-book qualification,
live applies and repaired-book consumer acceptance remain pending. previous
0278 and partial 0283 runs prove only their recorded candidates. the partial
0283 read-only bracket closed with all 96 tables and 3,272,528 rows unchanged;
that does not complete the 465 held reader inspections. freeze exact identities
before each remaining phase.
contract: [book-repair plan](../book-repair-plan.md). this runbook owns execution;
the plan owns scope, allowed changes, proofs and acceptance.

## ownership and evidence

the book coordinator owns the fresh backup and book production writes, as
authorized on 2026-10-15. the backup correction requires no application rollout.
the reader, contributor and
recovery lanes inspect independently; they do not compete for release or
device control. recheck settled runtime/device identities before live repair
acceptance. no resize, reboot or brave calls.

private campaign root:
`/Users/nnandal/Documents/code/nexus-web-campaign-artifacts/2026-10-14/book-repair`.
`progress.json` names current identities and work. retain original receipts;
new attempts get new paths. search explicit metadata files or parse named fields;
never recursively print private source/proposal files to find hashes.

freeze source, image, schema, database identity (`name:system_identifier`),
script hashes, scopes and measured limits before each phase. a maintenance
image and deployed api/worker images have distinct identities. the api image's
allocator settings do not qualify a normal worker's memory behavior.

## restore and capability setup

1. use the [backup owner](../../deployment.md#fresh-maintenance-backups) with a
   new explicit archive key and a fresh local state directory. keep the actual
   runtime source sha; it is provenance, not the backup's identity. bind the
   reviewed operator commit/file hash separately from its dependency image and
   deployed source. preserve the local receipt, adjacent remote manifest,
   archive hash, terminal state and invocation interval. a consistent dump
   with active writers has no operator-
   known exact acquisition time. replaying its receipt does not create a fresh
   cutoff; a later snapshot needs a separately identified backup.
2. download and verify the entire archive. restore it into an isolated postgres
   cluster with the same engine/extensions, using `pg_restore --exit-on-error
   --single-transaction`. record actual restore success separately from archive
   verification. for the current 0278 backup, replay main's 0279–0287 through
   the canonical migration owner before taking qualification baselines. record
   actual revision and migration effects; the cleanup owner's rehearsal does
   not substitute for this candidate's proof. the accepted, reconciled 0283
   clone can continue through 0284–0287 without another restore. prove the exact
   summary/job rewrite, media-column removals, teardown-payload rewrite, ledger
   drop and three new suggestions tables; preserve the current-summary identity
   set, not merely its count. refresh select-only grants for the new tables and
   take the baseline from the actual relation inventory. restore each lane when
   ready to qualify it; retire superseded clones only after reconciliation and preserved
   receipts. keep the active lane, backup, cluster and volume. the extra restore
   time avoids retaining three full copies. repair code adds no migration.
3. provision one clone inspection login: no superuser, role creation, database
   creation, replication, bypassrls or membership; existing public-table select
   and identity-function execution only. default its transactions to read-only.
   verify privileges, schema and exact database identity through the real
   application connection path. retain a separate write capability for apply.
   local rehearsal processes must explicitly select the image identity with
   `NEXUS_RUNTIME_IDENTITY_FILE=/app/runtime-identity.json`.
4. reader/contributor inspection gets original-source storage inputs and no
   provider keys. those paths only read storage. portrait gets the separate
   rehearsal bucket and its scoped credential, verified original source, and
   its own database/queue. only indexing receives the embedding credential.

## inspect and rehearse

run one reader inspect/apply per immutable operator container, sequentially:
1 gib memory, no swap, one cpu, 128 pids, non-root, read-only root and a private
512 mib parser tmpfs. use the qualified 180-second whole-invocation timeout
with five-second kill grace. persist the container id before start; retain
actual limits, counters, output and stopped-process evidence before removal.
whitelist inspection fields; never record credentialed docker `Config.Env`.
use a one-connection database pool, zero overflow and a 30-second statement
timeout. the normal engine lock timeout is 10s; maintenance owners set 2s in
their transactions. verify both through the final artifact, without the removed
lock-timeout setting. an attach timeout does not terminate the container.

```text
python -m nexus.ops.reader_navigation_repair inspect --media-id <id>
python -m nexus.ops.reader_navigation_repair apply --media-id <id> --generation <n> --inspection-digest <sha256>
```

take protected-state snapshots around read-only inspection. account for every
frozen id, including refusals. review every complete proposal before selecting
apply. rehearse the selected set, transactional refusal/uncertainty controls,
full protected-state comparison and fresh unchanged inspection/apply. keep
failed proofs and missing results visible.
old reviewed metadata may be compared only after 0279's exact recursive
Presence-to-nullable conversion; reader fields were already snake_case.
require fresh complete proposals and hashes from the current image. any other
delta needs semantic review. use fresh protected-state baselines after 0281;
its removed reader timestamps make old database hashes inapplicable.
every selected item gets full apply/persisted-projection verification, fresh
inspection and an unchanged apply using its fresh fence. prove old-fence replay
rejection on one changed epub and one changed article; record those exact ids.
that shared rejection path does not need repetition for every book. this trades
per-book replay coverage for fewer invocations without reducing per-item state
or idempotence checks.
for articles, distinguish a publication change from an index-input change.
equal complete index-block projections must preserve all index state, jobs,
summaries, claims, connections and retrievals; no worker is required. prove a
changed note-region projection still admits one ordinary reindex job. do not
admit that worker without reviewing its actual saved-reference effects.
if a candidate fails this contract, retain its interrupted-run evidence,
reconcile every excluded row before qualifying the correction. reseed the
disposable reader database only if its state cannot supply a proved clean
baseline; preserve any other lane databases.
the full portrait clone snapshot uses a separately reviewed 90-second statement
budget, with the same 180-second outer deadline and read-only capability. its
30-second sorted-hash attempt and 180-second primary-key-order attempt failed;
that historical restored sorted-hash query passed in 84.6 seconds across 96
tables. the final artifact needs its own measured snapshot over the discovered
current inventory.
this exception does not change reader inspect/apply or parser limits. after a
timeout, confirm both the container and its database backend have stopped.
fault injection is clone-only; remove its fixtures before the selected apply
set. every row excluded from global hashes needs its own complete permitted-
change and raw-identity proof.
after 0287, a changed reader or credit apply and a fresh diagnosed recovery
admission each advance `suggestion_inputs.revision` by exactly one in the same
transaction; its other fields stay exact. unchanged repairs, refusals, rollbacks
and landed-successor replays advance zero. capture the full singleton separately
from reusable item snapshots and bind its exact row hash to the global digest.
compare feeds and shortlists exactly with their workers stopped. account for
actual committed owner calls in fault/positive fixtures and selected-set totals;
do not reset the counter or hide its table from the proof.

contributor preview uses the exact shipped script supplied read-only. audit
verified opf observations and actual credits for the 241 surviving ids; account
for the four later deletions offline. merged #613 supplies the preview fence;
only a freshly proved correction permits a credit write.

portrait uses the unmodified deployed worker image and its normal 448 mib,
no-swap, disk-backed parser storage and 900-second child budget. export copied
queue fixtures before isolating them. normal admission and real worker turns
prove source and index separately. follow ordinary queue order through only
the explicit required jobs; record unconsumed follow-on work. metadata remains
separate while brave is unavailable.
use the current source owner's explicit diagnosed stored-epub admission, with
exact creator/attempt/source fences. the removed processing-recovery command
and mutation-id protocol are historical. replay the expected attempt's existing
deterministic successor; prove no extra job/history and distinguish replay from
a forbidden new admission over published content. ordinary archive limits stay.

## live application and uncertainty

take and verify a fresh pre-apply backup after rehearsal; report whether that
newest archive was actually restored. recheck runtime, schema, source and
item fences. inventory affected downloads, sync progress and close affected
readers for each small batch. defer an unsynced title.
bind actual api/web/phone identities after the canonical release; old consumer
receipts do not qualify the new wire. use `X-Nexus-Wire: 2` and the current
snake-case nullable request/response contract in live probes.

apply only reviewed, freshly fenced proposals. verify persisted projection,
protected identities, generation and current consumers. remove/redownload only
affected copies; prove old-generation refusal, new navigation and jump/return
without implicit progress changes. keep legitimate concurrent writes distinct
from repair effects.

lost output or interrupted apply is unknown. stop further writes, prove the
exact container and its database backend stopped, then compare source,
generation, full approved projection and protected identities. only proved
non-commit permits another freshly fenced attempt. never infer success from
generation alone or blindly retry.

## closure

every selected id ends unchanged, verified or explicitly unresolved with its
evidence and next action. unknown/not-run acceptance prevents closure. retain
open tickets; delete resolved ones and update the register. preserve receipts
when deleting temporary tests, fixtures and harnesses after final acceptance.
run `./scripts/test` after deletion. clean only owned containers, volumes,
tunnels, secret copies, branches and worktrees after merge/ownership proof.
restoring a backup is an incident operation that discards later writes; it
requires stopped writers and an explicit recovery decision.
