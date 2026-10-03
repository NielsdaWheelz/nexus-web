# atlas etag ignores read-model changes

status: open · origin: 2026-10-02 cleanup discovery, baseline 56b889bdc6708d2d913982e22e7566a141b024d6 · area: atlas / http caching

`python/nexus/api/routes/atlas.py:46-48` hashes only the maximum atlas-position
`computed_at`, selected at lines 89-96. a matching `If-None-Match` returns 304
before reading constellations or edges. the response also includes media titles,
highlight counts (lines 68-72), library memberships/names (lines 115-127), and
resource edges (lines 157-175), none represented in the etag seed. `services/library_governance.py:379-388`
renames a library and advances only its `updated_at` plus library-list revision;
it does not recompute atlas positions. `services/atlas_projection.py:1` declares
the sole position writer, whose insert is at lines 219-227. the api checks no
other revision before returning 304.

impact: a title, highlight, membership, library name or edge change can leave a
client with a stale atlas even though the read model changed.

prerequisite: keep viewer scoping and the full atlas representation unchanged.
reproduce by fetching the atlas etag, changing a library name or highlight count
without recomputing positions, then fetching with that etag; the route returns 304.

fix: derive the etag from the actual response representation or an authoritative
revision covering every contributing owner; choose the smallest existing owner.

acceptance: each contributing read-model change yields a changed etag and 200;
an unchanged representation still yields 304 with its etag, including an empty
atlas. verify through the authenticated route.
