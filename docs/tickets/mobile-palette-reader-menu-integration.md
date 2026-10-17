# compose the palette onto the canonical reader cutover

status: open
origin: 2026-10-16 mobile palette / principal-actions coordination
area: integration / reader menus

this isolated branch starts at `4d5970de7`. its unchanged
`apps/web/src/app/(authenticated)/media/[id]/SelectionDock.tsx:186` still
passes `anchored` to `ResourceActionMenu`; `MediaPaneBody.tsx:68,458` uses it.
canonical main `eb55608643fd097bc289c42e439b61a09dee0525` has the passage
composer instead. principal-actions removed the unused shared anchored mode in
`30bf3ed6ef3d2c2530f610a944d1d4d473a7615b` (two shared menu files).

do: compose the mobile feature commits onto the canonical reader before the
new shared-menu deletion. preserve the passage composer; remove no replacement
reader behavior and introduce no compatibility or fabricated anchored host.

acceptance: no actual anchored-menu caller remains, the static gate passes,
and current passage-composer highlight saving still works. this mobile branch
has not consumed the forthcoming shared-menu deletion.
