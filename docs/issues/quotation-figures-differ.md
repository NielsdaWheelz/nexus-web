# two drawings of one quoted passage

status: open · found 2026-11-12 during specification; rechecked at `09c14e68f` · area: web / resources, librarian

`components/resources/ResourceQuotation.tsx:79-81` draws captured evidence (citation
hovers, `ExcerptDisclosure`): the full excerpt with context, no highlight colour,
`title — authors · location`, no publication. `components/chat/ReferenceFigure.tsx:88-96`
draws live librarian references: selected words only, on their colour, type icon,
`title · bibliography`, then the annotation. they share `ReaderExcerpt`,
`ResourceMetadata` and `ResourceTypeIcon`, and nothing above them.

impact: the same highlight reads differently in a citation hover and in a message.
the contracts differ (captured against live), but the attribution line need not.

resolved when both figures paint attribution through one projection and one
separator convention, or the difference is recorded as intended in
`docs/modules/resource-references.md`.
