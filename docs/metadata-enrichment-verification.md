# metadata enrichment verification

status: local metadata behavior GREEN; final native delivery NOT_READY;
metadata's genuine bibliographic cases NOT_RUN. observed 2026-10-03 utc on `feature/metadata-enrichment`, based on
`a494f743eb402b0cbb6069066fca4143b24036f0`. no production deployment or repair.
verified metadata implementation commit:
`603c0e0c1d9b00a2f992d468f2204a2be503c36c`.

## environment and boundaries

isolated worktree `nexus-web-metadata`; frozen dependencies; real postgres,
minio, api, auth verification, queue, worker, journal, generation ledger and next
browser. only external jwks/provider transports and deliberate browser transport
failures were controlled. those peers establish no native capability or
bibliographic truth. disposable proof sources remain uncommitted until final
native/research acceptance; they are not a permanent suite.

## red, green, refactor

the initial composed submission returned 404 at the new metadata route. source
inspection later failed because `provider` was absent from the actual detail
response. domain, contributor, epub and retention checks exposed the old
contracts before their owners implemented/refactored the replacements.
an actual podcast ingestion/research journey then showed `updated: description`
while retained source notes masked the accepted text. direct bibliographic-field
rendering produced GREEN without changing api or source data.

| boundary | final local observation |
|---|---|
| api / postgres / queue / worker / ledger | 20 composed checks GREEN; replay and concurrent admission, null preservation, partial/unchanged publication, no findings, invalid output, stale source, lost claim, access revocation, bounded unicode input and scheduled retry |
| publication recovery | crash after durable completed journal but before publication replays locally; crash after publication but before acknowledgement reuses outcome without restamping; one controlled provider call |
| domain / context | 11 checks GREEN; closed required schema, valid precision/isbn/roles/handles, complete credit input, normalized excerpt and whole 32,768-byte budget |
| contributors / epub | exact identity binding and prevalidation; role-refined epub2/3 parsing; actual minio preview/apply; mixed-source/manual preservation; ambiguous and replaced-source repairs skipped; reader/stamp unchanged |
| rss source replay | three composed ingest/queue/worker checks GREEN; changed bibliography and a→b→a enqueue; identical feed preserves enrichment; unknown source initializes once; author/full-notes changes fence publication; alias identity remains independent |
| retention / capability | ordinary pruning retains both metadata terminal states; ineligible source status blocks fresh research while preserving confirmation of a pending admission intent |
| cutover | fresh 0252→0253 upgrades and negative unresolved-work rejection; settled legacy metadata jobs retired; exact row digests preserve bibliography, credits, unrelated errors, ordinary jobs and controlled generation/model-turn/credential evidence |
| notification | actual postgres listen receives insertion, journal, terminal and deletion changes; heartbeat-only updates stay quiet |
| static | final `./scripts/test` passes; generated wire is current, retired quota states absent, exactly one local migration head: 0253 |

commands used disposable `.tmp/metadata_e2e.py`,
`.tmp/metadata_domain_check.py`, `.tmp/podcast_metadata_proof.py`, actual epub
repair cli proofs and `.tmp/migration_cutover_proof.py`; `PYTHONPATH=python
python/.venv/bin/python` ran the root proofs. alembic ran from `migrations` with
`../python/.venv/bin/alembic upgrade 0253` against `metadata_proof_cutover`.
migration sha256:
`53a8e60656e029b21d2ce8f053ded32b881cb7674fa3961fddc2c4b690ecfe2e`.
the added source fixture initially reused a unique canonical url; correcting the
fixture to identify each item produced the final 20-check green run.

## browser observations

actual authenticated browser → bff → api → worker → database journeys passed:

- pane and overlay share one stream; later automatic jobs remain observable
  after terminal status. closing/minimizing detaches observation, not work.
- partial output retains 1952 with `first publication unverified; kept 1952`;
  all-null output says `no metadata found` without changing reading availability.
- lost 202 confirmation reuses the identical mutation/body even after the source
  becomes ineligible; no fresh admission is substituted.
- detail-read loss keeps old facts; `reload metadata` rereads without an
  enrichment post. disconnect/reconnect remains distinct from job failure.
- 360px and enlarged text retain long title, credits, publisher and description
  without horizontal overflow; one polite outcome announcement.
- missed title a→b→a keeps the exact paragraph nodes and scroll 500 after two
  navigation reads and one content read. same-generation metadata needs only
  navigation. equal-length changed source reloads through the reader owner;
  an interleaved source version rejects refresh, then succeeds on explicit reread.
- source provider/id are exact; identical urls appear once, distinct requested
  and canonical urls use accurate labels; absent provider says `not recorded`.
  closing returns focus to the exact invoking button.
- podcast research displays its accepted neutral description. a later title
  publication updates the library row while preserving its text filter and sort;
  source notes remain independently stored.
- controlled lost terminal displays `execution unresolved; retry unavailable`,
  keeps stored publication/readability, and stamps no success.

representative operation ids: lost-response confirmation
`57478d73-7c0b-4315-b77b-6ff61b9e7bda`; hidden title publications
`5e862d64-128c-4702-b8a3-7f43b0e8980a` /
`da1e2950-52d9-4807-80e8-b859c2d3c19f`; uncertainty
`82cd034b-54dc-40c6-bee6-91daa2c347f0`; podcast description
`1ef659fc-4083-4762-923e-046d171d822d` and library refresh
`fcf632fc-d63f-45aa-83f3-c616cce027ed`. clean browser sessions recorded no page
errors. the earlier map-css exception did not reproduce without module hot
reloads; positive track measurement was 16px / 784px. unrelated find-toolbar
collapse is retained in its [ticket](tickets/reader-find-preview-collapses-toolbar-on-query-replace.md).

## remaining acceptance

the installed candidate's genuine public `execute_generation` receipt now proves
personal `gpt-6-luna`/`xhigh`, closed strict json and useful results from all four
actual tools. historical receipt path `/tmp/nexus-native-research.json`, generation
`73e1c192-e2a8-4171-b47d-8b15fbdcbedb`; the matching stock `0.160.0` rollout
confirms actual model/effort and only declared callbacks. installed nexus files
match adapter `c087faba0529095a076e83b559774a510b513dab`; module origins are
site-packages, without source overlays. candidate actual-postgres
SIGKILL/cold-reclaim recovery also passed
with original terminal/usage and zero catalog/provider calls. these are separate
proofs: genuine research and controlled recovery faults. that receipt path now
contains the newer generation below; the earlier observation is historical.
neither establishes
final installed metadata acceptance; the recovery probe uses
`metadata_enrichment` / `native-proof`. metadata still needs its actual
`enrich_metadata` / `codex/metadata` recovery with frozen inputs and publication
fences after source, credits or access change.

new installed candidate independently reviewed on 2026-10-03 utc: adapter
`d108c085411f1ceacba31422f472e973e9168886`, committed frozen lock sha256
`13827ea453e7a3332a8bae86fee62da50e0a4d554e6c41e4ac1803a18377172a`,
provider `98913f35ab4c9bef2af85d90fd6e4bed747bd64c`, kernel
`b91a9e41269ec721ed0d7403f2baaec30cb6764e`, tools
`2adb9790fc7a54de5342effaca9391c2f3d24ff9`. installed package files byte-match
those git objects; origins/direct-url metadata confirm noneditable installation.
generation `8c5f4732-2e52-49dd-8d36-765e71e7205a` receipt sha256
`4fd98492134958fc702c69735664445add7bdae94ad9677ac350bfa33c9164e7`.
the original stock rollout independently confirms actual luna/xhigh, all four
declarations, original callback arguments/replies and final text. rollout sha256
`e24ad07bf232057afa90b7214061e82b4ec6d09973ba94e42943e2b2dd6ac101`.
strict schema comes from original recorded `turn/start`; stock's rollout omits
that field. all four actual tools return useful results. this five-field capability
probe does not qualify metadata's eight-field output or bibliographic judgments.
later kernel `96bc85af0fde10d4fc2d88573fc00c919dbaed27` changes base instructions
v2→v3. nexus's reviewed lock already contains pyjwt 2.15.1; the provider owner's
later lock/audit cleanup and final tuple remain unqualified.
nexus's final installed repeat is independent of jarvis domain progress content.

no final qualified adapter/provider/tools pin set is available. the earlier
research candidate above uses provider `23bd67420c9aaac78f5a6689d795b1eb02a1d5e9`,
kernel `ece3cda0c9898d2041cb74041b711d83b6361c74` and tools
`cad13af1289c247897236959bfff0d6791956d4b`. its frozen lock is an uncommitted
urllib3 2.8.0 variant; final cleanup, committed locks and consumer qualification
remain owner gates. stock 0.160 has no native hard context/output ceiling
field; 64,000/8,000 remain admission/reservation policy, not enforced token caps.
the user accepted that contract on 2026-10-02; the enforcement limit is explicit
in the plan and module documentation.
root adoption of `CodexCallbacks` / `MetadataResearch` and the combined
`0252` → native `0254` → metadata `0255` migration remain unqualified.
standalone `0253` receipts above remain historical. the valid owner-created
historical fixture is prepared: actual `0252` upgrades and both seeds pass on the two owned
`metadata_native_cutover_{success,blocked}` databases. each contains two tool
receipts/authorships, one reverted note, a closed original-principal credential,
and a separate open API parent with an authenticated continuation. captured
public-schema definitions and all baseline table columns match. executed source:
`.tmp/metadata_native_cutover_proof.py`, sha256
`1a0185b5301d8d90131909a1c7856f0d145f13dd5135f7f958e28a4175c4a384`;
receipt `.tmp/metadata-native-cutover-baseline-v4.log`. the target-head check is
RED on current `0253` before any database connection. archives and receipt were
sent to the kernel owner for its isolated candidate audit. that separate installed
candidate, `f13bb04bf9e801a1d75c6d79141132220c4405d1`, now passes the unchanged
owner verifier for both success and later metadata rejection. logs:
`/private/tmp/native-combined-migration.PNQFIS/{success,blocked}.migration.log`
and corresponding verifier logs. original states/dumps match. valid authenticated
continuation, original principals/effects/authorships and undo-once/repeat-false
are preserved; rejection rolls back captured definitions, all baseline columns,
credentials and version. root's final installed combined graph and domain
integration remain NOT_RUN. parent terminal or local stop never unlocks metadata
uncertainty.

the disposable `.tmp/metadata_native_recovery.py` is written and independently
reviewed for six actual-job controlled cases: unchanged/source/credits/access/
current-definition and submitted transport loss. source sha256
`54699491be4e761883ecc60913aaee3082290bbc6721bf4e3b82a6cec47a80fa`.
initial execution exits 1 at the legacy `NoModelTools` capability assertion before
database/settings/api/socket work; `.tmp/metadata-native-recovery-red.log`.
positive recovery remains NOT_RUN. parent-only/local-stop/authoritative
non-submission variants remain separate shared-owner proof obligations.

the existing 20-case `.tmp/metadata_e2e.py` now uses a controlled native websocket
peer, with no shell transport or fabricated terminal. source-only review approved
sha256 `baaa65580f3f16fd6c91ad69d8886c84974e22d89ee296acd3d0c727b103e955`.
all cases remain; setup cleanup and direct loopback clients were corrected.
new installed execution is NOT_RUN; the earlier shell GREEN remains historical.
use a separate process, rebuilt owned `metadata_proof_final` at sole `0255`,
qualified locked dependencies and explicit `METADATA_PROOF_SOURCE_SHA`.

genuine book/collection/essay research remains NOT_RUN. finite primary-source
fixtures identify *mere christianity* (1952), *of other worlds* (1966) and the
standalone *weight of glory* essay (1941), starting with deliberately wrong
original dates. verify the actual tool trace and preserve supported precision;
do not substitute a sermon, collection or current edition date. expected facts
come from the [author site](https://www.cslewis.com/mere-christianity-making-righteousness-readable/),
[wade bibliography](https://www.wheaton.edu/media/wade-center/files/authors/bibliographies/CSL-Bibliography20240219.pdf)
and [journal publisher](https://journals.sagepub.com/doi/10.1177/0040571X4104325702).

the disposable `.tmp/metadata_live_research.py` driver is prepared and independently
reviewed, unexecuted; sha256
`19d722ba4729c14cf138a7472adcbe67bba8d751050186cb7f5248104273f3be`.
it uses identification excerpts and the actual api/worker; source ingestion is
separately verified. the book includes a synthetic untrusted instruction,
checking correct publication and original external arguments without a fourth
model run. actual wire selection/callbacks and supported
date precision still require trace inspection, not inference from frozen fields.
tool use remains model-directed: require useful web search/read across the cohort,
with exact four-tool capability qualified in the shared owner's separate receipt.

production uncertainty/catalog dispositions, release backup/quiescence and
guarded saved-epub repair are still pending. follow the
[integration ticket](tickets/metadata-native-kernel-integration.md) and
[implementation contract](metadata-enrichment-plan.md). delete disposable proofs
only after full final green, then rerun `./scripts/test`. static checks and
receipts will not replace the removed regression coverage.
