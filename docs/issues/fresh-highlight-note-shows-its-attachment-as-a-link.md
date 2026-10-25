# a fresh highlight note shows its attachment as a link

both outline owners hide a highlight note's attachment edge only by the
document map's annotation seed: `ResourceOutlineRow.tsx:386` suppresses
`item.preview.annotation.attachment_edge_id`, and `AnnotationNoteHost.tsx:272`
suppresses `fullSeed.attachment_edge_id`. a note attached since the last map
read has no seed yet, so until the refresh lands the attachment renders as an
ordinary link in both directions: the highlight's linked resources list the
note (a read-only `edit note: <note text>` row), and the note's `annotation
items` list the highlight itself (a full occurrence keyed
`<highlight occurrence>/annotation/note_block:<n>/<link>`, with its own
`more actions for <highlight label>` trigger). the host already knows the link
id it attached with (`draft.attachment.linkId`, `AnnotationNoteHost.tsx:69-74`);
the row does not.

reproduction (lab traces, 2026-10-25): an epub with a highlight linked from its
source by a user link, in the connections pane; `add note` on it and type
without saving, then toggle filters or switch all ↔ follow. "loading linked
resources…" appears, then for roughly 200ms the duplicate rows, then they go.
timing-dependent: two of four runs of the same steps caught it. afaict
pre-existing; the reader view menu cut changes neither file.

impact: a flash of duplicated rows under an open note. a press on the flashed
trigger is lost without notice (its owner unmounts while the menu prepares),
and any lookup by "the note editor in this row" sees two.

resolved when neither the highlight's linked resources nor its note's
annotation items ever mount the attachment edge between a note's first save and
the next document-map refresh, observed by a mutation recorder across that
window.
