# notes under 16px may zoom the page on ios when focused

recorded 2026-11-17 at ef44ba92d. a hazard opened by an owner ruling in the notes
redesign (the fair copy): notes follow the reader profile's size on touch too, and
the owner's profile will be 14px. not observed: no ios device or simulator was
run.

## problem

ios safari enlarges the page when focus enters an editable control whose text is
smaller than 16px. the authored outline is `contenteditable`. today touch rows are
fixed at 16px (`apps/web/src/components/notes/NoteEditor.module.css:146`), which
avoids it. afaict the same zoom applies to `contenteditable`; that is the part to
verify.

## impact

on an iphone or ipad, tapping into a note at a profile size under 16px could zoom
the viewport and leave it zoomed. android does not do this. the owner's handset is
android.

## evidence

- the owner's ruling, 2026-11-17: "profile everywhere" for touch size.
- reader profile sizes run 12 to 28 (`python/nexus/schemas/reader.py:109`).

## resolved when

an ios device shows no zoom at a 14px profile, or the touch size takes a 16px
floor, or the viewport forbids the zoom by an owner-approved means.
