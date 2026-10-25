# playback queue release

pending production delivery of the queue index; existing playback sessions and
native player data must survive this upgrade.

rehearse migration 0318 on the newest production backup before merge. it removes
only saved `state.source` after strict preflight. keep a verified backup; provenance removal
is irreversible without it. follow the once-between-releases wire revision rule
and pair api/web/apk delivery. no old/new bridge compatibility period.

inventory the installed native envelope format, pause/stop the old service and
retain a recovery copy before paired installation. convert through PlaybackStore's
atomic owner from format 1 to format 2 before final-shape validation; earlier formats
need explicit preflight repair. settle uncertain/submitted browser writes and stop
writers before migrating. preserve account binding, queue ids,
revision/order/cursor, pending listening/end writes, listening facts/sequences,
descriptors and checkpoint. malformed or unsupported data blocks the cutover for
repair. do not remove/reset the player file or require an empty lane instead of
preserving it. the running app accepts only the final envelope/bridge shape.

after paired production installation, check the owner’s existing device: retained
history and cursor, paused restart, available downloaded continuation and pending
listening/completion delivery after reconnect. do not substitute a clean install
for conversion of the installed account. shelf controls and video remain separate.
resolve after backup rehearsal, migration, paired delivery and this installed-device
check. local qualification evidence and authored/deleted lines belong in the pr.
