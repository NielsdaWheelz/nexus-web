# repaired note markers lack inline activation

status: open
origin: 2026-09-26 reader chapter repair implementation
area: reader apparatus / historical epub repair

repair preserves stored `fragments.html_sanitized` bytes while deriving note items
from retained originals. older fragments can therefore lack the new
`data-reader-apparatus-item-id` attributes. `MediaPaneBody.tsx` selects those
attributes for inline hover and focus preview (around lines 421, 4850, 4887).
exact note locators and chapter classification still work, but newly derived
items have no inline marker affordance in the preserved html.

prerequisite: chapter repair's byte-preservation and apparatus contracts are
accepted. add a reader-owned locator-based inline activation path, or an
explicitly approved content-republication contract that preserves existing
reading coordinates and annotations. do not silently rewrite repaired html.

acceptance: a repaired legacy epub exposes a newly inferred note by pointer and
keyboard at its exact source marker while fragment bytes and saved offsets remain
unchanged, or an approved republication demonstrates equivalent preservation.
