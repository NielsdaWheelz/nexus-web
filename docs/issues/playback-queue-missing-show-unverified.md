# queue rows without a show have no qualified live fixture

problem: lane 7's nullable-show row is reviewed in source but has not been reached through an admitted queue in a live browser.

impact: the empty metadata slot and episode-title artwork initials lack a rendered qualification for summary.show = null. this is a verification limit, not an established product defect.

evidence: baseline bafa5f980, python/nexus/services/playback_snapshot.py:72–79 joins podcast_episodes and podcasts in playable_episodes; playback_sessions.py:142–143 rejects a new queue containing a detached episode with E_MEDIA_NOT_FOUND. the lane's first queue fixture also used an artwork-failure episode without a playable url and failed before the product surface. the long-window proof uses only admitted episodes.

resolved when: a real admitted state produces a queued summary with show = null and the live queue shows no secondary text, episode-title initials, and unchanged row geometry. do not bypass queue admission or add a product seam to force the state.
