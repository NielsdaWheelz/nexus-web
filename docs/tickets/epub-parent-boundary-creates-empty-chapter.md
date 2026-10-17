# a parent boundary turns an unknown division extent into an empty range

status: open; two whole-book repairs unsafe, neither applied
origin: 2026-10-15 book-repair retained-source review, operator `150328b65`
area: epub semantic extents

media `a29b4729-d99b-4a97-afa1-f9f188beae3e` has four publisher chapters
whose ends are absent. the candidate gives each a present extent ending at
its own start: `5:0`, `12:0`, `19:0`, and `27:0`. their retained source
documents contain authored chapter headings and respectively 6,605, 19,349,
21,373, and 29,375 canonical characters. an unknown extent has become an
exact claim of empty chapter coverage.

the same path affects `749e5383-1883-4f9d-8f0c-9508fa9adcd9`: `Part I:
Slave`, `Part I: Bow`, and `The Story So Far...` acquire empty ranges at
`10:0`, `67:0`, and `129:0`. their retained source documents contain 145,
65, and 1,991 canonical characters, including their named headings and
content. each existing parent newly ends at that child's start. the proposed
range excludes even the division's own first heading; the ideal full parent
extent need not be known to reject that exact empty claim.

the inherited publisher parents already ended before those divisions. title
coalescence moves each parent end to its first division's start.
`python/nexus/services/reader_structure.py:122` accepts a child target equal
to the parent end, clips the child to that point, and emits a present range
at line 129. `epub_read.py:128` exposes that range; it does not treat it as an
absent extent. the separate heading ranges at the seven affected starts
remain present and unchanged; unrelated heading changes are unadjudicated.
stored text and division destinations remain intact; no api, browser or
device failure was executed.

private source facts: `c-sources/navigation-a29-zero-extent-facts-v1.json`,
sha256 `0f530894e373e5c31ef38bcc9ad56cadecba1986b940e7d03abdd91d8069eaa1`.
independent review: `a-maintenance/navigation-a29-empty-extent-independent-review.json`,
sha256 `d3827d588843e0115a344df25bdf9896b3f53f76810b1e732b938d05fe8bbf74`.
source sha256 `0c8a9f58901f84678a0edd2fb5002f8ab81f6a92b0b6414d2f0ba3206dc7e1f9`;
full proposal sha256 `407111b0a3e091d206d85887b37528de1db3b60bd8c56857003af3881cc9f43f`.
the receipts bind exact retained html/text and complete proposal bytes.
original navigation remains unacquired; other proposed changes are unadjudicated.

the second fixed source/full-proposal packet is
`a-maintenance/navigation749-empty-extent-review-v1.json`, sha256
`c0dd5fd7bc09513ddbbff49e1773cda1102427eee3f01fc6b2b7d8362c6f95a2`.
it binds all three raw fragments, complete before/after rows and exact parent
ends. independent review:
`c-sources/a749-empty-extents-independent-review.json`, sha256
`61925068623853e9f9271e955aebe84226b6771cda2fc861cea0d3c4d2f30395`.
no original navigation, apply or consumer claim is made.

fix the range owner so unresolved parent coverage cannot certify empty
coverage of a nonempty division. establish the actual parent and child
boundaries from source authority, or retain an absent extent. do not invent
an end or reparent the child merely to satisfy clipping. this is separate from local-container
truncation and closing unrelated divisions by depth alone.

acceptance: all four chapters and the three additional named divisions avoid
false empty extents; resolved ranges follow proven source boundaries and unresolved ownership remains
explicit. qualify the equality-at-parent-end case and a legitimate bounded
child, then verify complete installed extents before applying either book.
