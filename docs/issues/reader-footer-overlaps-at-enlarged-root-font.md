# reader footer overlaps at enlarged root font

status: open

at 320px with `html { font-size: 32px }`, the held-position footer grows over
the reading text; its title, return action and details occupy several lines.
observed during reader-toolbar qualification in
`.nexus-local/lab/20261020-001828-7ddc7e9d8f43/artifacts/reader-320-root.png`.
this is browser root-font stress, not an observation of android system font scaling.

owners: `apps/web/src/lib/documentReader/DocumentReader.tsx:361-382` renders the
position feedback; `documentReader.module.css:50-67` and
`apps/web/src/components/feedback/Feedback.module.css:35-64` own its layout.
the chapter-toolbar change does not alter these owners.

resolved when: the held-position title and return/adoption controls remain
readable and operable at 320px and 200% text, with reading text reachable and
footer geometry accounted for. verify actual clipping/overlap and focus; do not
reduce the font or discard persistent return semantics.
