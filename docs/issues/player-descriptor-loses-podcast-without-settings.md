# first podcast-default save needs final qualification

source corrected: `services/consumption/projection.py` selects `pe.podcast_id`
from the episode relation while the viewer settings join remains optional.
`usePlaybackSettings` can therefore read the missing-row baseline for a show's
first save. the old `ps.podcast_id` defect is absent from the merged source.

remaining acceptance: play a show with no settings row, remember its first
defaults through the ordinary player, and verify the saved pair. final merged
qualification must establish that write before this record is removed; a source
correction alone is not its recorded acceptance.
