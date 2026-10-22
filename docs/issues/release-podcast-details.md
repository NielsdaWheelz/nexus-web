# release podcast details

production api, web and workers shipped `99320b630` on 2026-10-22, schema 0306
and wire 13. the complete migration chain passed on the fresh stopped-writer
backup restore and in production. the paired `android-v0.3.5` is published and
installed; its existing session, scoped app links, empty offline shelf and
reconnect passed. episode playback was `NOT_RUN`.

`0306` retains episode identities/aliases, listening state, placements, removal
markers and lectern rows. it drops automatic queue preferences/watermarks and
archive counters, preserves paired settings versions, adds rejection/job ownership
facts, re-admits old active/limited syncs, and restarts limited history
at its original cutoff with unresolved `E_PODCAST_HISTORY_INCOMPLETE`. complete
and failed observations, other history identities/cursors and retry timing stay.
unknown recent rejection observations remain null.

all retained archive jobs, including terminal records, convert to `backfill_id`
and `expected_step_no`; values/dedupe keys remain. invalid lifecycle, cursor or
payload data abort conversion with the owning id for live repair. the deployed
history workers use removal-preserving acquisition; historical removals without
markers cannot be inferred.
broader falsely-completed-history repair remains separately recorded.

wire 13 and native `window.nexusPlayer` are paired in the deployed web and apk.
no old wire/job readers survive; old apks require update.

the owner accepted android-only silence skipping on 2026-10-21; browser silence
processing is not a release dependency. android silence-skipping qualification
was explicitly waived for this task. that waiver supplies no acoustic proof.
remaining installed episode playback and settings acceptance belongs to the
[playback release](release-playback-settings.md).

backup rehearsal and coordinated deployment are complete. delete this record
when the remaining scoped playback acceptance is complete; basic shell checks
do not establish it.
