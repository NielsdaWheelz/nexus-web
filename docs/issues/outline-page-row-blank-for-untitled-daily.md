# untitled daily-page rows bypass the shared display title

two lab reports at `839bb918b` on 2026-11-16 concern the same title fallback;
photographs were not retained. a linked untitled daily page appeared as a bare
glyph, while its child's unlink menu named the parent by raw iso date.

`apps/web/src/lib/notes/outlineController.ts` projects a page as editable
`title_row`, using only its stored title (lines 1261, 1425). only the seed gets
a placeholder. `label()` also returns raw `local_date` for an empty loaded
title (line 2061); that feeds `parentLabel`, bullet/group accessible names and
`OutlineEditorRow.tsx`'s unlink label. `localResourceLabel` and the shared
`pageTitle` already provide the date-derived display title elsewhere.

impact: visible rows cannot be distinguished, and the menu/accessibility names
use a different title from the journal and lists.

reproduce by linking an untitled daily page, reading its row, then opening a
child's bullet menu. resolved when visible fallback, accessible names and unlink
label use the shared display title, while the authored title remains empty
until the user types. generated paint must not become stored title text.
