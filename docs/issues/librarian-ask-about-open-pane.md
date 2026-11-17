# librarian: a question asked from the palette does not carry the pane it was asked from

found 2026-11-15 while designing the thumb index. read at `42618db32`.

## problem

`ask` in the palette opens `/librarian` with a `ComposeChat` entry holding the
typed words and nothing else (`apps/web/src/lib/nexus/query.ts:42-49`). a
question asked while reading a book arrives with no reference to the book. on a
phone, where one pane shows at a time, the reader then has to name the work in
the question or attach it by hand.

## impact

the field study for the thumb index found that phone ai in reading apps is tied
to the open document (readwise reader's mobile chat uses the reading position
as its context; its library-wide ask is not on the phone:
https://readwise.io/reader/update-aug2026). a context-free ask is the weaker
half of the job the phone's `ask` key is for.

## proposed

when `ask` is run from a pane that holds a resource, the question carries that
resource as its stated subject: visible in the librarian's composer before or
as it sends, and removable. it is the librarian's change, not the palette's;
the palette only passes the pane's resource ref with the words.

related, already on record: `attachable-capability-has-no-reader.md`,
`passage-attachment-prompt-has-no-source.md`, `mobile-ask-librarian-new-pane.md`.

## resolved when

a question asked from the palette over a reader pane reaches the librarian
with that work named as its subject, the reader can see and remove it, and a
question asked from a pane with no resource carries none.
