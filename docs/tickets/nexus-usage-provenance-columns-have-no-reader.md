# nexus usage provenance columns have no reader

status: deferred (owner decision) · origin: 2026-09-28 nexus launcher rewrite (size/nexus-launcher-web), verified finding F7 · area: nexus history / schema

source review at `e92d6c6d`: stored `source` is only echoed by
`python/nexus/services/nexus_history.py:37–69`; `updated_at` has no reader. the sole web
consumer discards post count/time and recent source/time
(`apps/web/src/lib/nexus/useNexusFind.ts:104–111`, `rows.ts:462–470`). retain stored
count/visits/last-used time/id for ranking and history, and `created_at` under
`docs/rules/database.md:19`.

category retirement must preserve the current history-eligibility bit and its warming
policy (`apps/web/src/components/nexus/useNexusController.ts:268,376`); `Ask` and `Browse`
are deliberately excluded despite being internal routes. proposed `rememberable?: true`
expresses that existing concept.
if adopted, retire stored/request/history source, stored updated-at and unused wire
data; the existing `apiCommand204` contract suffices. preserve every replay id/hash/payload.
new empty-object memos require `is not None`
(`python/nexus/services/resource_mutation_replay.py:40–98`).
deleting memos would permit duplicate increments.

the request shape changes: old source-bearing bodies fail with 400 at extra-field
validation; new-shaped bodies reusing old ids mismatch with 409. historical same-id replay usability is
not preserved across this hard cut. `deploy/hetzner/deploy.sh:111–114` releases backend
before web promotion; `deploy/hetzner/release.py:636` stops api/workers, not old tabs/public web.
prerequisite: accept that refusal window with operator quiescence and post-promotion
reload, or defer. no atomic web/API cutover, compatibility path or resend is supplied.

proposal remains unadopted; migration/runtime/deployment checks not_run. acceptance:
owner decision, populated migration preserving creation/ranking/replay state, unchanged
eligible activation/history, exact retry/no duplicate and changed-body mismatch. retain
deployment ancestry/stopped-writer/backup gates. delete this ticket after an accepted
cut or an explicit decision to keep the current contract.
