# restoration migration audit

source: `98a8b63bf0e72da5cb7e82ba2a9098716de58c84`.
audit date: 2026-09-14. findings are source review, not executed migration evidence.
the exact restored source has one linear head, **db0229**, not db0228.

## boundary

the original instruction authorized read-only devbox audit. after the user moved
all work to the macbook, no further ssh commands ran. the remote audit created no
files, databases, containers, or other resources. implementation is confined to
`/Users/nnandal/Documents/code/nexus-web-restoration`.

no production resource was read or changed. no migration, test, service, image
build/publication, deployment, cleanup, or worker qualification ran in this audit.

## migration ledger

| revision | actual effect | admission / irreversible hazard | existing proof |
| --- | --- | --- | --- |
| 0216 | creates `agent_turns`; deletes `llm_calls` owned by `media_enrichment`; removes that old owner kind; sets metadata-job capacity wait index to zero and maximum attempts to two | metadata call history is deliberately lost, including any such row regardless of outcome; stopped/drained writers are required by the release contract | no dedicated populated 0216 proof was found; new restoration chain includes both metadata and chat call history but asserts their final aggregate loss after 0224 |
| 0217 | canonicalizes tool records, typed events, retained chat coordination fingerprints/results, and retrieval scope | select-only preflight rejects nonterminal chat, active idea builds, unsupported tool variants, malformed/ambiguous events, contradictory identifiers or completed-step fingerprints; irreversible identity cutover; pinned `llm_tools` import required | no dedicated populated 0217 proof was found; new restoration chain crosses its preflight with a terminal legacy `app_search` record, which 0224 later removes; complex historical event/journal variants remain outside the chain's scope |
| 0218 | adds podcast subscription/backfill notification functions and triggers | emits only subscription uuid; authorization remains in reread; no data deletion | `test_podcast_subscription_lifecycle_events.py` |
| 0219 | adds one current publication row at generation 1 for each ready pdf/epub/web article | no existing data removal; application rollback writing newly ready documents can omit publications and needs the documented preflight | `test_reader_publications_migration.py` starts populated 0215 but stops at 0219 |
| 0220 | adds upload sessions/destinations and nullable `media_file.source_sha256` | additive schema step; source digest remains incomplete until 0221 | `test_document_import_reliability_migration.py` |
| 0221 | streams every stored pdf/epub source needing a digest, checks object length/signature, persists sha256, makes digest nonnull, drops old signed-upload expiry, adds cleanup payload owner kind | **autocommit** makes successful per-row backfill durable even when a later source fails; revision stays 0220 on that failure; final preflight rejects active source attempts not bound to exactly one valid job; requires readable source objects, storage credentials, correct timeouts, and stopped writers | `test_0220_0221_backfill_is_resumable_fail_closed_and_hard_contracts_schema` exercises real postgres/minio, missing/changed sources, resumability, exact old-job admission and final constraints |
| 0222 | replaces pdf-page-span cascading media fk with a normal fk | application must explicitly delete spans before their media; does not remove existing rows | `test_pdf_page_text_span_delete_ownership_migration.py` |
| 0223 | deletes transcript request audit rows with outcome `enqueue_failed`; removes the outcome from the allowed set | intentional irreversible audit loss, not a repair/backfill of these rows | `test_transcript_admission_hard_cutover_migration.py` verifies retained outcomes and rejection of the retired outcome |
| 0224 | replaces generation ledger; deletes **all conversations, messages, chat runs, chat events, tool/retrieval history, generation calls, old agent turns and token-budget records**, plus chat-linked artifact and resource closure; retains other domain content with before/after preservation manifests; reclassifies known historical dossier/oracle failure events | irreversible product-history reset; refuses nonterminal calls/turns/chat/tools, undrained generation jobs, unknown dispatches, unterminated artifact/learn work, malformed oracle failure histories, unclassified fk/polymorphic children and conflicting retained closure; only narrowly classified dead synapse/enrichment jobs may cross | `test_generation_backends_cutover.py` has an extensive populated 0223 reset/preservation proof and refusal cases; `test_generation_backends_cutover_admission.py` proves job/state admission |
| 0225 | locks chat/call/job tables and validates the shared-agent boundary | refuses queued/running chat, unfinished generations and pending/running/failed generation jobs; preserves historical data otherwise; requires stopped writers | `test_shared_agent_kernel_cutover.py` |
| 0226 | installs sole admission-receipt ownership; drops chat idempotency key/payload hash and `rate_limit_inflight` | refuses **any** chat history at 0225 and **any running background job**; no backfill can establish new command identities; run immediately after 0224/0225 while writers remain stopped | `test_chat_admission_recovery_migration.py` |
| 0227 | adds import history tables and job execution id, records one history baseline per extant upload session/source attempt | before ddl, rejects unsupported source statuses, failed attempts without codes and uncatalogued codes; baseline time is recording time, not invented past failure time | `test_imports_history_migration.py` |
| 0228 | replaces epub navigation with semantic source structure; repairs accepted epub/web cursors and stored exact references; updates web block structure; increments publication generations | deletes/recreates epub navigation rows while preserving authored toc identities; refuses missing source metadata, changed canonical text, unidentifiable authored sections, ambiguous or invalid cursor loci, unresolved exact links or web blocks; rollback is unsupported | `test_reader_structure_migration.py` and `test_web_reader_cursor_migration.py` cover preservation, ambiguous/refused repair, and retry |
| 0229 | adds original publication date, edition date and edition isbn; drops `media.published_date`; advances collection revisions | **all old mixed publication dates are discarded without copying**; new fields start null; exclusive locks plus source/podcast/metadata/uncertain-work drain prevent old writers crossing the cut | `test_original_publication_dates.py` |

## new proof

new file:
`python/tests/migrations/test_pre_bridge_restoration_upgrade.py`.

canonical node:
`pytest:python/tests/migrations/test_pre_bridge_restoration_upgrade.py::test_populated_0215_reaches_head_preserving_content_and_declaring_history_loss`.

one frozen db0215 dataset contains a user, library/membership/entry, valid note,
ready epub and podcast, synthetic epub source object with matching canonical
fragment/navigation/cursor, completed upload source attempt, two transcript
audit outcomes, terminal chat/messages/tool call, metadata/chat call records,
and completed metadata work. every row originates at 0215. one `upgrade(head)`
reaches 0229 without inserting newer-schema data or changing rows to force
admission. intermediate upgrade checkpoints were deliberately rejected because
they would add transaction boundaries absent from the production invocation.

the oracle checks:

- byte-equivalent json row content for populated user/library/note/fragment
  families before and after the entire chain;
- unchanged retained media except the explicitly removed/replacement date fields;
- unchanged original object bytes and independently computed source digest;
- preserved accepted cursor location and revision advancement, authored toc
  identity, removal of the old spine identity, and publication generation;
- one truthful import baseline for the retained source attempt;
- intentional old metadata/chat/audit history removal and publication-date loss;
- removal of old chat authority columns and anonymous inflight counter;
- exact db0229 head and complete linear 0215-to-0229 revision list.

no existing fixture/helper was changed. the test intentionally does not repeat
every detailed refusal permutation already owned by the individual migration
proofs. it adds their missing composition boundary. it does not use production
data, impersonate a database connection, or mock object storage.

status: written and manually reviewed only; **not run**. the canonical proof is
registered in `testdata/proofs.json` under `migration-compatibility`. its sole
fault entry, `restoration-chain-cursor-migration-bypass`, reuses the existing
product-only `reader-structure-cursor-migration-bypass.patch` without creating a
second patch file or changing that fault's other owner. it leaves the old cursor
address unchanged while advancing its revision, so the new full-chain proof's
explicit accepted-locus assertion must fail.

base-main lacks the post-0215 graph, so a base failure before reaching the
contract cannot establish useful sensitivity. the manifest therefore uses the
existing `coherent-fault` exception for this single exact python owner, with
the owner digest computed by repository helper
`python_exact_proof_owner_sha256`:
`3220a49d7acc607ef27fe51e64ff1453b01e711ac37c545d676550d8c4cd441c`.
proof formatting or other owner edits require a new reviewed digest. the patch
sha256 is `5ee953d9e5cce070c706cce42a65697e6f8c118da76621920c5df40ce703cab1`.
the aggregate ownership pin includes the new canonical proof. this is a
registered prospective witness, not observed red/green evidence; do not weaken the controller's admission rules to obtain a verdict.

## repository-owned execution

`./scripts/test` is the locked `uv run --frozen --no-sync python -m
nexus_test_control` launcher. migration capability owns `tests/migrations` and
is required by `pr`/`full`. a focused `changed` request names the proof but may
defer it to `pr`; a deferred selection is not a migration pass.

`empty_migration_database_url` validates the controller-owned migration database,
resets only its public schema and sets `database_url` only inside the fixture.
real postgres must match production's version/extensions. controller-owned
minio provides the source objects; isolated objects/databases are cleaned by
the existing resource ownership rules.

the existing `test_supported_upgrade.py` proves empty database to head only.
the new chain must run in addition to, not instead of, the detailed migration
portfolio. exact pr proof uses the repository controller's exact base input
and same-run sensitivity. raw alembic/pytest invocation is not a workflow verdict.

## historical capacity evidence

the earlier devbox read-only snapshot was:

- root filesystem 150g total, 141g used, 2.8g available (99%);
- memory 7.6gi total, 1.9gi available; swap 4gi total, 2gi in use;
- docker images 12.71gb, 6.32gb reported reclaimable;
- docker build cache 6.396gb total, 5.039gb private; 132 inactive records;
- rootless engine was the selected builder; default rootful socket was absent;
- active local volumes totaled 1.32gb and were not reclaimable.

current-main controller required 8,192 mib free for heavy admission. the existing
`docs/tickets/devbox-buildkit-cache-retention.md` records the same unresolved
builder-cache ownership leak and explicitly says operator-wide pruning is not
an acceptable ownership fix. the later user-authorized cleanup is recorded in
[the restoration specification](pre-243-product-restoration.md). moving a
test checkout on that filesystem cannot create disk capacity, and a tmpfs would
consume the already-constrained memory. these are historical observations only;
the devbox is the authoritative validation host. source and git work remain on
the macbook.

## later production release requirements

this pr does not authorize execution of any item below:

- independently establish the actual live starting schema and current immutable
  application identities at release time;
- explicitly accept/dispose the listed chat/audit/generation/date history losses;
- settle old browser recovery commands and uncertain provider/journal effects;
- stop admissions and prove all api/worker writers stopped; do not run the old
  app between 0224 and 0226;
- verify source-object readability, sha256 backfill capacity/time and failure
  recovery; inspect recorded import outcomes and reader loci before mutation;
- create and verify the durable stopped-writer backup and follow the immutable
  release protocol; the 0221 autocommit boundary rules out ordinary transactional
  rollback of the whole chain;
- qualify the exact target artifact's memory, pinned provider/tools, android
  contracts and migration-container envelope; conduct the required exact release
  proof, immutable image publication, frontend staging and public smoke;
- retain backups and recovery evidence under a separate operator decision.

deployment instructions explicitly make recovery forward-only after data
mutation/backend activation. the desired source tree is not a promise that its
destructive migrations are harmless or that old application artifacts can run
against db0229.

## unresolved release-documentation issue

`deployment.md:486` calls the reader-publication migration 0216, but the restored
catalog places it at 0219. the correction is recorded in
[its release-preparation ticket](../tickets/restored-reader-publication-runbook-revision.md).
no migration source is changed by this restoration.
