# the row under the caret could be set as typescript

recorded 2026-11-17 at ef44ba92d. deferred by the owner from the notes redesign
(the fair copy); drawn in its prototype, artifact 3DdTrswurwCN6HoASwtiFT, lever
`hand: typed at the caret`.

## proposal

the item being written is set in the mono face, a step smaller, with emphasis
underlined as a typist would. when the caret leaves, the row is set fair again in
the reader's face.

## cost

- the row reflows a little when the caret enters and leaves, because the two
  faces differ in width. at 12.5px mono against a 16px serif the average line is
  close; individual lines are not.
- it needs a setting and an owner for it (device or reader profile).
- a whole-leaf mono face was also drawn and is not proposed: mono is not a value
  of the reader profile's `font_family` (`apps/web/src/lib/reader/typography.ts:5-8`).

## resolved when

the owner rules it in and it ships, or rules it out and this file is deleted.
