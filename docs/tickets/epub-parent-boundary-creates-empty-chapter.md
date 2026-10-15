# a parent boundary turns an unknown chapter extent into an empty range

status: open; whole-book repair unsafe, not applied
origin: 2026-10-15 book-repair retained-source review, operator `150328b65`
area: epub semantic extents

media `a29b4729-d99b-4a97-afa1-f9f188beae3e` has four publisher chapters
whose ends are absent. the candidate gives each a present extent ending at
its own start: `5:0`, `12:0`, `19:0`, and `27:0`. their retained source
documents contain authored chapter headings and respectively 6,605, 19,349,
21,373, and 29,375 canonical characters. an unknown extent has become an
exact claim of empty chapter coverage.

the inherited publisher parents already ended before those chapters. title
coalescence moves each parent end to its first chapter's start.
`python/nexus/services/reader_structure.py:122` accepts a child target equal
to the parent end, clips the child to that point, and emits a present range
at line 129. `epub_read.py:128` exposes that range; it does not treat it as an
absent extent. separately bounded heading rows survive unchanged. stored
text, chapter destinations and those heading ranges remain intact; no api,
browser or device failure was executed.

private source facts: `c-sources/navigation-a29-zero-extent-facts-v1.json`,
sha256 `0f530894e373e5c31ef38bcc9ad56cadecba1986b940e7d03abdd91d8069eaa1`.
independent review: `a-maintenance/navigation-a29-empty-extent-independent-review.json`,
sha256 `d3827d588843e0115a344df25bdf9896b3f53f76810b1e732b938d05fe8bbf74`.
source sha256 `0c8a9f58901f84678a0edd2fb5002f8ab81f6a92b0b6414d2f0ba3206dc7e1f9`;
full proposal sha256 `407111b0a3e091d206d85887b37528de1db3b60bd8c56857003af3881cc9f43f`.
the receipts bind exact retained html/text and complete proposal bytes.
original navigation remains unacquired; other proposed changes are unadjudicated.

fix the range owner so unresolved parent coverage cannot certify an empty
nonempty chapter. establish the actual parent and chapter boundaries from
source authority, or retain an absent extent. do not invent an end or reparent
the chapter merely to satisfy clipping. this is separate from local-container
truncation and closing unrelated divisions by depth alone.

acceptance: all four real-source chapters avoid false empty extents; resolved
ranges follow proven source boundaries and unresolved ownership remains
explicit. qualify the equality-at-parent-end case and a legitimate bounded
child, then verify complete installed extents before applying this book.
