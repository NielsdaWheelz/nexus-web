# editor parity lacks a complete behavior contract

the original target was roam-style editing with obsidian/apple notes presentation.
the bounded outliner contract now lives in
[outline interaction](../modules/notes.md#outline-interaction): one planner for
every arrangement over the topmost selection, range move, drag with the bullet
(reorder, reparent, alt to link under a second parent), return and deletion that
keep the visible order, cut, copy and paste by reference, zoom by the bullet with
its entering link excluded, return anchors, and fold that is never written. its row
geometry is in [action controls](../modules/visual-system.md#action-controls).

that contract still does not claim full roam or obsidian parity. its accepted
differences, deliberately out of scope, have no lasting record of their own:
cross-pane drag; selection or expand-all beyond one loaded window (needs a
recursive branch read in `node/authored` and both hosts); fold that follows the
account across devices; non-contiguous selection; branch paste by value; a zoom
mode or zoom chords (the bullet opens a pane instead); an in-document title;
`⌘K` inside the editor. the unverified parts of what was built are recorded
separately ([unproven journeys](outline-unproven-journeys.md) and the android
records).

resolve when the owner accepts the differences above as the editor's target, at
which point this record is deleted, or promotes any of them to its own record with
a behaviour and proof. passing storage and capacity gates alone cannot close it.
