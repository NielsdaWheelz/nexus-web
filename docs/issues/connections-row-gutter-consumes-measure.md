# connections row chrome consumes the text measure

status: open; arithmetic from source, not rendered.

in the default 360px companion, list padding (24px), the two left controls (52px)
and the right actions column (26px) leave 258px for text: 28% goes to chrome. on a
390px coarse-pointer phone the controls grow to 44px: 162px, or 42%, leaving 228px.
see `.outline`, `.control` and `.actions` in
`apps/web/src/components/resources/ResourceOutline.module.css`, and `.list` in
`apps/web/src/app/(authenticated)/media/[id]/evidence/EvidencePane.module.css`.

the left disclosure slot is reserved even when a row has no children
(`ResourceOutlineRow.tsx:385`).

proposal: reader rows move disclosure into the right column, stacked under the
action menu. `.actions` already wraps, and a single-control column means late child
availability does not reflow text. desktop follow measures row heights, so reflow
would move aligned rows.

resolved when reader rows reserve no empty disclosure slot and late child
availability does not change text wrapping.
