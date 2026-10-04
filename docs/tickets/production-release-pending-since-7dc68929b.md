# production release pending since 7dc68929b

status: open · origin: 2026-09-28 cleanup campaign · area: release / production

2026-10-03: metadata root owns release preparation in
`feature/metadata-enrichment`. the reset/receipt repair is committed at
`617baf70e`; target head is `0256`. the fresh live `0241` archive was actually
restored, and the complete owner-populated starting-revision migration passed
its retained-data checks and seven refusal/rollback cases. authenticated account
inspection, real undo and stale-authority refusal also pass. no production drain,
disposition or deployment occurred.
the final drained backup and actual restore of those exact bytes remain required;
the preliminary live archive is not final release authority. see
[metadata verification](../metadata-enrichment-verification.md) and
[the operator sequence](../../deployment.md#reviewed-model-history-reset).

2026-10-04 composition: current main `8c9b7d332` already owns resource `0253`
and atlas `0254`. final suffix is native `0255` → metadata `0256` → effects
`0257`. mechanical metadata/effect renumbering is `9ac32aa7b`; exact merged-source
qualification is pending. the prior `617baf70e/0256` receipt stays historical;
no database is stamped or aliased into the reallocated graph.

## what is true

- production web and backend both serve `7dc68929b` (#377), reconfirmed by the 2026-10-03 read-only census at `0241`.
- merging to main deploys nothing. `deploy/hetzner/deploy.sh <sha>` converges the backend (`release.py`: backup, migrate, start), then promotes and aliases the vercel build of the same sha. web and backend therefore release together.
- the final release target carries migrations through `0257`. most older migrations are irreversible: their `downgrade()` raises. after release, the verified pre-migration backup is the only copy of dropped data. rollback restores the aligned application and that backup together, losing every write made since release.

| revision | what | reversible | preflight |
|---|---|---|---|
| 0242 | reader publication source issues | no | |
| 0243 | reader section semantics | no | [reader-chapter-production-correspondence-unverified](reader-chapter-production-correspondence-unverified.md) |
| 0244 | shared note links (stop writers, drain client journals) | yes | [notes-writing-legacy-draft-checkpoint](notes-writing-legacy-draft-checkpoint.md), [notes-writing-target-unsafe-links-census](notes-writing-target-unsafe-links-census.md), [notes-writing-target-missing-body-versions](notes-writing-target-missing-body-versions.md) |
| 0245 | reader source note bodies | no | [reader-source-body-production-publication-preflight](reader-source-body-production-publication-preflight.md), [reader-source-notes-production-repair-pending](reader-source-notes-production-repair-pending.md) |
| 0246 | reviewed archival retirement; independent completed-write receipts survive history deletion | no | [model-history-cutover-blocked-by-uncertain-work](model-history-cutover-blocked-by-uncertain-work.md) |
| 0247 | generation api credential binding | yes | |
| 0248 | drops the rate limiter and stream-token replay tables (#405) | no | none; both tables are ephemeral |
| 0249 | resource grant row shape (#409) | no | [resource-grants-0249-production-preflight](resource-grants-0249-production-preflight.md) |
| 0250 | dossiers keep only the current revision (#411) | no | [dossier-latest-revision-0250-production-preflight](dossier-latest-revision-0250-production-preflight.md) |
| 0251 | drops one table and 39 columns (#413); restored loss inventory recorded | no | [schema-0251-production-loss-preflight](schema-0251-production-loss-preflight.md) |
| 0252 | deletes billing, stripe state and the transcription minute ledger (#404) | no | [billing-0252-release-steps](billing-0252-release-steps.md) |
| 0253 | activation receipt keys; explicit Oracle passage nulls | yes | exact restored-copy rewrites/refusal in composed proof |
| 0254 | drops atlas computation timestamps | no | [atlas-0254-production-timestamp-loss](atlas-0254-production-timestamp-loss.md) |
| 0255 | qualified native adapter; original principal/history preservation, shell credentials removed | no | [metadata verification](../metadata-enrichment-verification.md) |
| 0256 | metadata hard cutover; unresolved journals block | no | [metadata plan](../metadata-enrichment-plan.md#9-hard-cutover-and-verification) |
| 0257 | independent completed-write receipts and archival audit | no | [metadata verification](../metadata-enrichment-verification.md#release-preparation) |

## what to do

1. run every linked preflight read-only against production, and resolve each one before releasing.
2. follow [the finite reset sequence](../../deployment.md#reviewed-model-history-reset): fresh drained census, source/revision-bound R2 backup and actual restore/qualification of those exact bytes; reviewed original IDs and migration losses.
3. after separate authorization, run `deploy/hetzner/deploy.sh <target sha> --model-cutover-snapshot <reviewed-json>` from a clean checkout. no clone fixture or preliminary live archive qualifies that input.
4. after the release, run the three processing repairs and then land #387 ([processing-repairs-await-release-then-387](processing-repairs-await-release-then-387.md)), and finish [billing-0252-release-steps](billing-0252-release-steps.md). three web compatibility
   arms ([web-rate-limit-copy-outlives-limiter](web-rate-limit-copy-outlives-limiter.md),
   [web-make-current-arm-outlives-revision-history](web-make-current-arm-outlives-revision-history.md),
   [web-failed-quota-transcript-state-outlives-0252](web-failed-quota-transcript-state-outlives-0252.md))
   need no release: they can go at any time, because web and backend release together.
5. open tabs still running the old web may fail dossier and chat reads and transcript requests until reloaded. there is nothing to do beyond reloading.

## done when

production `/version` and alembic report the released sha and its head, every preflight above is closed, and the follow-up tickets in step 4 are resolved.
