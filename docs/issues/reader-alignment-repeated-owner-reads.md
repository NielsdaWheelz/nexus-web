# reader alignment repeats source-owner reads

status: open. origin: resource-reference implementation, 2026-10-16. area: reader map.

resource bodies are batched, but `python/nexus/services/reader_connections.py:75` resolves each
distinct local occurrence through `python/nexus/services/resource_items/evidence.py:resolve_source_target`.
that correctly shares the frozen-target contract but repeats attribution, publication
identity and source-text reads for occurrences sharing an owner.

an actual local database read with 25 connections to the proof epub issued 195 sql
statements and took 169 ms. the probe counted sqlalchemy statements around
`list_reader_connections`; it did not measure network latency or claim a capacity
limit. browser rows make no individual fetches. this is an amplification cost as
one source accumulates connections, not an observed incorrect target or timeout.

batch source-target resolution within one reader projection, reusing the existing
resolver's validation and frozen occurrence identities. do not create a second
coordinate resolver or cache coordinates across publications.

resolved when the same media's current and historical rows retain correct full
extents, unavailable states and publication checks while repeated owner reads no
longer grow with every occurrence. measure statement count on the same fixture.
