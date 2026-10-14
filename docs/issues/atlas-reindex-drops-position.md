# a reindexing work drops out of the atlas frame

**problem**: the sweep reads only media whose `content_index_states.status = 'ready'`, and
deletes every position outside the frame it computed. a work that is mid-reindex when the
sweep runs loses its position and falls into the nebula until the next sweep.

**impact**: with the daily production period, a reindexed work sits on the rim for up to a
day. cosmetic; no data loss.

**evidence**: `python/nexus/services/atlas.py` `project_all` (the `cis.status = 'ready'`
join and the `DELETE ... <> ALL(:ids)`).

**resolved when**: a work reindexed across a sweep keeps a position. options: keep the last
position of a media whose index is not ready (two frames' coordinates mix until the next
sweep), or read the previous active embeddings during a reindex (needs the content index's
reindex semantics); idk which is right.
