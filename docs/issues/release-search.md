# coordinated search rollout

status: coordinated rollout in preparation. preserve the qualified `2b85ecb3d`
base plus only the already-deployed `c5cf4bc27` pdf/android fixes, explicitly
approved by the owner after preflight. import no later main-only changes.
preserve the unchanged0306–0316 chain and apply search0317 once. the older functional checkpoint remains retained;
its warm percentile measurements are not relabeled as integrated measurements.

## before deployment

- recheck actual deployed source, schema ancestry and every writer. read-only
  preflight on2026-10-25 finds paired web/api/workers at `c5cf4bc27`/0316, with
  zero live jobs in its read snapshot. recheck immediately before stopping writers.
- let legitimate live media-reindex jobs finish through their existing owners.
  main0316 refuses them. never cancel, park or rewrite jobs to force migration.
  the actual0316 starting revision does not rerun0316 conversion. recheck with
  writers stopped rather than relying on an earlier snapshot.
- use the existing stopped-writer and verified-backup deployment owner. account for
  main0313/0314 intentional removals and0315/0316 transformations before comparing
  search0317 preservation. invalid input must refuse conversion.
- provision the immutable pg15 image with pinned pg_search0.26.2, preload and
  128mib shared memory BEFORE migration. the deployment command uses `--no-deps`;
  the release owner now pulls the database image before its disk gate and
  converges only postgres after the verified backup, before migration. prove
  actual image, pg15/preload/available0.26.2, unchanged live database identity and
  revision, and resource limits. obtain the pinned digest from the same
  first-attempt candidate bundle’s `postgres-image.txt`. first publication of
  `ghcr.io/nielsdawheelz/nexus-postgres` also needs its package visibility set
  public through github settings; the pipeline requires anonymous digest access
  and never installs registry credentials on production. preserve
  postgres512mib/no-swap,64mib shared buffers and api384mib/no-swap. verify actual
  binary/catalog versions and exact alembic head.
- ship paired api, workers, hosted web and generated wire. apply the wire bump
  rule against the actual released clients: production already has wire15, so
  the breaking search contract requires wire16. ship signed android code29/0.3.8
  and extension1.0.2 with the new wire; preserve existing signing identities.
  reload open clients after pending
  writes settle; preserve main's account and installed-client admission rules.
- use session connections for shared expensive-read admission through consumption
  and cleanup. transaction-pooling proxies and old workers violate this contract.
  retain stock asyncio and sdk preparation before readiness.
- complete the [endpoint/client cutover](release-desktop-lab.md). rollback restores
  the verified backup and paired binaries; there is no downgrade or mixed reader.

## accepted product limits

warm visible-result p95 budgets are direct500/keyword2000/related4000ms. cold
keyword3000/related4000ms has one accepted control, not a cold percentile.
related failure caps are api5000ms/browser-bff5750ms; publication-time related
paint has a5000ms bound. the longer failure allowance permits more waiting and
shared-admission occupancy; it does not improve retrieval speed.

normal english word boundaries and bm25 ordering replace the older lexical
ranking. direct navigation covers titles, names and aliases; body matches arrive
in later phases. broad semantic retrieval is approximate: qualify at least95%
of exact200 qualifying owners and every reference semantic first-page owner,
with changed passages and ordering inspected. source-backed pieces retain
source-owned identities/vectors, authorized reading contexts and bounded evidence.

restored-background related failure during publication is accepted only with
honest failure, preserved useful results and retry. this does not waive active
search failure. the5750ms client failure/retry behavior passes locally.
manual [screen-reader acceptance](search-screen-reader-acceptance.md) and
[unrestricted ordinary-worker qualification](restored-search-worker-backlog.md)
remain explicitly deferred. selected-runtime stability is accepted while the
[original native fault](search-api-segfault-on-launcher-workload.md) remains
unattributed. preserve the [historical unjoined abort](search-hybrid-publication-cutoff.md).

## current handoff

static checks, the three retained integration checks, populated0312→0316→0317
preservation and local piece/evidence boundaries pass on their recorded source.
the current immutable runtime completes fresh keyword/related responses during
publication, meets the5000ms related-paint bound, commits one audited replacement,
keeps unrelated edits durably responsive, finds the updated note and restores its
fixtures. a separate read-only browser check on those binaries verifies canonical
semantic fallback text and the matching passage link. local checks separately
cover canonical reader activation. the raw combined receipt remains failed on its
wrong nullable-highlight oracle; neither later proof relabels that receipt.

qualification plans and receipts stay in the private pr body. no new warm
percentile, unrestricted-worker capacity or historical causal claim follows.
the current static gate passes. the rollout-only postgres ordering proof and
three retained checks,
immutable candidate builds, frontend authentication/staging and paired client
activation are still pending. there is no production deployment yet. after
coordinated rollout, check independent
phases, interaction-held refresh, continuation, canonical evidence/activation,
mobile ime/announcements and lexical publication before embeddings. remove this
issue after rollout and its owner checks.
