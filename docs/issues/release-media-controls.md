# media controls spoken accessibility qualification

problem: spoken output for the shared icon commands and pending-playback state
has not been checked with a real screen reader.

impact: browser names, keyboard behavior and live-region content can be verified
without proving what voiceover or talkback actually speaks.

evidence: `components/media/MediaActions.tsx` exposes command names and disabled
reasons; `components/player/GlobalPlayerSurfaces.tsx` owns playback announcements
(both under `apps/web/src`). these are changed speech boundaries.

resolved when: a real voiceover or talkback pass traverses row/header commands,
checks disabled reasons, cancels a pending start, confirms honest playback/error
announcements, and returns from the libraries picker and a removed lectern row.
record the observed result in the release pr; do not substitute a browser tree.
