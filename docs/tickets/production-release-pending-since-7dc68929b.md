# production release pending since 7dc68929b

status: open · origin: 2026-09-28 cleanup campaign · area: release / production

## what is true

- production web and backend both serve `7dc68929b` (#377). on 2026-09-28, `/version` reported it and alembic was at `0241`.
- merging to main deploys nothing. `deploy/hetzner/deploy.sh <sha>` converges the backend (`release.py`: backup, migrate, start), then promotes and aliases the vercel build of the same sha. web and backend therefore release together.
- main carries migrations `0242`–`0252`. most are irreversible: their `downgrade()` raises. after the release, the verified pre-migration backup is the only copy of the dropped data. rollback means restoring the application and that backup together, losing every write made since the release.

| revision | what | reversible | preflight |
|---|---|---|---|
| 0242 | reader publication source issues | no | |
| 0243 | reader section semantics | no | [reader-chapter-production-correspondence-unverified](reader-chapter-production-correspondence-unverified.md) |
| 0244 | shared note links (stop writers, drain client journals) | yes | [notes-writing-legacy-draft-checkpoint](notes-writing-legacy-draft-checkpoint.md), [notes-writing-target-unsafe-links-census](notes-writing-target-unsafe-links-census.md), [notes-writing-target-missing-body-versions](notes-writing-target-missing-body-versions.md) |
| 0245 | reader source note bodies | no | [reader-source-body-production-publication-preflight](reader-source-body-production-publication-preflight.md), [reader-source-notes-production-repair-pending](reader-source-notes-production-repair-pending.md) |
| 0246 | deletes retired chat and generation history | no | |
| 0247 | generation api credential binding | yes | |
| 0248 | drops the rate limiter and stream-token replay tables (#405) | no | none; both tables are ephemeral |
| 0249 | resource grant row shape (#409) | no | [resource-grants-0249-production-preflight](resource-grants-0249-production-preflight.md) |
| 0250 | dossiers keep only the current revision (#411) | no | [dossier-latest-revision-0250-production-preflight](dossier-latest-revision-0250-production-preflight.md) |
| 0251 | drops one table and 39 write-only or never-written columns (#413) | no | none; the dropped values are never read |
| 0252 | deletes billing, stripe state and the transcription minute ledger (#404) | no | [billing-0252-release-steps](billing-0252-release-steps.md) |

## what to do

1. run every linked preflight read-only against production, and resolve each one before releasing.
2. confirm the release backup verifies. it is the only copy of what 0242–0252 delete.
3. run `deploy/hetzner/deploy.sh <main sha>` from a clean checkout.
4. after the release, run the three processing repairs and then land #387 ([processing-repairs-await-release-then-387](processing-repairs-await-release-then-387.md)), and finish [billing-0252-release-steps](billing-0252-release-steps.md). three web compatibility
   arms ([web-rate-limit-copy-outlives-limiter](web-rate-limit-copy-outlives-limiter.md),
   [web-make-current-arm-outlives-revision-history](web-make-current-arm-outlives-revision-history.md),
   [web-failed-quota-transcript-state-outlives-0252](web-failed-quota-transcript-state-outlives-0252.md))
   need no release: they can go at any time, because web and backend release together.
5. open tabs still running the old web may fail dossier and chat reads and transcript requests until reloaded. there is nothing to do beyond reloading.

## done when

production `/version` and alembic report the released sha and its head, every preflight above is closed, and the follow-up tickets in step 4 are resolved.
