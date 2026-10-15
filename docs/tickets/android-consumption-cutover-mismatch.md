# android consumption cutover awaits native acceptance

status: implemented in merged #630; native/runtime and phone acceptance pending
origin: 2026-10-15 book coordinator release review, candidate `702ba2b826`
area: android playback / api consumption

the pre-fix candidate `ListeningRecorder.kt:290` sent `media_ref` to `/consumption/activity`;
the current closed activity schema requires `media_id`.
`NexusOriginClient.kt:161` posted to removed `/consumption/commands`.
that recorder sent `SettleNaturalEnd` and expected `next_item`; the current
owner is `POST /media/{id}/natural-end`, returning 204. these 400/404 refusals
were final to that recorder, so it discarded the affected queued writes.
its listening/settle lane was in memory, so restart also lost pending work.
merged #630 corrects the protocol and persists that lane atomically. final
native/backend reproduction and physical-phone acceptance remain NOT_RUN.

prerequisite: drain the old phone's pending positions, listening and activity
before the wire cutover. inspect actual downloaded copies; do not wipe storage
or infer that every old copy is incompatible.

implemented contract in [release-consume](../issues/release-consume.md)
through the current native client/recorder. use `media_id`; capture the next
eligible audio row from the current lectern before settling; advance only
after 204. retain queued work on 426 and transport failure. remove the retired
command/payload/result path, with no server compatibility branch. persist the
existing ordered listening/settle lane using the existing private atomic-file
pattern, scoped to its authenticated account; preserve payloads, fences and the
captured next row across retries and recorder reconstruction. a failed durable
write must not be reported as synced.

acceptance: temporary real-stack native proof shows activity persisted,
natural-end accepted and next-audio advancement, 409/404 without advancement,
and queued writes surviving 426/offline and recorder reconstruction, then
draining without a duplicate or lost settle. test failed durable writes too. fresh signed release apk
must pass physical listening/sync and retained-copy progress checks before
cutover acceptance. delete temporary probes after final verification.
