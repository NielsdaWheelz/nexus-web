# metadata enrichment verification

status: local metadata behavior GREEN; installed native integration NOT_READY;
metadata's genuine bibliographic cases NOT_RUN. observed 2026-10-02 on `feature/metadata-enrichment`, based on
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

the kernel owner now reports genuine source-overlay public `execute_generation`
using personal `gpt-6-luna`/`xhigh`, strict json and useful results from all four
actual tools. candidate actual-postgres SIGKILL/cold-reclaim recovery also passed
with original terminal/usage and zero catalog/provider calls. these are separate
proofs: genuine research and controlled recovery faults. neither establishes
final installed metadata acceptance; the recovery probe uses
`metadata_enrichment` / `native-proof`. metadata still needs its actual
`enrich_metadata` / `codex/metadata` recovery with frozen inputs and publication
fences after source, credits or access change.

no qualified immutable adapter/provider/tools pin set is available. the owner is
repairing and qualifying native delegation containment before frozen installation
and the final live repeat. stock 0.160 has no native hard context/output ceiling
field; 64,000/8,000 remain admission/reservation policy, not enforced token caps.
the user accepted that contract on 2026-10-02; the enforcement limit is explicit
in the plan and module documentation.
installed `CodexCallbacks` / `MetadataResearch` and the combined
`0252` → native `0254` → metadata `0255` migration remain unqualified.
standalone `0253` receipts above remain historical; combined proof must cover
historical effect/principal evidence and rollback of native changes when the
later metadata guard rejects. the candidate proves actual whole-transaction
rollback and raw byte preservation, but its synthetic terminal parent has an
invalid pending continuation. a separate owner-created historical fixture is
being prepared; no execution receipt exists yet. parent terminal or
local stop never unlocks metadata uncertainty.

genuine book/collection/essay research remains NOT_RUN. finite primary-source
fixtures identify *mere christianity* (1952), *of other worlds* (1966) and the
standalone *weight of glory* essay (1941), starting with deliberately wrong
original dates. verify the actual tool trace and preserve supported precision;
do not substitute a sermon, collection or current edition date. expected facts
come from the [author site](https://www.cslewis.com/mere-christianity-making-righteousness-readable/),
[wade bibliography](https://www.wheaton.edu/media/wade-center/files/authors/bibliographies/CSL-Bibliography20240219.pdf)
and [journal publisher](https://journals.sagepub.com/doi/10.1177/0040571X4104325702).

the disposable `.tmp/metadata_live_research.py` driver is prepared and reviewed,
unexecuted. it uses identification excerpts and the actual api/worker; source
ingestion is separately verified. actual wire selection/callbacks and supported
date precision still require trace inspection, not inference from frozen fields.

production uncertainty/catalog dispositions, release backup/quiescence and
guarded saved-epub repair are still pending. follow the
[integration ticket](tickets/metadata-native-kernel-integration.md) and
[implementation contract](metadata-enrichment-plan.md). delete disposable proofs
only after full final green, then rerun `./scripts/test`. static checks and
receipts will not replace the removed regression coverage.
