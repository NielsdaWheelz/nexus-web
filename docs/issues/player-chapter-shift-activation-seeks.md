# shifted chapter activation still seeks the current player

problem: the shift-open working specification promises shifted named chapters
open a timed reader destination without seeking. player chapter buttons always
seek, including shift-click.

evidence at `5ead65981`: `apps/web/src/components/player/PlayerPlaybackControls.tsx:151-160`
renders buttons whose sole handler calls `commands.seekTo(chapter.start_ms)`;
`docs/shift-open-spec.md:21-22` states the other behavior. source identity links
already conform and should not be rewritten to fix this separate gap.

resolution: settle this chapter contract during the existing shift-open work;
if retained, use the canonical timed target and shared activation adapter for
shift, preserving ordinary chapter seek. do not apply navigation modifiers to
transport buttons or the scrubber.

resolved when shifted chapter mouse/keyboard activation opens the correct timed
pane without moving playback, while ordinary activation still seeks.
