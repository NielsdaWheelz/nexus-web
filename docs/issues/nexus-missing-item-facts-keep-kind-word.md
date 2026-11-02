# a missing item's facts line still carries its kind word

status: open · origin: 2026-11-02 palette s1 · area: web / resource metadata

`resourceMetadata` emits an `identity` part (`book`, `page`, …) for items with
`missing: true` (`apps/web/src/lib/resources/metadata.ts:41`), and
`resourceMetadataText` joins it into the facts line `rowFacts` paints. the row
sheet bans kind words from every facts line ("the glyph is the kind") and names
this producer, but `lib/resources/metadata.ts` has no owner in the palette's
work split, so s1 left it.

impact: a row for a removed or inaccessible resource reads `book · source
unavailable` where `source unavailable` alone was specified.

fix: drop the `identity` part from `resourceMetadata` (its other consumer is the
resource pane header; verify before deleting) or filter it in `rowFacts`.

resolved when no palette facts line contains a kind word.
