# videos need persistent player ownership

owner decision: videos belong in the persistent player and the same playback
queue as episodes. implementation is deferred; future playback design must
presume this capability rather than permanently treating videos as pane-only.

problem: video playback currently belongs to an embedded frame in a media pane.
it lacks the persistent player's session and queue transitions.

evidence: `python/nexus/services/consumption/projection.py:182-205` produces
descriptors only for podcast episodes; `consumption/lectern.py:55-61` gives
videos open-pane activation. `apps/web/src/app/(authenticated)/media/[id]/Transcript.tsx:240-244`
mounts `YouTubeEmbedFrame`; `apps/web/src/components/media/YouTubeEmbedFrame.tsx:23-64`
does not integrate observed playback state or completion with the global player.

resolved when supported video sources participate in the persistent player,
survive pane navigation, and obey the same explicit queue order, current-item
and completion contracts as episodes. define provider and platform capabilities
honestly, including foreground/background limits and failures; preserve the
media's identity across video, transcript and playback controls.
