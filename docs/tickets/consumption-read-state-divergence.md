# Consumption read state: the Python and SQL ladders disagree for a podcast episode with no audio

## Problem

The read-state ladder (override → podcast listening → reader engagement →
Unread) exists twice, and the two differ in when they enter the audio arm:

- Python (`services/consumption/projection.py::_project`) takes the audio arm
  when the row resolves to a playable stream — `_stream_source(row) is not None`,
  i.e. `derive_playback_source` yields a `stream_url`.
- SQL (`projection.py::_read_state_case_sql`, used by `engagement_fact_rows_sql`
  and `episode_state_case_sql`) takes it when `m.kind = 'podcast_episode'`,
  whatever the playback source is.

So a podcast episode whose feed carries no usable audio URL is projected from
its reader-engagement row in a Lectern item and from its (absent) listening row
in every listing. In practice both say Unread, because such an episode has
neither a listening row nor reader engagement; the divergence only becomes
visible if one ever acquires one (a transcript read, say).

## Impact

Low today, latent. A Lectern item and the library row for the same media could
show different states — exactly the inconsistency the "one read-state
derivation" invariant exists to prevent.

## Evidence

`python/nexus/services/consumption/projection.py`: `_project` branches on
`sources[row.media_id] is None`; `_read_state_case_sql(media_kind="m.kind")`
branches on the stored kind. Carried forward from `_projection.py:301-367`
(Python) versus `:428-453` / `:762-777` (SQL) before the 2026-09 reauthoring,
which unified the two SQL ladders but left this one difference standing.

## What proves it resolved

One derivation drives both: either the SQL learns the playable-source test (it
would need the playback columns inside the relation), or the Python drops it
and branches on kind. Then a podcast episode with no audio and a
reader-engagement row reports the same state in the Lectern and in the library
listing.
