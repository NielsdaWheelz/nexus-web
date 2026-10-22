# reference suggestions swallow modified arrow navigation

`apps/web/src/components/notes/NoteEditor.tsx:662` prevents the default for
ArrowUp/ArrowDown while reference intent exists, then moves the menu only for
unmodified arrows. `ReferenceRowEditor.tsx:256` has the same ordering. modified
arrows neither navigate the text nor move the menu, blocking native selection
and document navigation such as mac meta-down. source review during writing's
main integration; no live reproduction of this independent defect.

preserve plain-arrow suggestion movement and enter semantics; allow modified
arrows through the editor's normal path. resolved when a real reference composer
preserves native modified-arrow selection/navigation and plain-arrow suggestions.
