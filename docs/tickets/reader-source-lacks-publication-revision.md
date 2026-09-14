# hosted reader source does not bind reads to one publication

- status: open; source-level consistency gap
- origin: 2026-09-13 clean-sheet architecture council; checkout `7fa89b88c8342bca9edfb46a6d20053c49555fb2`
- area: reader source / publication consistency / caching

## evidence

`apps/web/src/lib/reader/ReaderDocumentSource.ts:14-60` exposes a descriptor
with media id, title, and kind, and separate fragment/navigation/section reads
without a selected publication revision. hosted methods at `:90-147` address
current media endpoints by media and section id. meanwhile
`python/nexus/services/reader_publication.py:231` atomically replaces a
publication and advances its generation.

an atomic write does not make several separately timed current-publication
reads one snapshot. the source interface cannot require navigation and content
to belong to the same selected generation. this is a contract gap and a
prerequisite for safe immutable-content caching; no mixed-generation browser
reproduction or causal connection to the production memory kills is claimed.

## prerequisites and fix

specify the supported lifetime and retention policy for an opened publication.
return its identity in the source descriptor and bind every content, structure,
and asset read to that identity. return explicit supersession/unavailability if
the selected revision cannot be served; never silently substitute current
content. distinguish publication generation from cursor compare-and-swap
revision. preserve pending work and existing native account/lease boundaries.

## acceptance

through `./scripts/test`, replace a publication between navigation and content
reads. the reader receives a coherent selected publication or an explicit
transition, never mixed units. prove revision-keyed cache reuse, old-resource
retention/removal behavior, and preservation of pending reader intent.
