# highlight lists load anchors one highlight at a time

status: open · origin: 2026-10-20 db substrate re-slice (spec L3) · area: reader python / highlights

`Highlight.fragment_anchor`, `.pdf_anchor` and `.pdf_quads` are lazy `select`
relationships (`python/nexus/db/models.py`, class `Highlight`). every list
builds each row's anchor through `_anchor_out`
(`python/nexus/services/highlights.py:309`), which reads `pdf_anchor` first,
even for a fragment highlight, then `fragment_anchor` or `pdf_quads`. the
lists call it per row (`:440`, `:742`), so a media's highlight list runs
1 + about 2N statements.

evidence: the db substrate harness (`ORM.highlight-list-statements`, campaign
artifacts `2026-10-20/db/harness`): `GET /media/{id}/document-map` sends 39
statements with one highlight and 55 with nine, 2.00 more per highlight, on
main `f2025d935` and on the re-slice alike.

impact: list latency grows with each highlight's two lazy loads; nothing is
wrong in the answer.

fix: load the anchors with the list query (a loader option such as
`selectinload` for the three, or one query per anchor kind keyed by highlight
id), in the reader python highlights slice. not a global `lazy=` change in the
mapping: every `select(Highlight)`, including locked write paths, would pay it.

resolved when: the statement count of a media's highlight list does not grow
per highlight (the harness journey passes).
