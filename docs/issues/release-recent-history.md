# recent history cutover

release pending; contract: [recent resources](../modules/recent-history.md).

the cut replaces server palette-selection recency with device-local resource
history and adds native history operations/background playback capture. initial
local history is empty. do not seed it from `nexus_usages`, import another device,
change authored storage format, or erase workspace/authored data.

release requirements:

- pair web and apk changes; older native bridges cannot execute new operations.
  reload existing web documents and install the paired apk through the existing
  release protocol; no old-shell web persistence fallback.
- replace `GET /me/nexus-history` with `GET /me/nexus-ranking`; remove selection
  label/source fields and return 204 from `POST /me/nexus-selections`.
  current wire revision 17 already contains the first break since released
  revision 16; this cut rides that bump. coordinate the backend/web refusal
  window with existing operator quiescence and reload steps.
- migration 0326 follows 0325 and removes unused history/provenance columns
  and indexes while preserving all query-ranking rows and values. keep the
  normal stopped-writer, backup, ancestry and exact-head release safeguards.
- rollback cannot revert code alone after dropping columns. fix forward or use
  the existing coordinated database/api/web/apk restore procedure under stopped
  writers; account for writes since the backup before restoring it.
- qualify browser process restart, offline reopening, concurrent same-profile
  windows, same-account sign-out/sign-in, native notification playback with the
  webview suspended, and offline-shelf openings on the paired build.

evidence: migration `0326_nexus_ranking.py` removes four columns and two indexes;
`services/nexus_ranking.py` retains selection statistics. `AppBridge.kt` adds
four recent operations, and `NexusPlaybackService.kt` records native use.
the authored shared worker and startup payload format do not change.

resolved when the paired cutover and actual qualification are recorded in the
release/pr, ranking data survives migration, stale clients refuse explicitly,
and independent local histories survive restart without leaking retired accounts.
compare every retained ranking field against a populated pre-migration snapshot;
time-decaying score equality is not the preservation criterion.
