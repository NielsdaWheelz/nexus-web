# a downloaded episode's rest at the end does not survive a service restart

problem: the native service holds a rest (a paused seek to the end) in memory, in
`restsAtEnd`. its checkpoint stores only the position, so after the process dies a downloaded
episode is restored paused at its end as an ordinary pause. the next play resumes in place,
plays the last microsecond and ends naturally: the terminal settles and the queue moves on,
where the rest would have replayed the episode from the start.

evidence: `apps/android/app/src/main/java/app/nexus/android/playback/NexusPlaybackService.kt`
`restsAtEnd` (:120) is set only by `seek` (:598). `restoreCheckpoint` (:1120) restores only a
leased (downloaded) episode, at the checkpoint's position. `resume` (:668) plays a leased episode
in place unless `atEnd()`. a streamed episode is unaffected: its resume rereads the descriptor,
which reads 0 for a finished episode, and reinstalls there. found by reading, not run.

impact: narrow. it needs a downloaded episode, a paused seek to its end, and process death
before the next play. the episode is already finished, so the visible effect is the next
episode starting instead of a replay. it was accepted in exchange for not reading a rest from
position, which misread every pause past an estimated mp3 duration as the end.

proves it resolved: on the emulator, download the long episode, pause, seek to the end, force
stop the app, reopen it and press play: the long episode replays from the start, no
`natural-end` request is heard, and the cursor stays.
