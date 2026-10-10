# player cutover: release steps

status: open · origin: 2026-10-05 player re-author (branch `cleanup/player-reauthor`, migration 0263) · area: player release (web, api, android). the release has not run.

web, api and a signed apk change together: the listening write loses `expectedWriteRevision` and the heartbeat ids, the activity body loses `clientMutationId`, the consumption commands change (`Done`, `UndoFinish`, a fenced `SettleNaturalEnd` without origin), the descriptor is flat, and `window.nexusPlayer` (protocol 2 + contract sha) becomes `window.nexusPlayback` (#534 named it `nexusAudio`; #538 renamed it). old apks against the new server get 422 on heartbeats, receipts and activity posts and see "Update Nexus for Android" in the webview; the new code reads neither the old sqlite outbox, the old receipt prefs nor the `nexus-consumption-activity` IndexedDB.

steps, in order:

1. before deploying: in each browser the owner uses, open /stats and let the old activity health reach "Synced" (the IndexedDB outbox is orphaned at cutover); on the phone, let the old app drain its outbox online. pending rows not drained are lost.
2. build the signed apk from the release commit with a `nexusAndroidVersionCode` above the installed app's (keystore and signing unchanged).
3. `deploy/hetzner/deploy.sh`: it converges the backend (migration 0263 folds `is_completed` into `finished` overrides and drops `is_completed`, `write_revision`, `consumption_queue_items.source`) before promoting the frontend; `/version` now answers `{source_sha}` only and the deploy checks exactly that. between backend converge and frontend promote an open old tab's commands 422: do not listen during the deploy.
4. after the frontend promotes, clear the app's storage and install the signed apk, in the [offline cutover](offline-cutover-release-steps.md) order.
5. check: play an episode on desktop and on the phone; position resumes across them; a natural end advances on both; /stats records listening from each.

rollback: the release's pre-migration backup plus the previous web, api and apk. `alembic downgrade 0262` no longer applies: the release also crosses 0264 and later, whose downgrades raise.

acceptance: the release ran in this order, the five checks in step 5 were observed, and this ticket is deleted.
