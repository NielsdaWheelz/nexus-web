# episode descriptors lose podcast identity when no defaults exist

problem: the descriptor query selects podcast identity from the optional viewer
settings row, so a podcast with no saved defaults yields `podcast_id: null`.

evidence: `python/nexus/services/consumption/projection.py:194` selects
`ps.podcast_id` despite joining authoritative `podcast_episodes pe`; the settings
join is optional. `apps/web/src/components/player/GlobalPlayerSurfaces.tsx`
uses descriptor podcast identity to admit the saved-defaults read, whose null key
disables that read. this is a source-level finding; no write journey qualifies it.

impact: playback settings cannot obtain the confirmed missing-row baseline needed
to save a podcast's first defaults through the player.

resolve by deriving podcast identity from the episode relationship while keeping
the settings row optional. qualify playback with no settings row, then remember
the first defaults through the ordinary player and verify the saved pair.
