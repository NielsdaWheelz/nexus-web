# note passage activation drops valid note locators

problem: a note-owned indexed chunk resolves to its containing note but its title
activation reports quoted location unavailable, despite a valid note locator.
its resource menu still offers the canonical note commands.

evidence at baseline `daf605a8d`: `resource_items/items.py:441` hydrates through
`media_passages`; `resource_items/locations.py:719-721` excludes non-media owners;
`resource_items/routing.py:142-146` removes canonical passage routes absent from
that map. paths are under `python/nexus/services/`. live disposable qualification
confirmed current_passages and current_locator resolve note offsets while the real
resource response returns activation.kind=none. unique source text does not fix it.

reproduce: index a note, enter a later content_chunk ref in the nexus launcher,
and compare its unavailable title with its functioning note-edit overflow action.
repair the passage hydration/routing owner to retain authorized note locations
and use the note reader's supported route. do not merely force a media route.
resolved when a genuine note passage opens the correct note/location and media
passage behavior remains correct. navigation repair is outside the overflow-label
specification; no runtime or fixture workaround is part of that implementation.
