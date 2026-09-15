# restoration migration audit

source: `98a8b63bf0e72da5cb7e82ba2a9098716de58c84`.
audit date: 2026-09-14. findings are source review, not executed migration evidence.
the exact restored source has one linear head, **db0229**, not db0228.

## boundary

migration source remains byte-identical to the coherent source. no production
resource was contacted. the table's proof references describe the historical
portfolio at 98a8b63bf0; #254 removes those integration suites. they are evidence
of prior design, not current commands or release qualification.

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

## historical populated rehearsal

before #254 merged, the added full-chain test ran on `dev-server` at
`eb07b3851085a060bade1e282ce7683e65b0d3b0`, run `5b88cb536d729ae9`.
its one frozen db0215 dataset contained user/library/note content, source objects,
epub navigation and cursor, upload attempts, transcript audits, terminal chat,
and metadata history. one uninterrupted upgrade reached db0229. it checked
retained content and source digests, cursor/publication transitions, truthful
import history, and the intentional chat/audit/date losses. its cursor fault
failed at the preservation assertion; the intact chain passed in 152.907 s.
aggregate owned peak memory was 1,029 mib.

this synthetic dataset did not cover every possible production state. #254's
cleanup removes the proof and its real-service harness. the only automated
migration check now is the single-head graph check in `./scripts/test`. it does
not execute ddl or establish data preservation. a populated rehearsal, backup,
capacity and recovery review remain prerequisites for later release; do not
reintroduce a second automated gate in this restoration.

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
  contracts and migration-container envelope; conduct separately authorized immutable image publication, frontend staging,
  device checks and public smoke;
- retain backups and recovery evidence under a separate operator decision.

deployment instructions explicitly make recovery forward-only after data
mutation/backend activation. the desired source tree is not a promise that its
destructive migrations are harmless or that old application artifacts can run
against db0229.

## resolved runbook discrepancy

`deployment.md` now correctly names reader-publication revision 0219 instead of
0216. the release-preparation ticket is closed; migration source is unchanged.

## fresh production-snapshot rehearsal after merge

on 2026-09-15, `dev-server` captured the live db0215 database from
`nexus-api-worker` using the exact postgres image
`pgvector/pgvector@sha256:7f5681e45237acdf546cf7cdc0dfc0ed7752ede857fda6e54f6ea21b936f8742`.
the 1,845,051,825-byte custom archive has sha256
`987055772dee146671df15b5cc2aec3ab608fcc9dc2ce7fcc9110f6620b7e467`.
a complete isolated restore succeeded; all 272 referenced source objects
(534,214,739 bytes) were copied with stable observed etags and verified sizes,
signatures and sha256 values. the isolated migration credential cannot write
the mirrored object store. this online database/object capture is not atomic.

the exact merged candidate `634206213c50f9cdfcecfae8c8f7efc331ddec48`, api image
`ghcr.io/nielsdawheelz/nexus-api@sha256:032713a74d7b40281c52b72e011836c4eef2c6a2d78ff8afd29d94495003e8d8`,
failed at 0227 after 43.129 seconds: `E_LLM_BAD_REQUEST` was absent from the
import history catalog. two failed epub source attempts from 2026-07-22 carry
this historical outcome. the shared history vocabulary must retain that exact
code through baseline storage, browser decoding and reader explanation;
rewriting it to a generic failure or bypassing migration admission loses meaning.
the migration files themselves remain unchanged.

the observed migration cgroup peak was 484,134,912 bytes under the 512 mib cap,
with zero observed oom events and no oom kill. this is failed-run capacity
evidence, not a passing migration proof. 0221's autocommit retained source
digests while the revision returned to 0220. a corrected candidate must replay
from a fresh restore of the original archive. detailed private logs and retained
content fingerprints remain under `/home/niels/.cache/nexus-release-255` on
`dev-server`; these are operator records, not an additional automated test gate.

production application identity, database revision and custom domain were not
changed by this rehearsal. irreversible loss acceptance, exact candidate
qualification and the stopped-writer production backup remain release
prerequisites.
