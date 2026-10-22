# native progress fence can discard unconfirmed samples

problem: native fence completion does not prove the queued listening sample was
acknowledged or authoritatively superseded.

evidence: `apps/android/app/src/main/java/app/nexus/android/playback/ListeningRecorder.kt:154-164`
joins the current sender, removes every queued item for the episode, then returns
the result of persisting the shortened lane. an earlier send failure can leave
unconfirmed progress in that lane. this is source review, not handset qualification.

impact: a subsequent consumption command can erase locally recoverable listening
progress. the podcast collection change repairs browser/reader owners only.

resolved when: a real handset failed-save/fence journey refuses the state command,
retains the exact pending progress and recovery, and later saves successfully;
fulfilled fence preparation proves acknowledgment or authoritative supersession.
