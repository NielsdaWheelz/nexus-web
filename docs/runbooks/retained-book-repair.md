# retained-book maintenance

status: rehearsal in progress; production repair NOT_RUN.
contract: [book-repair plan](../book-repair-plan.md). this runbook owns execution;
the plan owns scope, allowed changes, proofs and acceptance.

## ownership and evidence

one coordinator owns production writes. the reader, contributor and recovery
lanes inspect independently; they do not compete for release or device control.
wait for the current release owner to hand off settled runtime/device identities
before live consumer acceptance. no resize, reboot or brave calls.

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

1. use the existing backup cli for an unused actual candidate key. preserve its
   local receipt, adjacent remote manifest, archive hash, terminal state and
   invocation interval. a consistent dump with active writers has no operator-
   known exact acquisition time. replaying its receipt does not create a fresh
   cutoff; a later snapshot needs a separately identified backup.
2. download and verify the entire archive. restore it into an isolated postgres
   cluster with the same engine/extensions, using `pg_restore --exit-on-error
   --single-transaction`. record actual restore success separately from archive
   verification. run no migrations. create the separate portrait database from
   that restored database before consumers connect.
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
use a one-connection database pool, zero overflow, 30-second statement timeout
and two-second lock timeout. an attach timeout does not terminate the container.

```text
python -m nexus.ops.reader_navigation_repair inspect --media-id <id>
python -m nexus.ops.reader_navigation_repair apply --media-id <id> --generation <n> --inspection-digest <sha256>
```

take protected-state snapshots around read-only inspection. account for every
frozen id, including refusals. review every complete proposal before selecting
apply. rehearse the selected set, transactional refusal/uncertainty controls,
full protected-state comparison and fresh unchanged inspection/apply. keep
failed proofs and missing results visible.
every selected item gets full apply/persisted-projection verification, fresh
inspection and an unchanged apply using its fresh fence. prove old-fence replay
rejection on one changed epub and one changed article; record those exact ids.
that shared rejection path does not need repetition for every book. this trades
per-book replay coverage for fewer invocations without reducing per-item state
or idempotence checks.
the full portrait clone snapshot uses a separately reviewed 90-second statement
budget, with the same 180-second outer deadline and read-only capability. its
30-second sorted-hash attempt and 180-second primary-key-order attempt failed;
the restored sorted-hash query passed in 84.6 seconds across all 96 tables.
this exception does not change reader inspect/apply or parser limits. after a
timeout, confirm both the container and its database backend have stopped.
fault injection is clone-only; remove its fixtures before the selected apply
set. every row excluded from global hashes needs its own complete permitted-
change and raw-identity proof.

contributor preview uses the exact shipped script supplied read-only. audit
verified opf observations and actual credits for all 245 ids. only a real
correction justifies the conditional preview-fence implementation and write.

portrait uses the unmodified deployed worker image and its normal 448 mib,
no-swap, disk-backed parser storage and 900-second child budget. export copied
queue fixtures before isolating them. normal admission and real worker turns
prove source and index separately. follow ordinary queue order through only
the explicit required jobs; record unconsumed follow-on work. metadata remains
separate while brave is unavailable.

## live application and uncertainty

take and verify a fresh pre-apply backup after rehearsal; report whether that
newest archive was actually restored. recheck runtime, schema, source and
item fences. inventory affected downloads, sync progress and close affected
readers for each small batch. defer an unsynced title.

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
