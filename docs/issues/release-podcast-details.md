# release podcast details

ship api, web, workers and the paired android apk together. migration `0305`
follows `0304`; use the existing ancestry, stopped-writer, verified-backup and
exact-head preflights. rehearse on the newest production backup before release;
disposable conversion qualification does not replace that rehearsal.

`0305` retains episode identities/aliases, listening state, placements, removal
markers and lectern rows. it drops automatic queue preferences/watermarks and
archive counters, adds paired settings version 1 and distinct rejection/job
ownership facts, re-admits old active/limited syncs, and restarts limited history
at its original cutoff with unresolved `E_PODCAST_HISTORY_INCOMPLETE`. complete
and failed observations, other history identities/cursors and retry timing stay.
unknown recent rejection observations remain null.

all retained archive jobs, including terminal records, convert to `backfill_id`
and `expected_step_no`; values/dedupe keys remain. invalid lifecycle, cursor or
payload data abort conversion with the owning id for live repair. do not run old
writers after conversion. deploy removal-preserving acquisition with the new
history workers; historical removals without markers cannot be inferred.
broader falsely-completed-history repair remains separately recorded.

wire 13 already covers breaking changes since deployed 12; check release state
before allocating another revision. no old wire/job readers survive. pair native
`window.nexusPlayer` with its web adapter; old apks require update.

browser silence processing remains a separate release dependency, explicitly
deferred by the owner on 2026-10-21. android silence-skipping qualification was
explicitly waived for this task. neither decision claims complete cross-platform
audio qualification. see [playback release](release-playback-settings.md).

resolved when backup rehearsal, coordinated deployment and the outstanding
processing dependency are completed. no deployment has been performed here.
