# production release pending since 7dc68929b

status: open · origin: 2026-09-28 cleanup campaign · area: release / production

## what is true

- the last public web/backend version observation was `7dc68929b` (#377) on 2026-09-28. reviewed aggregate SQL on 2026-10-03 independently confirms production remains at `0241`; this did not re-probe public versions.
- merging to main deploys nothing. `deploy/hetzner/deploy.sh <sha>` converges the backend (`release.py`: backup, migrate, start), then promotes and aliases the vercel build of the same sha. web and backend therefore release together.
- main carries migrations `0242`–`0254`. most are irreversible: their `downgrade()` raises. after the release, the verified pre-migration backup is the only copy of the dropped data. rollback means restoring the application and that backup together, losing every write made since the release.

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
| 0253 | canonical activation receipt keys and explicit oracle passage nullable keys | yes; added null keys remain | precise stored receipt/passage shape guards |
| 0254 | drops the unused atlas position recomputation timestamp | no | none; no product or scheduler reads the age |

the activation cut adds the `0253` receipt-key and oracle nullable-key
migration, with paired snake API/web output. production has 24 exact camel
activation paths in 22 targeted receipts at `0241`. only chat
`citation_index`/`context_ref_added` and oracle `passage` populations were counted
and empty; plate/bind were not queried. source base `e92d6c6d9`, query sha256
`65de77483069113f23ce5e66db644cd03c18e8c01fdf0c1cca4d6af7203800ca`,
safe receipt `/tmp/nexus-resource-activation-production-preflight.receipt.json`.
migration shape guards still run with writers stopped. merging/checks/preview publication do not establish a
matched live application; release the same API/web sha only after migration and
backend health, through the existing controller. no promotion is requested by
this cleanup slice.

the separate plate/bind read-only census at `0241`, 2026-10-03 11:11:24–27 utc,
found zero rows for each type (`/tmp/nexus-oracle-nullable-production-preflight.receipt.json`,
query sha256 `0054460ae3ea9f39fe8ef40377caa21c34b59114a3d1afb7010fa2ed1fcdc691`).
the required-nullable year/gloss source cut deliberately rejects raw stored
omissions previously defaulted to null. bounded initial/current and previously
observed deployed writer history includes both members; no omission-producing
writer was found. this is not proof about unavailable historical backups.
no migration or new revision is added for that contract change.

the atlas cut adds `0254`: old atlas query/writer code requires the removed
column. stop writers, verify the existing backup, migrate and restart the same
application sha through the existing paired release controller. unused timestamps
are deliberately lost; migration downgrade refuses. this is locally qualified,
not an applied production migration.

## what to do

1. run every linked preflight read-only against production, and resolve each one before releasing.
2. confirm the release backup verifies. it is the only copy of what 0242–0252 and 0254 delete.
3. run `deploy/hetzner/deploy.sh <main sha>` from a clean checkout.
4. after the release, run the three processing repairs and then land #387 ([processing-repairs-await-release-then-387](processing-repairs-await-release-then-387.md)), and finish [billing-0252-release-steps](billing-0252-release-steps.md). the remaining
   [web rate-limit copy cleanup](web-rate-limit-copy-outlives-limiter.md) can land
   before release because web and backend release together; the make-current and
   failed-quota source arms are already removed.
5. open tabs still running the old web may fail dossier and chat reads and transcript requests until reloaded. there is nothing to do beyond reloading.

## done when

production `/version` and alembic report the released sha and its head, every preflight above is closed, and the follow-up tickets in step 4 are resolved.
