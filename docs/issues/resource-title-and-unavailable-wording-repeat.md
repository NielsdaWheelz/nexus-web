# a resource's title and its "unavailable" are each worded in several places

found 2026-11-14 during the headword survey, read at `8a16a039a`. explicitly
deferred from that cut, which shared the row's type and paint, not this logic.

## the problem

two facts about one resource item are each derived by hand in several
renderers, and the copies have drifted.

**what a row is titled.** three switches over `preview.body.kind`:

- `apps/web/src/lib/nexus/rowText.ts:7-23` (`rowPrimaryText`, the palette).
- `apps/web/src/components/resources/ResourceIndexRow.tsx:85-105` (the search
  pane's row).
- `apps/web/src/components/resources/ResourceBody.tsx:82` (`ResourceIndexBody`).

they agree on media, named and images, and differ on passages: the palette
titles a passage by its work and a highlight by its quoted literal; the index
row titles both by the source when it has a title.

**why a row cannot open.** four wordings of `activation.unavailable_reason`
and `missing`:

- `apps/web/src/lib/nexus/rows.ts:111,155`: `quoted location unavailable`, else
  `source unavailable`. it never says `resource unavailable`.
- `apps/web/src/components/resources/ResourceIndexRow.tsx:123,131-132`:
  `resource unavailable`, `quoted location unavailable`, `source unavailable`,
  `can’t open here`.
- `apps/web/src/components/resources/ResourceLink.tsx:22-24`: the first three,
  with `resource unavailable` for a missing href.
- `apps/web/src/components/resources/ResourceOutlineRow.tsx:171-172`: two of
  them, and `unavailable resource` at `:211`.

## impact

the same item reads differently by surface: a missing resource is
`source unavailable` in the palette and `resource unavailable` in search. each
new surface adds another copy.

## proposed fix

one function for each fact beside the item (`lib/resources/`), returning the
words; every renderer calls it. where a surface means something different on
purpose (the palette titling a passage by its work), that is a named argument,
not a second switch.

## resolved when

each fact has one derivation, the four renderers call it, and a missing
resource reads the same in the palette, search and a note's reference.
