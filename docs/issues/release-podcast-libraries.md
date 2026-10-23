# podcast library cutover

migration `0310` follows `0309` and replaces show entries/personal follows with
physical episode entries and library rules. it preserves work and preferences;
incomplete history restarts with known episodes already processed. irreversible:
rollback requires the release backup. implementation baseline is `8124afc10`.

- stop api/worker writers and verify the backup. run the migration's conversion
  preflight. shared, system/default show entries and malformed legacy follows
  abort with identified rows; repair those data explicitly before retrying.
- deploy api, workers and web together. `0310` invalidates old runnable claims
  before dropping their owners. verify the exact migration head and that no old
  worker remains. there is no compatibility deployment order.
- ship paired wire `14` with the playback queue cutover. follow its
  [native drain and api/apk pairing prerequisites](release-playback-queue.md).
  the combined head is `0312_playback_sessions`, after `0311_chapter_end_provenance`.

delete after the actual coordinated release.
